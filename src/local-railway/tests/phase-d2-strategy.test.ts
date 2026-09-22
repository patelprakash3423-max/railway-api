import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {RailwayDatabase} from '../database.js';
import type {LocalDataset} from '../types.js';
import type {V2Journey,V2Leg} from '../planner/v2/types.js';
import type {AvailabilityRequest,AvailabilityResult} from '../../domain/types/availability.js';
import {JourneyRecoveryOrchestrator,type JourneyOptions} from '../../journey/availability/journey/orchestrator.js';
import {AvailabilityScheduler} from '../../providers/railkit/availability-scheduler.js';
import {normalizeAvailability} from '../../providers/railkit/railkit-normalizers.js';
import {availabilitySdkInvoked} from '../../providers/availability-observation.js';
import {hardeningConfig} from '../../config/hardening.js';
const date='18-11-2099',iso=(m:number)=>new Date(Date.UTC(2099,10,18,0,m)).toISOString().slice(0,16)+':00+05:30';
type State='AVAILABLE'|'RAC'|'WAITLIST'|'NOT_AVAILABLE';
function fixture(t:TestContext,count=1,intermediates=1){
 const db=new RailwayDatabase(':memory:');t.after(()=>db.close());
 const trains:LocalDataset['trains']=[],stops:LocalDataset['stops']=[],stations=new Set<string>();
 const leg=(number:string,codes:string[],start:number,end:number):V2Leg=>{
  trains.push({number,name:number,sourceCode:codes[0],destinationCode:codes.at(-1)!,runningDaysRaw:'Daily',runningDays:['MON','TUE','WED','THU','FRI','SAT','SUN']});
  codes.forEach((stationCode,i)=>{stations.add(stationCode);const time=Math.round(start+(end-start)*i/(codes.length-1));stops.push({trainNumber:number,stationCode,sequence:i+1,dayOffset:0,arrivalTime:i?iso(time).slice(11,16):undefined,departureTime:i<codes.length-1?iso(time).slice(11,16):undefined,distanceKm:600*i/(codes.length-1)});});
  return {trainNumber:number,trainName:number,from:codes[0],to:codes.at(-1)!,fromStation:codes[0],toStation:codes.at(-1)!,boardingDate:date,originDate:date,departureDateTime:iso(start),boardingDateTime:iso(start),arrivalDateTime:iso(end),distanceKm:600};
 };
 const journey=(legs:V2Leg[]):V2Journey=>({from:'A',to:'B',departureDateTime:legs[0].departureDateTime,arrivalDateTime:legs.at(-1)!.arrivalDateTime,durationMinutes:(Date.parse(legs.at(-1)!.arrivalDateTime)-Date.parse(legs[0].departureDateTime))/60000,changes:legs.length-1,segments:legs,connections:legs.length>1?[{station:'Z',minutes:60,safety:'GOOD'}]:[],totalDistanceKm:legs.length*600,interchangeTiers:legs.length>1?['SMALL']:[],distanceDetourPercent:0,durationDetourPercent:0});
 const direct=Array.from({length:count},(_,i)=>journey([leg(String(30001+i),['A',...Array.from({length:intermediates},(_,j)=>`S${j+1}`),'B'],360+i,1000+i)]));
 const indirect=journey([leg('40001',['A','Z'],360,600),leg('40002',['Z','B'],660,1000)]);
 db.replace({stations:[...stations].map(code=>({code,name:code})),trains,stops,metadata:{source:'RAILPULL_NTES',importedAt:'2099-11-01T00:00:00Z',trainCount:trains.length,stationCount:stations.size,stopCount:stops.length}});
 return {db,direct,indirect,input:{source:'A',destination:'B',journeyDate:date,requestedClasses:['SL'],plannerCandidates:[...direct,indirect]}};
}
async function run(t:TestContext,rule:(r:AvailabilityRequest)=>State,options:JourneyOptions={},count=1,stops=1,classes=['SL']){
 const f=fixture(t,count,stops),calls:AvailabilityRequest[]=[];
 const provider={getAvailability:async(r:AvailabilityRequest):Promise<AvailabilityResult>=>{calls.push({...r});return {request:r,provider:'railkit',providerState:'SUCCESS',days:[{date:r.journeyDate,state:rule(r)}]};}};
 const result=await new JourneyRecoveryOrchestrator(f.db,provider,options).validate({...f.input,requestedClasses:classes});
 return {...result,calls};
}
test('D2 direct same-train recovery precedes indirect inventory',async t=>{
 const r=await run(t,r=>r.trainNumber==='30001'&&((r.fromStationCode==='A'&&r.toStationCode==='S1')||(r.fromStationCode==='S1'&&r.toStationCode==='B'))?'AVAILABLE':'WAITLIST',{usableTarget:1});
 assert.equal(r.journeys[0].reservedCoverageRatio,1);
 assert.ok(r.calls.every(c=>c.trainNumber==='30001'),JSON.stringify(r.calls));
});
test('D2 only useful small station outside old top-eight cap remains reachable',async t=>{
 const r=await run(t,r=>r.trainNumber==='30001'&&((r.fromStationCode==='A'&&r.toStationCode==='S1')||(r.fromStationCode==='S1'&&r.toStationCode==='B'))?'AVAILABLE':'WAITLIST',{budgetLimit:300,usableTarget:1},1,12);
 assert.equal(r.journeys.find(j=>j.trainChanges===0)?.reservedCoverageRatio,1);
 assert.ok(r.calls.some(r=>r.toStationCode==='S1'));
});

for(const classes of [['SL'],['ALL'],['3E']])test(`D2 four direct trains receive a fair preferred first pass ${classes}`,async t=>{
 const r=await run(t,()=> 'WAITLIST',{},4,1,classes);
 assert.deepEqual(r.calls.slice(0,4).map(c=>[c.trainNumber,c.fromStationCode,c.toStationCode,c.travelClass]),['30001','30002','30003','30004'].map(n=>[n,'A','B',classes[0]==='ALL'?'SL':classes[0]]));
 assert.ok(r.calls.length<=30);
});
for(const state of ['AVAILABLE','RAC'] as const)test(`D2 exact ${state} reaches configured target without indirect calls`,async t=>{
 const r=await run(t,()=>state,{usableTarget:2},4);
 assert.equal(r.calls.length,2);assert.equal(r.diagnostics.directWholeLegUsable,2);assert.equal(r.diagnostics.indirectLaneStarted,false);
 const usable=r.journeys.filter(j=>j.journeyStatus==='FULLY_RESERVED_USABLE');assert.equal(usable.length,2);
 assert.ok(usable.every(j=>j.trainChanges===0&&j.legs[0].segments.every(s=>s.type==='RESERVED'&&s.availabilityStatus===state)));
});
for(const state of ['WAITLIST','NOT_AVAILABLE'] as const)test(`D2 direct ${state} recovers before indirect`,async t=>{
 const r=await run(t,r=>r.trainNumber==='30001'&&r.fromStationCode!==r.toStationCode&&!(r.fromStationCode==='A'&&r.toStationCode==='B')?'AVAILABLE':state,{usableTarget:1});
 assert.equal(r.diagnostics.directWholeLegUsable,0);assert.equal(r.diagnostics.sameTrainFullRecoveries,1);assert.equal(r.diagnostics.indirectLaneBudgetUsed,0);assert.equal(r.journeys[0].trainChanges,0);
});
for(const [left,right] of [['SL','3E'],['3A','SL']] as const)test(`D2 ALL mixed-class ${left}/${right} gap completion`,async t=>{
 const r=await run(t,r=>r.trainNumber==='30001'&&((r.fromStationCode==='A'&&r.toStationCode==='S1'&&r.travelClass===left)||(r.fromStationCode==='S1'&&r.toStationCode==='B'&&r.travelClass===right))?'AVAILABLE':'WAITLIST',{usableTarget:1},1,1,['ALL']);
 assert.equal(r.journeys[0].reservedCoverageRatio,1);assert.equal(r.journeys[0].trainChanges,0);assert.equal(r.journeys[0].classChanges,1);
 assert.ok(r.journeys[0].legs[0].segments.every(s=>s.type==='RESERVED'&&s.trainNumber==='30001'));
});
for(const classes of [['SL'],['SL','3A']])test(`D2 explicit classes stay within selected scope ${classes}`,async t=>{
 const r=await run(t,r=>r.travelClass==='3E'?'AVAILABLE':'WAITLIST',{usableTarget:1},1,1,classes);
 assert.equal(r.calls[0].travelClass,'SL');
 assert.ok(r.calls.every(c=>classes.includes(c.travelClass)));
 assert.ok(r.journeys.every(j=>j.reservedCoverageRatio===0));
 assert.equal(r.diagnostics.directExploration[0].state,'EXHAUSTED_SCOPE');
});
test('D2 long-route budget stop reports unconsidered stations and incomplete scope',async t=>{
 const r=await run(t,()=> 'WAITLIST',{},1,100);
 assert.equal(r.diagnostics.sameTrainStationsEligible,100);assert.ok(r.diagnostics.sameTrainStationsRemaining>0);
 assert.equal(r.diagnostics.sameTrainStationsEligible,r.diagnostics.sameTrainStationsConsidered+r.diagnostics.sameTrainStationsRemaining);
 assert.equal(r.diagnostics.directExploration[0].state,'INCOMPLETE_BUDGET');assert.notEqual(r.journeys.find(j=>j.trainChanges===0)?.journeyStatus,'SCHEDULED_BUT_NOT_FULLY_AVAILABLE');
 assert.ok(r.diagnostics.directExploration[0].intervalsGenerated<=r.calls.length+3);assert.ok(r.calls.length<=30);
});
test('D2 coverage gap gets later classes before unrelated stations',async t=>{
 const r=await run(t,r=>r.trainNumber==='30001'&&((r.fromStationCode==='A'&&r.toStationCode==='S2'&&r.travelClass==='SL')||(r.fromStationCode==='S2'&&r.toStationCode==='B'&&r.travelClass==='3E'))?'AVAILABLE':'WAITLIST',{usableTarget:1},1,3,['ALL']);
 assert.equal(r.journeys[0].reservedCoverageRatio,1);
 const intervals=r.calls.filter(c=>!(c.fromStationCode==='A'&&c.toStationCode==='B'));
 assert.ok(intervals.every(c=>c.fromStationCode==='S2'||c.toStationCode==='S2'));
});
test('D2 exhausted direct scope allows safe indirect fallback',async t=>{
 const r=await run(t,r=>r.trainNumber.startsWith('4')?'AVAILABLE':'WAITLIST',{budgetLimit:40,usableTarget:1});
 assert.equal(r.diagnostics.directExploration[0].state,'EXHAUSTED_SCOPE');assert.equal(r.diagnostics.indirectLaneStarted,true);
 const firstIndirect=r.calls.findIndex(c=>c.trainNumber.startsWith('4'));
 assert.ok(firstIndirect>0);assert.ok(r.calls.slice(firstIndirect).every(c=>c.trainNumber.startsWith('4')));
 assert.ok(r.journeys.some(j=>j.trainChanges===1&&j.reservedCoverageRatio===1));
});
for(const budgetLimit of [12,30,40,100])test(`D2 shared budget remains ${budgetLimit}`,async t=>{
 const r=await run(t,()=> 'WAITLIST',{budgetLimit},4,20,['ALL']);
 assert.ok(r.calls.length<=budgetLimit);assert.equal(r.diagnostics.directLaneBudgetUsed+r.diagnostics.indirectLaneBudgetUsed,r.calls.length);
 assert.equal(r.diagnostics.attemptedAvailabilityChecks,r.calls.length);assert.equal(r.diagnostics.budgetRemaining,budgetLimit-r.calls.length);
});
test('D2 cancellation stops progressive work before further calls',async t=>{
 const f=fixture(t,1,20),controller=new AbortController();let calls=0;
 const provider={assertActive:()=>controller.signal.throwIfAborted(),getAvailability:async(r:AvailabilityRequest):Promise<AvailabilityResult>=>{if(++calls===12)controller.abort(new Error('cancelled'));return {request:r,provider:'railkit',providerState:'SUCCESS',days:[{date:r.journeyDate,state:'WAITLIST'}]};}};
 await assert.rejects(new JourneyRecoveryOrchestrator(f.db,provider).validate(f.input),/cancelled/);assert.equal(calls,12);
});

// Exercise the process-shared cache, not just a second call in one session.
for(const count of [1,3])for(const [mode,budget] of [['QUICK',12],['STANDARD',30],['DEEP',40]] as const)
 for(const classes of [['SL'],['SL','3A'],['ALL']])
  for(const recoverable of [false,true])test(
   `D2 cold/warm scope is identical: ${count} direct ${mode} ${classes} recovery=${recoverable}`,async t=>{
 const f=fixture(t,count,recoverable?3:12);
 const scheduler=new AvailabilityScheduler(hardeningConfig({}),()=>0);
 let trace:AvailabilityRequest[]=[],sdkCalls=0;
 const provider={getAvailability:async(r:AvailabilityRequest):Promise<AvailabilityResult>=>{
  trace.push({...r});
  return normalizeAvailability(await scheduler.execute(r,async()=>{
   availabilitySdkInvoked();sdkCalls++;
   // The first progressive station has useful coverage; ALL must finish its
   // same-train gap in a later class before considering unrelated stations.
   const usable=recoverable&&r.trainNumber==='30001'&&(
    (r.fromStationCode==='A'&&r.toStationCode==='S2'&&r.travelClass==='SL')||
    (r.fromStationCode==='S2'&&r.toStationCode==='B'&&r.travelClass==='3E'));
   return {success:true,data:{availability:[{date:r.journeyDate,status:usable?'AVAILABLE':'WAITLIST'}]}};
  }),r);
 }};
 const search=()=>new JourneyRecoveryOrchestrator(f.db,provider,{usableTarget:1}).validate({...f.input,mode,requestedClasses:classes});
 const cold=await search(),coldTrace=trace;
 const coldSdk=sdkCalls;trace=[];
 const warm=await search();
 assert.deepEqual(trace,coldTrace,'shared cache must not admit additional intervals/classes');
 assert.equal(new Set(coldTrace.map(r=>JSON.stringify(r))).size,coldTrace.length,'session reuse must prevent duplicate provider work');
 assert.ok(coldTrace.length<=budget);
 assert.equal(cold.diagnostics.attemptedAvailabilityChecks,coldTrace.length);
 assert.equal(warm.diagnostics.attemptedAvailabilityChecks,coldTrace.length);
 assert.equal(cold.diagnostics.actualSdkInvocations,coldSdk);
 assert.equal(warm.diagnostics.actualSdkInvocations,0);
 assert.equal(warm.diagnostics.sharedCacheHits,coldTrace.length);
 assert.equal(sdkCalls,coldSdk);
 // Provenance necessarily differs; inventory, ranking and scope must not.
 const inventory=(value:unknown)=>JSON.parse(JSON.stringify(value,(key,v)=>key==='evidence'?undefined:v));
 assert.deepEqual(inventory(warm.journeys),inventory(cold.journeys));
 for(const key of ['budgetRemaining','directExploration','directLaneBudgetUsed','indirectLaneBudgetUsed','indirectLaneStarted','sameTrainStationsConsidered','sameTrainStationsRemaining','sameTrainFullRecoveries'] as const)
  assert.deepEqual(warm.diagnostics[key],cold.diagnostics[key],key);
 if(classes[0]!=='ALL')assert.ok(trace.every(r=>classes.includes(r.travelClass)));
 if(recoverable&&classes[0]==='ALL'&&mode!=='QUICK'){
  assert.equal(cold.diagnostics.sameTrainFullRecoveries,1);
  assert.equal(cold.diagnostics.indirectLaneStarted,false);
 }
});

for(const maxRecoveryRequestsPerCandidate of [0,2,4])test('D2 explicit recovery cap spans early and continuation phases: '+maxRecoveryRequestsPerCandidate,async t=>{
 const r=await run(t,r=>r.trainNumber==='30001'&&r.fromStationCode==='A'&&r.toStationCode==='S2'?'AVAILABLE':'WAITLIST',
  {maxRecoveryRequestsPerCandidate},3,3,['ALL']);
 for(const trainNumber of ['30001','30002','30003'])assert.ok(r.calls.filter(c=>c.trainNumber===trainNumber&&!(c.fromStationCode==='A'&&c.toStationCode==='B')).length<=maxRecoveryRequestsPerCandidate);
});
