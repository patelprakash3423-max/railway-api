import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {RailwayDatabase} from '../database.js';
import {LocalJourneyPlannerV2} from '../planner/v2/planner.js';
import {JourneyRecoveryOrchestrator} from '../../journey/availability/journey/orchestrator.js';
import {invokeAvailabilityProvider} from '../../providers/availability-provider-budget.js';
import type {AvailabilityRequest,AvailabilityResult} from '../../domain/types/availability.js';
import {matrixCost,routeWideNodes} from '../../journey/availability/recovery/evidence-search.js';
import type {LocalDataset} from '../types.js';

const date='18-09-2099',five=['SL','3A','2A','CC','2S'];
function fixture(t:TestContext,nodes=20,trains=1,sizes?:number[],missingDistance?:number){
 const db=new RailwayDatabase(':memory:');t.after(()=>db.close());
 const codes=Array.from({length:nodes},(_,i)=>i===0?'A':i===nodes-1?'B':'S'+i);
 const rows:LocalDataset['trains']=Array.from({length:trains},(_,i)=>({number:String(43001+i),name:'Evidence '+i,sourceCode:'A',destinationCode:'B',runningDaysRaw:'Daily',runningDays:['MON','TUE','WED','THU','FRI','SAT','SUN']}));
 const stops=rows.flatMap((train,index)=>codes.filter((_,i)=>!sizes||i<sizes[index]-1||i===nodes-1).map((stationCode,sequence)=>{const i=codes.indexOf(stationCode),m=360+i*20,time=String(Math.floor(m/60)%24).padStart(2,'0')+':'+String(m%60).padStart(2,'0');return {trainNumber:train.number,stationCode,sequence:sequence+1,dayOffset:Math.floor(m/1440),arrivalTime:i?time:undefined,departureTime:i<nodes-1?time:undefined,distanceKm:i===missingDistance?undefined:100*i};}));
 db.replace({stations:codes.map(code=>({code,name:code})),trains:rows,stops,metadata:{source:'RAILPULL_NTES',importedAt:'2099-09-01T00:00:00Z',trainCount:trains,stationCount:nodes,stopCount:stops.length}});
 const planner=new LocalJourneyPlannerV2(db,{},true).search({from:'A',to:'B',date});
 return {db,input:{source:'A',destination:'B',journeyDate:date,requestedClasses:['ALL'],plannerCandidates:planner.journeys,supportedClassesByTrain:Object.fromEntries(rows.map(r=>[r.number,five]))}};
}
type State='AVAILABLE'|'RAC'|'WAITLIST'|'NOT_AVAILABLE';
function provider(rule:(r:AvailabilityRequest)=>State=()=> 'WAITLIST',cached:(r:AvailabilityRequest)=>boolean=()=>false){
 const logical:AvailabilityRequest[]=[],attempts:AvailabilityRequest[]=[];
 return {logical,attempts,providerCallAccounting:'SCOPED' as const,getAvailability:async(r:AvailabilityRequest):Promise<AvailabilityResult>=>{
  logical.push({...r});const answer=async():Promise<AvailabilityResult>=>({request:r,provider:'railkit',providerState:'SUCCESS',days:[{date:r.journeyDate,state:rule(r)}]});
  return cached(r)?answer():invokeAvailabilityProvider(()=>{},()=>{attempts.push({...r});return answer();});
 }};
}
test('cost formula and route-wide order are independent of station names',()=>{
 assert.equal(matrixCost(9,5),180);assert.equal(matrixCost(20,5),950);
 assert.deepEqual([...routeWideNodes(1,5)],[1,5,2,4,3]);
});
test('small exact matrix reaches 100 percent with one global provider budget',async t=>{
 const f=fixture(t,9),p=provider(),r=await new JourneyRecoveryOrchestrator(f.db,p).validate(f.input),d=r.diagnostics;
 assert.equal(d.searchMode,'EXACT_MATRIX');assert.equal(d.possibleMatrixEdges,180);assert.equal(d.checkedMatrixEdges,180);
 assert.equal(d.matrixCoverage,100);assert.equal(d.stopReason,'EXACT_MATRIX_COMPLETE');assert.equal(p.attempts.length,180);
 assert.equal(d.providerAvailabilityCalls,180);assert.equal(d.classesExplored,5);assert.equal(d.stationsExplored,9);
});
test('exact cache-heavy matrix keeps full logical coverage at much lower provider cost',async t=>{
 const f=fixture(t,9),p=provider(undefined,r=>r.travelClass!=='SL'),r=await new JourneyRecoveryOrchestrator(f.db,p).validate(f.input);
 assert.equal(r.diagnostics.checkedMatrixEdges,180);assert.equal(r.diagnostics.matrixCoverage,100);
 assert.equal(p.attempts.length,36);assert.equal(r.diagnostics.providerAvailabilityCalls,36);
});
test('large matrix uses adaptive graph and reports unexplored evidence honestly',async t=>{
 const f=fixture(t),p=provider(),r=await new JourneyRecoveryOrchestrator(f.db,p).validate(f.input),d=r.diagnostics;
 assert.equal(d.searchMode,'ADAPTIVE_GRAPH');assert.equal(d.possibleMatrixEdges,950);assert.ok(d.checkedMatrixEdges<950);
 assert.equal(d.matrixCoverage,100*d.checkedMatrixEdges/950);assert.ok(p.attempts.length<=300);
 assert.equal(r.journeys[0].journeyStatus,'INVENTORY_CHECK_INCOMPLETE');assert.equal(r.journeys[0].unknownDistanceKm,1900);
 assert.equal(r.journeys[0].legs[0].segments.length,0);assert.equal(d.stopReason,'MARGINAL_VALUE_LOW');
});
test('all trains receive all eligible whole-leg classes before any recovery',async t=>{
 const f=fixture(t,20,3),p=provider(),r=await new JourneyRecoveryOrchestrator(f.db,p).validate(f.input);
 assert.equal(p.attempts.slice(0,15).filter(r=>r.fromStationCode==='A'&&r.toStationCode==='B').length,15);
 assert.equal(new Set(p.attempts.slice(0,3).map(r=>r.trainNumber)).size,3);
 assert.ok(p.attempts.length<=300);assert.equal(r.diagnostics.directTrainsConsidered,3);
 for(const train of ['43001','43002','43003'])assert.ok(p.attempts.some(r=>r.trainNumber===train&&r.toStationCode!=='B'));
});
test('late-route split gets an opportunity with a small provider budget',async t=>{
 const f=fixture(t),p=provider(r=>r.toStationCode==='S18'||r.fromStationCode==='S18'?'AVAILABLE':'WAITLIST');
 const r=await new JourneyRecoveryOrchestrator(f.db,p,{providerCallBudgetLimit:8}).validate({...f.input,requestedClasses:['SL']});
 assert.equal(r.diagnostics.searchMode,'ADAPTIVE_GRAPH');assert.equal(r.journeys[0].reservedCoverageRatio,1);
 assert.ok(p.attempts.length<=8);assert.equal(r.diagnostics.stopReason,'SUFFICIENT_HIGH_QUALITY_RESULTS');
});
test('ALL discovers mixed-class endpoint path; explicit class cannot borrow another class',async t=>{
 const f=fixture(t),rule=(r:AvailabilityRequest):State=>r.fromStationCode==='A'&&r.toStationCode==='S18'&&r.travelClass==='SL'||r.fromStationCode==='S18'&&r.toStationCode==='B'&&r.travelClass==='3A'?'AVAILABLE':'WAITLIST';
 const p=provider(rule),r=await new JourneyRecoveryOrchestrator(f.db,p).validate(f.input);
 assert.equal(r.journeys[0].reservedCoverageRatio,1);assert.equal(r.journeys[0].classChanges,1);assert.equal(r.journeys[0].trainChanges,0);
 const explicit=provider(rule),restricted=await new JourneyRecoveryOrchestrator(f.db,explicit,{providerCallBudgetLimit:60}).validate({...f.input,requestedClasses:['SL']});
 assert.ok(explicit.logical.every(r=>r.travelClass==='SL'));assert.ok(restricted.journeys[0].reservedCoverageRatio<1);
});
test('explicit multiple classes compare alternatives without mixing classes',async t=>{
 const f=fixture(t,6),p=provider(r=>r.fromStationCode==='A'&&r.toStationCode==='S2'&&r.travelClass==='SL'||r.fromStationCode==='S2'&&r.toStationCode==='B'&&r.travelClass==='3A'?'AVAILABLE':'WAITLIST');
 const r=await new JourneyRecoveryOrchestrator(f.db,p).validate({...f.input,requestedClasses:['SL','3A']});
 assert.ok(r.journeys[0].reservedCoverageRatio<1);assert.equal(r.journeys[0].classChanges,0);
});
test('WAITLIST gap retains both reserved portions and checks its inner edges',async t=>{
 const f=fixture(t),p=provider(r=>r.fromStationCode==='A'&&r.toStationCode==='S5'||r.fromStationCode==='S14'&&r.toStationCode==='B'?'AVAILABLE':'WAITLIST');
 const r=await new JourneyRecoveryOrchestrator(f.db,p,{providerCallBudgetLimit:100}).validate({...f.input,requestedClasses:['SL']});
 const j=r.journeys[0];assert.equal(j.reservedDistanceKm,1000);assert.ok(j.reservedCoverageRatio<1);assert.equal(j.unknownDistanceKm,900);
 assert.ok(j.legs[0].segments.every(s=>s.type==='RESERVED'));assert.ok(p.logical.some(r=>r.fromStationCode==='S5'&&r.toStationCode==='S14'));
 assert.ok(p.logical.some(r=>r.fromStationCode==='S5'&&r.toStationCode==='S6'));
});
test('gap refinement can complete a multi-interval path without inventing a gap status',async t=>{
 const f=fixture(t),p=provider(r=>r.fromStationCode==='A'&&r.toStationCode==='S5'||r.fromStationCode==='S14'&&r.toStationCode==='B'||r.fromStationCode==='S5'&&r.toStationCode==='S6'||r.fromStationCode==='S6'&&r.toStationCode==='S14'?'AVAILABLE':'WAITLIST');
 const r=await new JourneyRecoveryOrchestrator(f.db,p,{providerCallBudgetLimit:100}).validate({...f.input,requestedClasses:['SL']});
 assert.equal(r.journeys[0].reservedCoverageRatio,1);assert.ok(p.attempts.length<100);assert.equal(r.diagnostics.stopReason,'SUFFICIENT_HIGH_QUALITY_RESULTS');
});
test('five provider attempts is a hard cap, unchecked edges stay unknown',async t=>{
 const f=fixture(t),p=provider(),r=await new JourneyRecoveryOrchestrator(f.db,p,{providerCallBudgetLimit:5}).validate({...f.input,requestedClasses:['SL']});
 assert.equal(p.attempts.length,5);assert.equal(r.diagnostics.providerAvailabilityCalls,5);assert.equal(r.diagnostics.stopReason,'PROVIDER_BUDGET_EXHAUSTED');
 assert.equal(r.diagnostics.checkedMatrixEdges,5);assert.equal(r.journeys[0].unknownDistanceKm,1900);
});
test('adaptive cache-only search can check more than 300 logical edges',async t=>{
 const f=fixture(t),p=provider(undefined,()=>true),r=await new JourneyRecoveryOrchestrator(f.db,p,{providerCallBudgetLimit:5}).validate(f.input);
 assert.equal(r.diagnostics.searchMode,'ADAPTIVE_GRAPH');assert.ok(r.diagnostics.checkedMatrixEdges>300);
 assert.equal(r.diagnostics.checkedMatrixEdges,950);assert.equal(r.diagnostics.matrixCoverage,100);assert.equal(p.attempts.length,0);
 assert.equal(r.diagnostics.providerAvailabilityCalls,0);assert.equal(r.diagnostics.stopReason,'SCOPE_EXHAUSTED');
});
test('enough direct full results stop deep exploration and preserve initial five',async t=>{
 const f=fixture(t,20,6),p=provider(()=> 'AVAILABLE'),r=await new JourneyRecoveryOrchestrator(f.db,p).validate(f.input);
 // Phase 5C retains SL/3A/2A and defers lower-preference whole-leg classes.
 assert.equal(p.attempts.length,18);assert.equal(r.diagnostics.stopReason,'SUFFICIENT_HIGH_QUALITY_RESULTS');
 assert.equal(r.journeys.filter(j=>j.reservedCoverageRatio===1).length,6);assert.ok(r.diagnostics.matrixCoverage<100);
});
test('deadline pressure selects adaptive; expired deadline is distinct from budget exhaustion',async t=>{
 const f=fixture(t,9),p=provider();let time=100;
 const wrapped={...p,remainingTimeMs:()=>time,getAvailability:async(r:AvailabilityRequest)=>{const result=await p.getAvailability(r);time-=10;return result;}};
 const r=await new JourneyRecoveryOrchestrator(f.db,wrapped).validate(f.input);
 assert.equal(r.diagnostics.searchMode,'ADAPTIVE_GRAPH');assert.equal(r.diagnostics.stopReason,'DEADLINE');assert.ok(p.attempts.length<180);
});
test('provider errors cannot produce exact completion or negative coverage',async t=>{
 const f=fixture(t,5),p={getAvailability:async(r:AvailabilityRequest):Promise<AvailabilityResult>=>({request:r,provider:'railkit',providerState:'PROVIDER_ERROR',days:[]})};
 const r=await new JourneyRecoveryOrchestrator(f.db,p).validate(f.input);
 assert.equal(r.diagnostics.searchMode,'EXACT_MATRIX');assert.equal(r.diagnostics.checkedMatrixEdges,0);assert.equal(r.diagnostics.stopReason,'PROVIDER_UNAVAILABLE');
 assert.equal(r.journeys[0].unknownDistanceKm,400);
});

test('large first train preserves recovery allowance for a smaller later exact matrix',async t=>{
 const f=fixture(t,20,2,[20,4]),p=provider(),r=await new JourneyRecoveryOrchestrator(f.db,p).validate(f.input);
 const [large,small]=r.diagnostics.directExploration;
 assert.equal(large.searchMode,'ADAPTIVE_GRAPH');assert.equal(large.stopReason,'FAIRNESS_RESERVE');
 assert.equal(small.searchMode,'EXACT_MATRIX');assert.equal(small.checkedMatrixEdges,30);assert.equal(small.matrixCoverage,100);
 assert.equal(r.diagnostics.searchMode,'MIXED');assert.equal(r.diagnostics.matrixCoverage,100*r.diagnostics.checkedMatrixEdges/r.diagnostics.possibleMatrixEdges);
 assert.ok(p.attempts.length<=300);assert.equal(new Set(p.attempts.slice(0,2).map(r=>r.trainNumber)).size,2);
});

test('adaptive paid refinement stops below the safety ceiling when marginal gain is low',async t=>{
 const f=fixture(t),p=provider(),r=await new JourneyRecoveryOrchestrator(f.db,p).validate(f.input);
 assert.equal(r.diagnostics.stopReason,'MARGINAL_VALUE_LOW');assert.ok(p.attempts.length<250);
 assert.ok(r.diagnostics.providerCallBudgetRemaining>0);
});

test('cache-heavy adaptive traversal respects the independent per-candidate logical bound',async t=>{
 const f=fixture(t,60),p=provider(undefined,()=>true),r=await new JourneyRecoveryOrchestrator(f.db,p).validate(f.input);
 assert.equal(r.diagnostics.availabilityRequestsUsed,8192);assert.equal(r.diagnostics.providerAvailabilityCalls,0);
 assert.equal(r.diagnostics.stopReason,'LOGICAL_SAFETY_LIMIT');assert.ok(r.diagnostics.matrixCoverage<100);
});

test('rate limiting reports incomplete evidence rather than exact completion',async t=>{
 const f=fixture(t,5),p={getAvailability:async(r:AvailabilityRequest):Promise<AvailabilityResult>=>({request:r,provider:'railkit',providerState:'PROVIDER_ERROR',failureCategory:'RATE_LIMITED',days:[]})};
 const r=await new JourneyRecoveryOrchestrator(f.db,p).validate(f.input);
 assert.equal(r.diagnostics.stopReason,'PROVIDER_RATE_LIMIT');assert.equal(r.diagnostics.checkedMatrixEdges,0);
 assert.equal(r.journeys[0].unknownDistanceKm,400);
});

test('global logical safety ceiling stays shared across cache-only direct trains',async t=>{
 const f=fixture(t,20,3),p=provider(undefined,()=>true),r=await new JourneyRecoveryOrchestrator(f.db,p,{budgetLimit:25}).validate(f.input);
 assert.equal(r.diagnostics.availabilityRequestsUsed,25);assert.equal(r.diagnostics.providerAvailabilityCalls,0);
 assert.equal(r.diagnostics.stopReason,'LOGICAL_SAFETY_LIMIT');assert.equal(p.logical.length,25);
});

test('ALL gap bridge can use two different classes within a bounded refinement turn',async t=>{
 const f=fixture(t),p=provider(r=>
  r.fromStationCode==='A'&&r.toStationCode==='S5'||r.fromStationCode==='S14'&&r.toStationCode==='B'||
  r.fromStationCode==='S5'&&r.toStationCode==='S6'&&r.travelClass==='SL'||
  r.fromStationCode==='S6'&&r.toStationCode==='S14'&&r.travelClass==='3A'?'AVAILABLE':'WAITLIST');
 const r=await new JourneyRecoveryOrchestrator(f.db,p,{providerCallBudgetLimit:150}).validate(f.input);
 assert.equal(r.journeys[0].reservedCoverageRatio,1);assert.ok(r.journeys[0].classChanges>0);
 assert.ok(p.attempts.length<150);assert.equal(r.diagnostics.stopReason,'SUFFICIENT_HIGH_QUALITY_RESULTS');
});

test('freshness expiry during exact exploration cannot leave a stale reserved edge',async t=>{
 const f=fixture(t,4);let now=Date.UTC(2099,8,17),count=0;
 const p={currentTimeMs:()=>now,getAvailability:async(r:AvailabilityRequest):Promise<AvailabilityResult>=>{
  count++;if(count>3)now+=10;
  return {request:r,provider:'railkit',providerState:'SUCCESS',observation:{observedAt:now,freshUntil:now+5},days:[{date:r.journeyDate,state:r.fromStationCode==='A'&&r.toStationCode==='S1'?'AVAILABLE':'WAITLIST'}]};
 }};
 const r=await new JourneyRecoveryOrchestrator(f.db,p).validate({...f.input,requestedClasses:['SL']});
 assert.equal(r.diagnostics.searchMode,'EXACT_MATRIX');assert.ok(r.diagnostics.matrixCoverage<100);
 assert.notEqual(r.diagnostics.stopReason,'EXACT_MATRIX_COMPLETE');assert.equal(r.journeys[0].reservedDistanceKm,0);
});

test('missing-distance nodes stay in the matrix denominator and prevent exact-complete claims',async t=>{
 const f=fixture(t,5,1,undefined,2),p=provider(),r=await new JourneyRecoveryOrchestrator(f.db,p).validate(f.input);
 assert.equal(r.diagnostics.possibleMatrixEdges,50);assert.equal(r.diagnostics.checkedMatrixEdges,30);assert.equal(r.diagnostics.matrixCoverage,60);
 assert.notEqual(r.diagnostics.stopReason,'EXACT_MATRIX_COMPLETE');assert.ok(p.logical.every(r=>r.fromStationCode!=='S2'&&r.toStationCode!=='S2'));
 assert.equal(r.journeys[0].unknownDistanceKm,400);
});

for(const state of ['AVAILABLE','RAC'] as const)test('AUTO never reserves '+state+' when canBook is false',async t=>{
 const f=fixture(t,4),p={getAvailability:async(r:AvailabilityRequest):Promise<AvailabilityResult>=>({request:r,provider:'railkit',providerState:'SUCCESS',days:[{date:r.journeyDate,state,canBook:false}]})};
 const r=await new JourneyRecoveryOrchestrator(f.db,p).validate({...f.input,requestedClasses:['SL']});
 assert.equal(r.journeys[0].reservedDistanceKm,0);assert.equal(r.diagnostics.checkedMatrixEdges,0);
});
