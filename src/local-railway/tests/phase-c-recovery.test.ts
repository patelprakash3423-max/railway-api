import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {RailwayDatabase} from '../database.js';
import type {LocalDataset} from '../types.js';
import type {V2Journey} from '../planner/v2/types.js';
import type {AvailabilityRequest,AvailabilityResult} from '../../domain/types/availability.js';
import {JourneyRecoveryOrchestrator,type JourneyOptions} from '../../journey/availability/journey/orchestrator.js';
import type {AvailabilityProvider} from '../../journey/availability/types.js';
import {requestKey} from '../../journey/availability/inventory.js';
import {AvailabilityScheduler} from '../../providers/railkit/availability-scheduler.js';
import {RailKitProvider} from '../../providers/railkit/railkit-provider.js';
import {hardeningConfig} from '../../config/hardening.js';
import {guardedProvider} from '../../api/services/protected-journey-service.js';
const date='18-09-2099';
const iso=(m:number)=>new Date(Date.UTC(2099,8,18,0,m)).toISOString().slice(0,16)+':00+05:30';
const key=(r:AvailabilityRequest)=>`${r.fromStationCode}-${r.toStationCode}-${r.travelClass}`;
type State='AVAILABLE'|'RAC'|'WAITLIST'|'NOT_AVAILABLE';
function fixture(t:TestContext,count=1,codes=['A','X','B'],start=1300){
 const db=new RailwayDatabase(':memory:');t.after(()=>db.close());
 const trains:LocalDataset['trains']=[],stops:LocalDataset['stops']=[],candidates:V2Journey[]=[];
 for(let n=0;n<count;n++){
  const trainNumber=String(30001+n),finish=start+(codes.length-1)*180;
  trains.push({number:trainNumber,name:trainNumber,sourceCode:'A',destinationCode:'B',runningDaysRaw:'Daily',runningDays:['MON','TUE','WED','THU','FRI','SAT','SUN']});
  codes.forEach((stationCode,i)=>stops.push({trainNumber,stationCode,sequence:i+1,dayOffset:Math.floor((start+i*180)/1440),arrivalTime:i?iso(start+i*180).slice(11,16):undefined,departureTime:i<codes.length-1?iso(start+i*180).slice(11,16):undefined,distanceKm:i*300}));
  candidates.push({from:'A',to:'B',departureDateTime:iso(start),arrivalDateTime:iso(finish),durationMinutes:finish-start,changes:0,segments:[{trainNumber,trainName:trainNumber,from:'A',to:'B',fromStation:'A',toStation:'B',boardingDate:date,originDate:date,departureDateTime:iso(start),boardingDateTime:iso(start),arrivalDateTime:iso(finish),distanceKm:(codes.length-1)*300}],connections:[],totalDistanceKm:(codes.length-1)*300,interchangeTiers:[],distanceDetourPercent:0,durationDetourPercent:0});
 }
 db.replace({stations:codes.map(code=>({code,name:code})),trains,stops,metadata:{source:'RAILPULL_NTES',importedAt:'2099-09-14T00:00:00Z',trainCount:count,stationCount:codes.length,stopCount:stops.length}});
 return {db,input:{source:'A',destination:'B',journeyDate:date,requestedClasses:['ALL'],plannerCandidates:candidates}};
}
function fake(rule:(r:AvailabilityRequest)=>State,canBook?:boolean){
 const calls:AvailabilityRequest[]=[];
 const provider:AvailabilityProvider={getAvailability:async r=>{calls.push({...r});return {request:{...r},provider:'railkit',providerState:'SUCCESS',days:[{date:r.journeyDate,state:rule(r),canBook}]};}};
 return {calls,provider};
}
async function run(t:TestContext,answers:Record<string,State>,options:JourneyOptions={},classes=['ALL'],count=1,codes=['A','X','B']){
 const {db,input}=fixture(t,count,codes),p=fake(r=>answers[key(r)]??'WAITLIST');
 const result=await new JourneyRecoveryOrchestrator(db,p.provider,options).validate({...input,requestedClasses:classes});
 assert.equal(new Set(p.calls.map(requestKey)).size,p.calls.length);
 assert.equal(result.diagnostics.attemptedAvailabilityChecks,p.calls.length);
 assert.equal(result.diagnostics.actualSdkInvocations,0); // Pure fake never invokes the SDK.
 assert.equal(result.diagnostics.wholeLegRequests+result.diagnostics.recoveryIntervalRequests,p.calls.length);
 assert.ok(p.calls.length<=result.diagnostics.availabilityBudgetLimit);
 return {...result,...p};
}
for(const [left,right] of [['SL','3E'],['3E','SL'],['3A','SL'],['SL','SL']] as const){
 test(`Phase C ALL same physical train ${left} -> ${right}`,async t=>{
  const r=await run(t,{[`A-X-${left}`]:'AVAILABLE',[`X-B-${right}`]:'AVAILABLE'});
  const j=r.journeys[0];assert.equal(j.reservedCoverageRatio,1);assert.equal(j.trainChanges,0);
  assert.equal(j.classChanges,Number(left!==right));
  for(const s of j.legs[0].segments){assert.equal(s.type,'RESERVED');if(s.type==='RESERVED')assert.equal(s.trainNumber,'30001');}
  const parts=j.legs[0].segments.flatMap(s=>s.type==='RESERVED'?s.reservationParts:[]);
  assert.deepEqual(parts.map(p=>[p.fromStation,p.toStation,p.boardingDate]),[['A','X',date],['X','B','19-09-2099']]);
  if(left==='SL'&&right==='3E'){
   assert.equal(r.diagnostics.wholeLegRequests,8);assert.equal(r.diagnostics.recoveryIntervalRequests,9);assert.equal(r.diagnostics.budgetRemaining,13);
   assert.deepEqual(r.calls.filter(c=>c.fromStationCode==='X').map(c=>c.travelClass),['SL','3A','2A','CC','2S','1A','EC','3E']);
   assert.equal(r.diagnostics.legsRecoveryAttempted,1);assert.equal(r.diagnostics.legsRecoverySucceeded,1);
  }
 });
}
test('Phase C three ordered mixed-class intervals within 30 checks',async t=>{
 const r=await run(t,{'A-X-SL':'AVAILABLE','X-Y-3A':'AVAILABLE','Y-B-3E':'RAC'},{},['SL','3A','3E'],1,['A','X','Y','B']);
 assert.equal(r.journeys[0].reservedCoverageRatio,1);assert.equal(r.journeys[0].trainChanges,0);
 assert.deepEqual(r.journeys[0].legs[0].segments.map(s=>s.type==='RESERVED'?[s.trainNumber,s.fromStation,s.toStation,s.selectedClass]:s.type),[['30001','A','X','SL'],['30001','X','Y','3A'],['30001','Y','B','3E']]);
});
for(const state of ['WAITLIST','NOT_AVAILABLE','UNSUPPORTED_CLASS','ERROR','AVAILABLE_FALSE','RAC_FALSE'] as const){
 test(`Phase C deferred complementary ${state} cannot reserve coverage`,async t=>{
  const {db,input}=fixture(t);const calls:AvailabilityRequest[]=[];
  const provider:AvailabilityProvider={getAvailability:async r=>{
   calls.push(r);let inventory:State='WAITLIST';
   if(key(r)==='A-X-SL')inventory='AVAILABLE';
   if(key(r)==='X-B-3E'){
    if(state==='ERROR')throw {status:503};
    if(state==='UNSUPPORTED_CLASS')throw {failureCategory:'UNSUPPORTED_CLASS'};
    inventory=state==='AVAILABLE_FALSE'?'AVAILABLE':state==='RAC_FALSE'?'RAC':state;
   }
   return {request:r,provider:'railkit',providerState:'SUCCESS',days:[{date:r.journeyDate,state:inventory,...(key(r)==='X-B-3E'&&state.endsWith('_FALSE')?{canBook:false}:{})}]};
  }};
  const r=await new JourneyRecoveryOrchestrator(db,provider).validate(input);
  assert.ok(calls.some(r=>key(r)==='X-B-3E'));
  assert.equal(r.journeys[0].reservedCoverageRatio,.5);
  assert.ok(r.journeys[0].legs[0].segments.filter(s=>s.type==='RESERVED').every(s=>s.fromStation==='A'&&s.toStation==='X'));
  assert.equal(calls.length,17);
 });
}
for(const budget of [12,14,16,17,30,40])test(`Phase C revisit respects budget ${budget}`,async t=>{
 const r=await run(t,{'A-X-SL':'AVAILABLE','X-B-3E':'AVAILABLE'},{budgetLimit:budget});
 assert.ok(r.calls.length<=budget);assert.equal(r.diagnostics.budgetRemaining,budget-r.calls.length);
 if(budget>=17)assert.equal(r.journeys[0].reservedCoverageRatio,1);
});
test('Phase C distinct candidates get initial opportunities before revisit',async t=>{
 const r=await run(t,{'A-X-SL':'AVAILABLE','X-B-3E':'AVAILABLE'},{budgetLimit:40},['ALL'],2);
 assert.equal(r.journeys.length,2);assert.ok(r.journeys.every(j=>j.reservedCoverageRatio===1));
 const interval=r.calls.filter(c=>c.fromStationCode!=='A'||c.toStationCode!=='B');
 const firstLater=interval.findIndex(c=>c.travelClass==='1A');
 assert.ok(firstLater>0);assert.deepEqual(new Set(interval.slice(0,firstLater).map(c=>c.trainNumber)),new Set(['30001','30002']));
 assert.equal(r.calls.length,34);
});
test('Phase C already full and exhausted candidates are not revisited',async t=>{
 const full=await run(t,{'A-X-SL':'AVAILABLE','X-B-3A':'AVAILABLE'});
 assert.equal(full.diagnostics.legsRecoveryAttempted,1);assert.equal(full.calls.length,11);
 const exhausted=await run(t,{}, {},['SL','3A']);
 assert.equal(exhausted.calls.length,6);assert.equal(exhausted.diagnostics.availabilityCacheHits,2);
});
test('Phase C whole direct availability retains early stop',async t=>{
 const r=await run(t,{'A-B-SL':'AVAILABLE'});assert.equal(r.calls.length,1);assert.equal(r.diagnostics.legsRecoveryAttempted,0);
});
for(const reason of ['cancelled','deadline'])test(`Phase C ${reason} stops deferred work`,async t=>{
 const {db,input}=fixture(t),controller=new AbortController();
 if(reason==='deadline'){t.mock.timers.enable({apis:['setTimeout']});setTimeout(()=>controller.abort(new Error(reason)),20);}
 const p=fake(r=>{
  if(p.calls.length===14){if(reason==='deadline')t.mock.timers.tick(20);else controller.abort(new Error(reason));}
  return key(r)==='A-X-SL'?'AVAILABLE':'WAITLIST';
 });
 const provider=guardedProvider(p.provider,controller.signal,1000,()=>{});
 await assert.rejects(new JourneyRecoveryOrchestrator(db,provider).validate(input),new RegExp(reason));
 assert.equal(p.calls.length,14);assert.ok(!p.calls.some(r=>r.travelClass==='3E'&&r.fromStationCode==='X'));
});

test('Phase C deferred exact unsupported hit uses no SDK/quota and UNKNOWN 3E remains eligible',async t=>{
 const {db,input}=fixture(t),scheduler=new AvailabilityScheduler({...hardeningConfig({}),burst:100,monthly:500});
 const real=new RailKitProvider(scheduler),savedFetch=globalThis.fetch,savedKey=process.env.RAILKIT_API_KEY;
 const unsupported:AvailabilityRequest={trainNumber:'30001',fromStationCode:'X',toStationCode:'B',journeyDate:'19-09-2099',travelClass:'1A',quota:'GN'};
 let current=unsupported;const sdk:AvailabilityRequest[]=[];
 process.env.RAILKIT_API_KEY='offline-phase-c';
 globalThis.fetch=async()=>{
  sdk.push({...current});
  if(requestKey(current)===requestKey(unsupported))return new Response(JSON.stringify({success:false,error:'Class does not exist in this train for this train route'}),{status:400});
  const status=['A-X-SL','X-B-3E'].includes(key(current))?'AVAILABLE':'WAITLIST';
  return new Response(JSON.stringify({success:true,data:{availability:[{date:current.journeyDate,status}]}}));
 };
 t.after(()=>{globalThis.fetch=savedFetch;if(savedKey===undefined)delete process.env.RAILKIT_API_KEY;else process.env.RAILKIT_API_KEY=savedKey;});
 await real.getAvailability(unsupported);assert.equal(sdk.length,1);
 const provider:AvailabilityProvider={getAvailability:r=>{current=r;return real.getAvailability(r);}};
 const result=await new JourneyRecoveryOrchestrator(db,provider).validate(input);
 assert.equal(result.journeys[0].reservedCoverageRatio,1);
 assert.equal(result.diagnostics.unsupportedEvidenceCacheHits,1);
 assert.equal(result.diagnostics.attemptedAvailabilityChecks,17);
 assert.equal(result.diagnostics.actualSdkInvocations,16);
 assert.equal(result.diagnostics.unsupportedClassSkips,0);
 assert.equal(sdk.filter(r=>requestKey(r)===requestKey(unsupported)).length,1);
 assert.ok(sdk.some(r=>key(r)==='X-B-3E'));
 assert.equal(scheduler.quota.snapshot().monthlyUsed,17);
});
