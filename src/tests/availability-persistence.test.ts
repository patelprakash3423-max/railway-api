import {checkFirstRoute} from '../test-support/selected-route.js';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {availabilityStateConfig} from '../config/availability-state.js';
import {hardeningConfig} from '../config/hardening.js';
import {SqliteAvailabilityObservationStore} from '../providers/observations/sqlite-store.js';
import {AvailabilityObservations} from '../providers/observations/cache.js';
import {AvailabilityFreshnessPolicy} from '../providers/observations/freshness.js';
import {makeObservation,type AvailabilityObservationStore} from '../providers/observations/model.js';
import {normalizeAvailability} from '../providers/railkit/railkit-normalizers.js';
import {RailKitProvider} from '../providers/railkit/railkit-provider.js';
import {AvailabilityScheduler} from '../providers/railkit/availability-scheduler.js';
import {AvailabilitySession} from '../journey/availability/session.js';
import {AvailabilityProviderBudget} from '../providers/availability-provider-budget.js';
import type {AvailabilityRequest} from '../domain/types/availability.js';
import {inAvailabilityScope} from '../providers/railkit/availability-abort.js';
const date='20-09-2099',start=Date.UTC(2099,8,1),hour=3600000;
const request:AvailabilityRequest={trainNumber:'30001',fromStationCode:'AAA',toStationCode:'BBB',journeyDate:date,travelClass:'SL',quota:'GN'};
const raw=(state='AVAILABLE',identity=false)=>({success:true,data:{...(identity?{train:{trainNo:request.trainNumber,from:'AAA',to:'BBB',travelClass:'SL',quota:'GN'},journeyDate:date}:{}),availability:[{date,status:state,availabilityText:state==='AVAILABLE'?'AVAILABLE 20':state==='WAITLIST'?'WL 12':state}]}});
function setup(t:TestContext,options:{store?:(real:SqliteAvailabilityObservationStore)=>AvailabilityObservationStore;reply?:()=>Promise<Response>;hotTtl?:number}={}){
 let time=start,calls=0;const now=()=>time;
 const real=new SqliteAvailabilityObservationStore({...availabilityStateConfig({}),path:':memory:'},now);
 const store=options.store?.(real)??real;
 const config={...hardeningConfig({}),burst:1000,monthly:10000,providerCacheTtlMs:options.hotTtl??15000};
 const observations=new AvailabilityObservations(store,new AvailabilityFreshnessPolicy());
 const create=()=>new RailKitProvider(new AvailabilityScheduler(config,now,observations));
 const previous=globalThis.fetch,key=process.env.RAILKIT_API_KEY;process.env.RAILKIT_API_KEY='offline-test-placeholder';
 globalThis.fetch=async()=>{calls++;return options.reply?options.reply():new Response(JSON.stringify(raw()));};
 t.after(()=>{globalThis.fetch=previous;if(key===undefined)delete process.env.RAILKIT_API_KEY;else process.env.RAILKIT_API_KEY=key;real.close();});
 const session=(limit=3,provider=create())=>new AvailabilitySession(provider,100,new AvailabilityProviderBudget(limit),now);
 const seed=(state='AVAILABLE',observedAt=time,identity=false)=>real.upsertLatest(makeObservation(normalizeAvailability(raw(state,identity),request),observedAt));
 return {real,store,observations,create,session,seed,now,advance:(ms:number)=>{time+=ms;},calls:()=>calls};
}
function failing(real:SqliteAvailabilityObservationStore,read=false,write=false):AvailabilityObservationStore{return {getLatest:r=>{if(read)throw Error('secret path read failed');return real.getLatest(r);},upsertLatest:o=>{if(write)throw Error('secret write failure');real.upsertLatest(o);},cleanup:t=>real.cleanup(t),close:()=>{}};}

test('persistent FRESH hit returns normalized AVAILABLE 20 with zero provider cost',async t=>{
 const h=setup(t);h.seed();const s=h.session(),check=await s.get(request),d=s.statistics();
 assert.equal(check.status,'AVAILABLE');assert.equal(check.rawDetails!.days[0].availableCount,20);assert.equal(h.calls(),0);
 assert.equal(d.logicalAvailabilityChecks,1);assert.equal(d.persistentCacheHits,1);assert.equal(d.providerAvailabilityCalls,0);assert.equal(d.hotCacheHits,0);
 assert.equal(check.evidence!.evidenceSource,'PERSISTENT_CACHE');assert.equal(check.evidence!.providerIdentityValidation,'NOT_PROVIDED');
 assert.equal(check.evidence!.observedAt,start);assert.equal(check.evidence!.sdkInvokedForCheck,false);
});

test('persistent MISS invokes once, writes latest and survives a new scheduler',async t=>{
 const h=setup(t),a=h.session();await a.get(request);assert.equal(a.statistics().persistentCacheMisses,1);assert.equal(a.statistics().providerAvailabilityCalls,1);
 assert.equal(h.real.getLatest(request)!.result.days[0].state,'AVAILABLE');
 const b=h.session();await b.get(request);assert.equal(b.statistics().persistentCacheHits,1);assert.equal(b.statistics().providerAvailabilityCalls,0);assert.equal(h.calls(),1);
});

test('STALE evidence is replaced by the actual provider result, never returned as current',async t=>{
 const h=setup(t,{reply:async()=>new Response(JSON.stringify(raw('NOT_AVAILABLE')))});h.seed('AVAILABLE',start-7*hour);
 const s=h.session(),check=await s.get(request);assert.equal(check.status,'UNAVAILABLE');assert.equal(s.statistics().persistentCacheStale,1);
 assert.equal(s.statistics().persistentCacheHits,0);assert.equal(s.statistics().providerAvailabilityCalls,1);assert.equal(h.calls(),1);
 assert.equal(h.real.getLatest(request)!.result.days[0].state,'NOT_AVAILABLE');assert.equal(h.real.getLatest(request)!.observedAt,start);
});

for(const state of ['WAITLIST','NOT_AVAILABLE','RAC'])test('fresh persistent '+state+' remains exact evidence',async t=>{
 const h=setup(t);h.seed(state);const s=h.session(),check=await s.get(request);
 assert.equal(check.status,state==='NOT_AVAILABLE'?'UNAVAILABLE':state);assert.equal(h.calls(),0);assert.equal(s.statistics().providerAvailabilityCalls,0);
 if(state==='WAITLIST')assert.equal(check.rawDetails!.days[0].waitlistNumber,12);
});

test('persistence read failure fails open through the same Phase 1 cap',async t=>{
 const h=setup(t,{store:r=>failing(r,true)}),s=h.session(1);
 assert.equal((await s.get(request)).status,'AVAILABLE');
 await s.get({...request,trainNumber:'30002'});await s.get({...request,trainNumber:'30003'});
 assert.equal(h.calls(),1);assert.equal(s.statistics().providerAvailabilityCalls,1);assert.equal(s.statistics().providerCallBudgetExhausted,true);
 assert.ok(s.statistics().persistentCacheReadErrors>=1);assert.equal(s.statistics().persistentCacheHits,0);
});

test('persistence write failure retains valid provider evidence and safe diagnostics',async t=>{
 const h=setup(t,{store:r=>failing(r,false,true)}),s=h.session();const check=await s.get(request);
 assert.equal(check.status,'AVAILABLE');assert.equal(s.statistics().persistentCacheWriteErrors,1);assert.equal(s.statistics().providerAvailabilityCalls,1);
 assert.equal(h.real.getLatest(request),undefined);assert.doesNotMatch(JSON.stringify(s.statistics()),/secret/);
});

test('twenty concurrent persistent misses share one read/fetch/write owner',async t=>{
 let reads=0,writes=0,release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
 const h=setup(t,{store:r=>({getLatest:async key=>{reads++;await gate;return r.getLatest(key);},upsertLatest:o=>{writes++;r.upsertLatest(o);},cleanup:time=>r.cleanup(time),close:()=>{}})});
 const provider=h.create(),sessions=Array.from({length:20},()=>h.session(3,provider)),pending=sessions.map(s=>s.get(request));
 await new Promise(resolve=>setImmediate(resolve));release();await Promise.all(pending);
 assert.equal(reads,1);assert.equal(writes,1);assert.equal(h.calls(),1);
 assert.equal(sessions.reduce((n,s)=>n+s.statistics().providerAvailabilityCalls,0),1);
 assert.equal(sessions.reduce((n,s)=>n+s.statistics().sharedInflightHits,0),19);
 assert.equal(sessions.reduce((n,s)=>n+s.statistics().persistentCacheMisses,0),1);
});

test('a fresh persistent hit plus several misses obey a one-call search limit',async t=>{
 const h=setup(t);h.seed();const s=h.session(1);
 assert.equal((await s.get(request)).status,'AVAILABLE');
 const missing={...request,trainNumber:'30002'};assert.equal((await s.get(missing)).status,'AVAILABLE');
 const denied=await s.get({...request,trainNumber:'30003'});
 assert.equal(denied.errorCategory,'PROVIDER_BUDGET_EXHAUSTED');assert.equal(h.calls(),1);
 assert.equal(s.statistics().persistentCacheHits,1);assert.equal(s.statistics().providerAvailabilityCalls,1);
});

test('hot cache precedes persistence and does not reset observedAt',async t=>{
 const h=setup(t);h.seed();const provider=h.create(),a=h.session(3,provider);await a.get(request);h.advance(100);
 const b=h.session(3,provider),check=await b.get(request);
 assert.equal(b.statistics().hotCacheHits,1);assert.equal(b.statistics().persistentCacheHits,0);assert.equal(b.statistics().persistentCacheMisses,0);
 assert.equal(check.rawDetails!.observation!.observedAt,start);assert.equal(h.calls(),0);
});

test('hydrated hot cache never extends a nearly expired observation',async t=>{
 const h=setup(t,{reply:async()=>new Response(JSON.stringify(raw('WAITLIST')))});h.seed('AVAILABLE',start-6*hour+5);
 const provider=h.create(),one=h.session(3,provider);await one.get(request);h.advance(10);
 const two=h.session(3,provider),check=await two.get(request);
 assert.equal(two.statistics().hotCacheHits,0);assert.equal(two.statistics().persistentCacheStale,1);assert.equal(h.calls(),1);assert.equal(check.status,'WAITLIST');
});

test('same-session reuse respects persistent freshness expiration',async t=>{
 const h=setup(t,{reply:async()=>new Response(JSON.stringify(raw('NOT_AVAILABLE')))});h.seed('AVAILABLE',start-6*hour+5);
 const s=h.session();await s.get(request);h.advance(10);const check=await s.get(request);
 assert.equal(check.status,'UNAVAILABLE');assert.equal(s.statistics().logicalAvailabilityChecks,2);assert.equal(s.statistics().providerAvailabilityCalls,1);
 assert.equal(s.statistics().cacheHits,0);
});

test('provider failure after a stale hit keeps the old timestamp but does not serve old AVAILABLE',async t=>{
 const h=setup(t,{reply:async()=>new Response(JSON.stringify({success:false,error:'offline failure'}),{status:500})});h.seed('AVAILABLE',start-7*hour);
 const s=h.session(),check=await s.get(request);assert.equal(check.status,'PROVIDER_ERROR');assert.equal(s.statistics().providerAvailabilityCalls,1);
 assert.equal(h.real.getLatest(request)!.observedAt,start-7*hour);assert.equal(h.real.getLatest(request)!.result.days[0].state,'AVAILABLE');
});

test('corrupt backend evidence is rejected and a valid provider response remains usable',async t=>{
 const h=setup(t,{store:r=>({...failing(r),getLatest:()=>({namespace:'railkit:availability:v1',identity:request,observedAt:start,result:{providerState:'SUCCESS',days:[{state:'AVAILABLE'}]}})})});
 const s=h.session(),check=await s.get(request);assert.equal(check.status,'AVAILABLE');assert.equal(s.statistics().persistentCacheReadErrors,1);assert.equal(h.calls(),1);
});

test('provider identity presence and bookability survive persisted reconstruction',async t=>{
 const h=setup(t);h.seed('AVAILABLE',start,true);const s=h.session(),check=await s.get(request);
 assert.equal(check.evidence!.providerIdentityValidation,'VALIDATED');assert.equal(check.evidence!.providerFromIdentityPresent,true);assert.equal(check.evidence!.providerJourneyDateIdentityPresent,true);
 assert.equal(check.evidence!.canBook,'ABSENT');assert.equal(check.evidence!.exactRequestedDateFound,true);
});

test('cancellation during persistent lookup starts no provider call or cache publication',async t=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
 const h=setup(t,{store:r=>({...failing(r),getLatest:async key=>{await gate;return r.getLatest(key);}})}),provider=h.create(),abort=new AbortController();
 const pending=inAvailabilityScope(abort.signal,()=>provider.getAvailability(request));abort.abort(new Error('cancelled'));release();
 await pending;await new Promise(resolve=>setImmediate(resolve));assert.equal(h.calls(),0);assert.equal(h.real.getLatest(request),undefined);
});


test('clock rollback cannot make future-dated hot or local observations fresh',async t=>{
 const h=setup(t);h.seed();const provider=h.create(),s=h.session(3,provider);await s.get(request);h.advance(-1000);
 await s.get(request);assert.equal(s.statistics().cacheHits,0);assert.equal(s.statistics().hotCacheHits,0);
 assert.equal(s.statistics().persistentCacheStale,1);assert.equal(h.calls(),1);
});


test('V2 exposes persistent-hit diagnostics and retains ordinary confirmed truth',async t=>{
 const {RailwayDatabase}=await import('../local-railway/database.js');
 const {ProtectedJourneyService}=await import('../api/services/protected-journey-service.js');
 const db=new RailwayDatabase(':memory:');t.after(()=>db.close());
 db.replace({stations:['AAA','BBB'].map(code=>({code,name:code})),trains:[{number:'30001',name:'Fixture',sourceCode:'AAA',destinationCode:'BBB',runningDaysRaw:'Daily',runningDays:['MON','TUE','WED','THU','FRI','SAT','SUN']}],stops:[{trainNumber:'30001',stationCode:'AAA',sequence:1,dayOffset:0,departureTime:'06:00',distanceKm:0},{trainNumber:'30001',stationCode:'BBB',sequence:2,dayOffset:0,arrivalTime:'08:00',distanceKm:100}],metadata:{source:'RAILPULL_NTES',importedAt:'2099-09-01T00:00:00Z',trainCount:1,stationCount:2,stopCount:2}});
 const h=setup(t);h.seed();const logs:Record<string,unknown>[]=[];
 const service=new ProtectedJourneyService(db,h.create(),hardeningConfig({}),{diagnostics:true,logger:r=>logs.push(r)},h.now);
 const response=await checkFirstRoute(service,{from:'aaa',to:'bbb',date,classes:['sl']});
 assert.equal(response.results[0].status,'FULLY_RESERVED_USABLE');assert.equal(response.diagnostics!.persistentCacheHits,1);
 assert.equal(response.diagnostics!.logicalAvailabilityChecks,1);assert.equal(response.diagnostics!.providerAvailabilityCalls,0);assert.equal(h.calls(),0);
 assert.equal(logs.find(r=>r.event==='journey_v2_search_completed')!.persistentCacheHits,1);
 const evidence=logs.find(r=>r.event==='journey_v2_availability_evidence')!.evidence as Record<string,unknown>;
 assert.equal(evidence.evidenceSource,'PERSISTENT_CACHE');assert.equal(evidence.observedAt,start);
});
