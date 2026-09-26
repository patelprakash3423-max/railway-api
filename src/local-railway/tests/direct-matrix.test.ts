import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {RailwayDatabase} from '../database.js';
import {LocalJourneyPlannerV2} from '../planner/v2/planner.js';
import type {LocalDataset} from '../types.js';
import type {AvailabilityRequest,AvailabilityResult} from '../../domain/types/availability.js';
import {JourneyRecoveryOrchestrator} from '../../journey/availability/journey/orchestrator.js';
import {deepJourneySearchPolicy} from '../../journey/availability/journey/search-policy.js';
import {serializeJourneyV2} from '../../api/services/journey-v2-service.js';
import {presentJourneys} from '../../journey/presentation/index.js';
import {requestKey} from '../../journey/availability/inventory.js';

const date='18-09-2099';
function fixture(t:TestContext,intermediates=22,count=1){
 const db=new RailwayDatabase(':memory:');t.after(()=>db.close());
 const codes=['A',...Array.from({length:intermediates},(_,i)=>'S'+(i+1)),'B'];
 const trains:LocalDataset['trains']=Array.from({length:count},(_,i)=>({number:String(41001+i),name:'Matrix '+i,sourceCode:'A',destinationCode:'B',runningDaysRaw:'Daily',runningDays:['MON','TUE','WED','THU','FRI','SAT','SUN']}));
 const stops:LocalDataset['stops']=trains.flatMap(train=>codes.map((stationCode,i)=>{
  const minutes=360+i*20,time=String(Math.floor(minutes/60)%24).padStart(2,'0')+':'+String(minutes%60).padStart(2,'0');
  return {trainNumber:train.number,stationCode,sequence:i+1,dayOffset:Math.floor(minutes/1440),arrivalTime:i?time:undefined,departureTime:i<codes.length-1?time:undefined,distanceKm:i*100};
 }));
 db.replace({stations:codes.map(code=>({code,name:code})),trains,stops,metadata:{source:'RAILPULL_NTES',importedAt:'2099-09-01T00:00:00Z',trainCount:count,stationCount:codes.length,stopCount:stops.length}});
 const planner=new LocalJourneyPlannerV2(db,{},true).search({from:'A',to:'B',date});
 return {db,codes,input:{source:'A',destination:'B',journeyDate:date,requestedClasses:['ALL'],mode:'STANDARD' as const,plannerCandidates:planner.journeys}};
}
type State='AVAILABLE'|'RAC'|'WAITLIST'|'NOT_AVAILABLE';
function provider(rule:(r:AvailabilityRequest)=>State,cachedEvidence=false){
 const calls:AvailabilityRequest[]=[];
 // A cached fixture snapshot has no external provider work to admit.
 return {...(cachedEvidence?{providerCallAccounting:'SCOPED' as const}:{}),calls,getAvailability:async(r:AvailabilityRequest):Promise<AvailabilityResult>=>{calls.push({...r});return {request:r,provider:'railkit',providerState:'SUCCESS',days:[{date:r.journeyDate,state:rule(r)}]};}};
}
for(const gap of ['WAITLIST','NOT_AVAILABLE'] as const)for(const tail of ['AVAILABLE','RAC'] as const)test('matrix retains late portions across '+gap+' with '+tail,async t=>{
 const f=fixture(t),p=provider(r=>r.fromStationCode==='A'&&r.toStationCode==='S12'&&r.travelClass==='SL'?'AVAILABLE':r.fromStationCode==='S21'&&r.toStationCode==='B'&&r.travelClass==='3E'?tail:gap,true);
 const result=await new JourneyRecoveryOrchestrator(f.db,p).validate(f.input),j=result.journeys[0];
 assert.equal(p.calls.length,8*f.codes.length*(f.codes.length-1)/2);
 assert.equal(new Set(p.calls.map(requestKey)).size,p.calls.length);
 assert.ok(p.calls.findIndex(r=>r.fromStationCode==='S21'&&r.toStationCode==='B'&&r.travelClass==='3E')>30);
 assert.ok(p.calls.some(r=>r.fromStationCode==='S12'&&r.toStationCode==='S21'));
 assert.equal(j.journeyStatus,'PARTIAL_RESERVED_RECOVERY');
 assert.equal(j.reservedDistanceKm,1400);assert.equal(j.selfManagedDistanceKm,900);assert.equal(j.unknownDistanceKm,0);
 assert.deepEqual(j.legs[0].segments.map(s=>[s.type,s.fromStation,s.toStation]),[['RESERVED','A','S12'],['SELF_MANAGED','S12','S21'],['RESERVED','S21','B']]);
 assert.equal(j.trainChanges,0);assert.equal(j.classChanges,1);
 assert.equal(result.diagnostics.directExploration[0].stationsRemaining,0);
 assert.equal(result.diagnostics.directExploration[0].state,'EXHAUSTED_SCOPE');
 assert.equal(result.diagnostics.availabilityBudgetLimit,deepJourneySearchPolicy.maxAvailabilityChecks);
 assert.equal(result.diagnostics.wholeLegRequests+result.diagnostics.recoveryIntervalRequests,p.calls.length);
});
test('matrix returns a full mixed-class same-train path at a late stop',async t=>{
 const f=fixture(t),p=provider(r=>r.fromStationCode==='A'&&r.toStationCode==='S21'&&r.travelClass==='SL'||r.fromStationCode==='S21'&&r.toStationCode==='B'&&r.travelClass==='3E'?'AVAILABLE':'WAITLIST',true);
 const {journeys:[j]}=await new JourneyRecoveryOrchestrator(f.db,p).validate(f.input);
 assert.equal(j.journeyStatus,'FULLY_RESERVED_WITH_SPLIT_CLASS');assert.equal(j.legs[0].recoveryStatus,'FULL_RESERVED_SPLIT_CLASS');
 assert.equal(j.reservedCoverageRatio,1);assert.equal(j.unknownDistanceKm,0);assert.equal(j.trainChanges,0);assert.equal(j.classChanges,1);
 assert.deepEqual(j.legs[0].segments.map(s=>s.type==='RESERVED'?s.selectedClass:s.type),['SL','3E']);
});
test('matrix keeps alternative usable classes to minimize class changes',async t=>{
 const f=fixture(t,2),p=provider(r=>(r.fromStationCode==='A'&&r.toStationCode==='S1'&&['SL','3E'].includes(r.travelClass))||(r.fromStationCode==='S1'&&r.toStationCode==='B'&&r.travelClass==='3E')?'AVAILABLE':'WAITLIST');
 const {journeys:[j]}=await new JourneyRecoveryOrchestrator(f.db,p).validate(f.input);
 assert.equal(j.reservedCoverageRatio,1);assert.equal(j.classChanges,0);
 assert.ok(j.legs[0].segments.every(s=>s.type==='RESERVED'&&s.selectedClass==='3E'));
});
test('explicit classes remain restricted and internal edges form continuous paths',async t=>{
 const f=fixture(t),p=provider(r=>r.travelClass==='SL'&&(r.fromStationCode==='A'&&r.toStationCode==='S12'||r.fromStationCode==='S12'&&r.toStationCode==='S21'||r.fromStationCode==='S21'&&r.toStationCode==='B')?'AVAILABLE':'NOT_AVAILABLE');
 const {journeys:[j]}=await new JourneyRecoveryOrchestrator(f.db,p).validate({...f.input,requestedClasses:['SL']});
 assert.ok(p.calls.every(r=>r.travelClass==='SL'));assert.equal(j.reservedCoverageRatio,1);assert.equal(j.classChanges,0);
 assert.equal(j.legs[0].segments.flatMap(s=>s.type==='RESERVED'?s.reservationParts:[]).length,3);
});
test('all direct candidates are searched beyond the display target and best five are visible',async t=>{
 const f=fixture(t,2,7),p=provider(r=>r.trainNumber==='41007'||r.toStationCode==='S2'?'AVAILABLE':'WAITLIST');
 const result=await new JourneyRecoveryOrchestrator(f.db,p).validate(f.input);
 assert.equal(new Set(p.calls.map(r=>r.trainNumber)).size,7);
 const shown=presentJourneys(result.journeys.map(serializeJourneyV2));
 assert.equal(shown.results[0].legs[0].trainNumber,'41007');
 assert.equal(shown.results.filter(j=>j.presentation.initiallyVisible).length,5);
 assert.equal(shown.results.length,7);
});
test('matrix safety limit retains partial evidence and marks unchecked distance unknown',async t=>{
 const f=fixture(t),p=provider(r=>r.fromStationCode==='A'&&r.toStationCode==='S1'&&r.travelClass==='SL'?'AVAILABLE':'WAITLIST');
 const {journeys:[j],diagnostics}=await new JourneyRecoveryOrchestrator(f.db,p,{budgetLimit:17}).validate(f.input);
 assert.equal(p.calls.length,17);assert.equal(diagnostics.budgetRemaining,0);assert.equal(j.journeyStatus,'INVENTORY_CHECK_INCOMPLETE');
 assert.equal(j.reservedDistanceKm,100);assert.equal(j.unknownDistanceKm,2200);
 assert.ok(j.legs[0].segments.every(s=>s.type==='RESERVED'));
 const shown=presentJourneys([serializeJourneyV2(j)]);assert.equal(shown.results[0].presentation.initiallyVisible,true);
});
test('per-direct safety bound is enforced independently of the global ceiling',async t=>{
 const f=fixture(t,46),p=provider(()=> 'WAITLIST',true);
 const r=await new JourneyRecoveryOrchestrator(f.db,p).validate(f.input);
 assert.equal(p.calls.length,deepJourneySearchPolicy.maxChecksPerDirectCandidate);
 assert.equal(r.diagnostics.directExploration[0].state,'INCOMPLETE_BUDGET');
 assert.equal(r.diagnostics.directExploration[0].stationsRemaining,0);
 assert.ok(r.diagnostics.budgetRemaining>0);
});

test('product planner preserves every direct service beyond the schedule result cap',async t=>{
 const f=fixture(t,1,32),p=provider(()=> 'AVAILABLE');
 assert.equal(f.input.plannerCandidates.filter(j=>j.changes===0).length,32);
 const r=await new JourneyRecoveryOrchestrator(f.db,p).validate(f.input);
 assert.equal(r.journeys.length,32);assert.equal(p.calls.length,32);
});
test('global matrix safety bound is shared across direct candidates',async t=>{
 const f=fixture(t,46,5),p=provider(()=> 'WAITLIST',true);
 const r=await new JourneyRecoveryOrchestrator(f.db,p).validate(f.input);
 assert.equal(p.calls.length,deepJourneySearchPolicy.maxAvailabilityChecks);
 assert.equal(r.diagnostics.budgetRemaining,0);
 assert.ok(r.journeys.every(j=>j.journeyStatus==='INVENTORY_CHECK_INCOMPLETE'));
 assert.equal(r.journeys.at(-1)!.unknownDistanceKm,4700);
});
test('provider failures stay unknown while later usable edges survive',async t=>{
 const f=fixture(t,2);
 const p=provider(r=>r.fromStationCode==='S2'&&r.toStationCode==='B'?'AVAILABLE':'WAITLIST');
 const original=p.getAvailability;
 p.getAvailability=async r=>{if(r.fromStationCode==='A'&&r.toStationCode==='S1')throw {status:429};return original(r);};
 const {journeys:[j]}=await new JourneyRecoveryOrchestrator(f.db,p).validate(f.input);
 assert.equal(j.journeyStatus,'INVENTORY_CHECK_INCOMPLETE');
 assert.equal(j.reservedDistanceKm,100);assert.equal(j.unknownDistanceKm,200);
 assert.ok(j.legs[0].segments.every(s=>s.type==='RESERVED'));
});
test('direct matrix checks all intervals before any indirect inventory',async t=>{
 const f=fixture(t,2);
 const original=f.input.plannerCandidates[0],leg=original.segments[0];
 const indirect={...original,changes:1,segments:[{...leg,trainNumber:'51001',to:'S1',toStation:'S1',distanceKm:100},{...leg,trainNumber:'51002',from:'S1',fromStation:'S1',distanceKm:200}],connections:[{station:'S1',minutes:60,safety:'GOOD' as const}]};
 const p=provider(r=>r.trainNumber.startsWith('51')?'AVAILABLE':'WAITLIST');
 const r=await new JourneyRecoveryOrchestrator(f.db,p).validate({...f.input,plannerCandidates:[indirect,original]});
 const firstIndirect=p.calls.findIndex(c=>c.trainNumber.startsWith('51'));
 assert.equal(firstIndirect,8*4*3/2);
 assert.equal(r.diagnostics.directLaneBudgetUsed,48);
 assert.ok(r.diagnostics.indirectLaneStarted);
});

for(const state of ['AVAILABLE','RAC'] as const)test('matrix never reserves '+state+' with canBook false',async t=>{
 const f=fixture(t,2),p={getAvailability:async(r:AvailabilityRequest):Promise<AvailabilityResult>=>({request:r,provider:'railkit',providerState:'SUCCESS',days:[{date:r.journeyDate,state,canBook:false}]})};
 const {journeys:[j]}=await new JourneyRecoveryOrchestrator(f.db,p).validate(f.input);
 assert.equal(j.reservedCoverageRatio,0);assert.ok(j.legs[0].segments.every(s=>s.type!=='RESERVED'));
});
test('matrix exact-route unsupported response cannot exclude a later interval class',async t=>{
 const f=fixture(t,2);
 const p={getAvailability:async(r:AvailabilityRequest):Promise<AvailabilityResult>=>{
  if(r.fromStationCode==='A'&&r.toStationCode==='B')return {request:r,provider:'railkit',providerState:'PROVIDER_ERROR',days:[],providerMessage:'Class does not exist in this train for this Train route'};
  return {request:r,provider:'railkit',providerState:'SUCCESS',days:[{date:r.journeyDate,state:r.travelClass==='3E'?'AVAILABLE':'WAITLIST'}]};
 }};
 const {journeys:[j]}=await new JourneyRecoveryOrchestrator(f.db,p).validate(f.input);
 assert.equal(j.reservedCoverageRatio,1);assert.equal(j.classChanges,0);
 assert.ok(j.legs[0].segments.every(s=>s.type==='RESERVED'&&s.selectedClass==='3E'));
});

test('protected API exceeds thirty checks without bypassing provider quota',async t=>{
 const {ProtectedJourneyService}=await import('../../api/services/protected-journey-service.js');
 const {hardeningConfig}=await import('../../config/hardening.js');
 const f=fixture(t,2),p=provider(()=> 'WAITLIST');
 const service=new ProtectedJourneyService(f.db,p,hardeningConfig({}),{diagnostics:true},()=>Date.UTC(2099,8,18));
 const r=await service.search({from:'A',to:'B',date,classes:'ALL',mode:'STANDARD'});
 assert.equal(p.calls.length,48);assert.equal(r.diagnostics!.budgetLimit,32768);assert.equal(r.diagnostics!.providerErrors,0);
 const limited=provider(()=> 'WAITLIST');
 const guarded=new ProtectedJourneyService(f.db,limited,{...hardeningConfig({}),burst:12},{diagnostics:true},()=>Date.UTC(2099,8,18));
 const incomplete=await guarded.search({from:'A',to:'B',date,classes:'ALL',mode:'STANDARD'});
 assert.equal(limited.calls.length,12);assert.ok(incomplete.diagnostics!.providerErrors>0);
 assert.equal(incomplete.results[0].status,'INVENTORY_CHECK_INCOMPLETE');
 assert.equal(incomplete.results[0].reservedCoverageRatio,0);
});
test('later direct candidate retains late-route evidence after earlier complete matrices',async t=>{
 const f=fixture(t,22,3),p=provider(r=>r.trainNumber==='41003'&&((r.fromStationCode==='A'&&r.toStationCode==='S12'&&r.travelClass==='SL')||(r.fromStationCode==='S21'&&r.toStationCode==='B'&&r.travelClass==='3E'))?'AVAILABLE':'WAITLIST',true);
 const r=await new JourneyRecoveryOrchestrator(f.db,p).validate(f.input);
 assert.equal(r.journeys[0].legs[0].trainNumber,'41003');assert.equal(r.journeys[0].reservedDistanceKm,1400);
 assert.ok(r.diagnostics.directExploration.every(x=>x.stationsRemaining===0));
 assert.equal(p.calls.length,3*8*24*23/2);
});
