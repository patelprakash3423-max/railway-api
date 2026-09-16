import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {RailwayDatabase} from '../local-railway/database.js';
import {hardeningConfig} from '../config/hardening.js';
import {ProtectedJourneyService,guardedProvider,validateBookingDate} from '../api/services/protected-journey-service.js';
import {SearchProtection,clientIdentity} from '../api/search-protection.js';
import {createRouter} from '../api/router.js';
import {createHttpHandler} from '../api/server.js';
import {AvailabilitySession} from '../journey/availability/session.js';
import {installAvailabilityAbortTransport,inAvailabilityScope} from '../providers/railkit/availability-abort.js';
import type {AvailabilityRequest,AvailabilityResult} from '../domain/types/availability.js';
const now=Date.UTC(2026,8,18),input={from:'AAA',to:'CCC',date:'18-09-2026',classes:['3A'],mode:'STANDARD'};
const config=()=>({...hardeningConfig({}),rateMax:5,burst:1000,monthly:10000});
function setup(t:TestContext,rule?:(r:AvailabilityRequest)=>Promise<AvailabilityResult>,patch={}){
 const db=new RailwayDatabase(':memory:');t.after(()=>db.close());
 db.replace({stations:['AAA','CCC'].map(code=>({code,name:code})),trains:[{number:'30001',name:'Fixture',sourceCode:'AAA',destinationCode:'CCC',runningDaysRaw:'Daily',runningDays:['MON','TUE','WED','THU','FRI','SAT','SUN']}],stops:[{trainNumber:'30001',stationCode:'AAA',sequence:1,dayOffset:0,departureTime:'06:00',distanceKm:0},{trainNumber:'30001',stationCode:'CCC',sequence:2,dayOffset:0,arrivalTime:'12:00',distanceKm:600}],metadata:{source:'RAILPULL_NTES',importedAt:'2026-09-18T00:00:00Z',trainCount:1,stationCount:2,stopCount:2}});
 let calls=0;
 const service=new ProtectedJourneyService(db,{getAvailability:async r=>{calls++;return rule?rule(r):{request:r,provider:'railkit',providerState:'SUCCESS',days:[{date:r.journeyDate,state:'AVAILABLE'}]};}},{...config(),...patch},{},()=>now);
 const router=createRouter({search:async()=>{throw Error('legacy');}},{journeyV2:service,logger:()=>{}});
 const request=(clientId='a',body:unknown=input,signal?:AbortSignal)=>router({method:'POST',path:'/api/journeys/v2/search',contentType:'application/json',body:JSON.stringify(body),clientId,signal});
 return {service,router,request,calls:()=>calls};
}
test('five allowed searches, sixth 429 with zero additional provider calls; health unaffected',async t=>{
 const h=setup(t);for(let i=0;i<5;i++)assert.equal((await h.request()).status,200);
 assert.equal(h.calls(),5);assert.equal((await h.request()).status,429);assert.equal(h.calls(),5);
 assert.equal((await h.router({method:'GET',path:'/health'})).status,200);assert.equal(h.calls(),5);
});
test('per-client and global concurrency reject before provider and release after abort',async t=>{
 const h=setup(t,()=>new Promise(()=>{}),{global:2,searchTimeoutMs:5000});
 const a=new AbortController(),b=new AbortController();
 const one=h.request('a',input,a.signal),two=h.request('b',input,b.signal);
 await new Promise(r=>setImmediate(r));assert.equal(h.calls(),2);
 assert.equal((await h.request('a')).status,429);assert.equal((await h.request('c')).status,429);assert.equal(h.calls(),2);
 a.abort();b.abort();await Promise.all([one,two]);
});
test('monthly and burst admission reserve full search budget before expensive work',async t=>{
 for(const patch of [{monthly:29},{burst:29}]){const h=setup(t,undefined,patch);assert.equal((await h.request()).status,429);assert.equal(h.calls(),0);}
});
test('quota counts actual calls and releases unused reservations; process-local window expiry',()=>{
 let time=now;const guard=new SearchProtection({...config(),monthly:31,burst:31,rateMax:1,rateWindowMs:100},()=>time);
 const lease=guard.acquire('a',30);lease.consume();lease.release();assert.throws(()=>guard.acquire('a',30));
 time+=101;const b=guard.acquire('a',30);b.consume();b.release();assert.throws(()=>guard.acquire('b',30));
 time=Date.UTC(2026,9,1);guard.acquire('b',30).release();
});
test('proxy headers cannot create unbounded client identities',()=>{
 assert.equal(clientIdentity('1.2.3.4','forged-a'),clientIdentity('1.2.3.5','forged-b'));
 assert.equal(clientIdentity('1.2.3.4',undefined),'1.2.3.4');
});
for(const patch of [{date:'17-09-2026'},{date:'18-09-2099'},{mode:['STANDARD']}])test(`invalid booking request ${JSON.stringify(patch)} has zero provider calls`,async t=>{
 const h=setup(t);assert.equal((await h.request('a',{...input,...patch})).status,400);assert.equal(h.calls(),0);
});
test('booking horizon uses IST and accepts inclusive boundary',()=>{
 validateBookingDate('19-09-2026',1,Date.UTC(2026,8,18));
 assert.throws(()=>validateBookingDate('20-09-2026',1,Date.UTC(2026,8,18)));
 assert.throws(()=>validateBookingDate('18-09-2026',60,Date.UTC(2026,8,18,20)));
});
test('provider timeout is unknown inventory, never WAITLIST or UNAVAILABLE',async()=>{
 const provider=guardedProvider({getAvailability:()=>new Promise(()=>{})},new AbortController().signal,10,()=>{});
 const session=new AvailabilitySession(provider,1);
 const r=await session.get({trainNumber:'30001',fromStationCode:'AAA',toStationCode:'CCC',journeyDate:input.date,travelClass:'3A',quota:'GN'});
 assert.equal(r.status,'PROVIDER_ERROR');
});
test('search deadline returns structured 504 and no further calls',async t=>{
 const h=setup(t,()=>new Promise(()=>{}),{searchTimeoutMs:20,providerTimeoutMs:5000});const start=performance.now();
 const result=await h.request();assert.equal(result.status,504);assert.equal(JSON.parse(result.body).error.code,'SEARCH_TIMEOUT');assert.ok(performance.now()-start<1000);assert.equal(h.calls(),1);
 await new Promise(r=>setTimeout(r,30));assert.equal(h.calls(),1);
});
test('already aborted search starts zero provider calls',async t=>{const h=setup(t);const c=new AbortController();c.abort();await h.request('a',input,c.signal);assert.equal(h.calls(),0);});
test('HTTP disconnect reaches pending search and prevents more calls',async t=>{
 const h=setup(t,()=>new Promise(()=>{}));
 const request=Object.assign(new EventEmitter(),{method:'POST',url:'/api/journeys/v2/search',headers:{'content-type':'application/json'},socket:{remoteAddress:'127.0.0.1'},iterator:async function*(){yield Buffer.from(JSON.stringify(input));}});
 const response=Object.assign(new EventEmitter(),{writableFinished:false,writeHead:()=>{},end:()=>{}});
 const pending=createHttpHandler({search:async()=>{throw Error('legacy');}},{journeyV2:h.service,logger:()=>{}})(request as unknown as IncomingMessage,response as unknown as ServerResponse);
 await new Promise(r=>setImmediate(r));assert.equal(h.calls(),1);response.emit('close');await pending;assert.equal(h.calls(),1);
});
test('SDK fetch receives scoped abort signal while unrelated fetch remains unaffected',async()=>{
 const original=globalThis.fetch;const signals:(AbortSignal|null|undefined)[]=[];
 globalThis.fetch=async(_url,init)=>{signals.push(init?.signal);return new Response('{}');};
 try{installAvailabilityAbortTransport();const c=new AbortController();await inAvailabilityScope(c.signal,()=>fetch('https://fixture.invalid'));await fetch('https://fixture.invalid');assert.equal(signals[0],c.signal);assert.equal(signals[1],undefined);c.abort();await assert.rejects(async()=>inAvailabilityScope(c.signal,()=>fetch('https://fixture.invalid')));assert.equal(signals.length,2);}finally{globalThis.fetch=original;}
});
