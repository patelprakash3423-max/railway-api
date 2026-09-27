import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateScenario,type Scenario} from '../../test-support/availability-evaluation/harness.js';
import {scenarios} from '../../test-support/availability-evaluation/scenarios.js';
const fixture=(id:string)=>scenarios.find(s=>s.id===id)!;
const run=(s:Scenario,enabled=true)=>evaluateScenario({...s,candidateRevisit:true,balancedFairness:true,sufficientDirectResults:enabled});

for(const count of [5,7])for(const state of ['AVAILABLE','RAC'])test(`${count} ${state}: reproduce whole-leg overspend and preserve ranked results`,async()=>{
 const s=fixture(`direct-${count}-${state}`),before=await run(s,false),after=await run(s);
 assert.equal(before.actualProviderCalls,count*5);
 assert.equal(before.providerCallsUntilBestFiveWhereMeasurable,5);
 assert.equal(after.providerCallsUntilBestFiveWhereMeasurable,5);
 assert.equal(after.actualProviderCalls,state==='AVAILABLE'?count*3:count*5);
 assert.equal(after.callsAfterFifthFull,state==='AVAILABLE'?count*3-5:count*5-5);
 assert.deepEqual(after.journeys,before.journeys);
 assert.equal(after.fullJourneys,count);
 assert.equal(after.diagnostics.providerAvailabilityCalls,after.actualProviderCalls);
 assert.ok(after.diagnostics.directExploration.every(x=>x.stopReason==='SUFFICIENT_HIGH_QUALITY_RESULTS'));
});
for(const order of [[0,1,2,3,4,5,6],[6,5,4,3,2,1,0],[3,1,5,0,6,2,4]])test(`all trains retain opportunity in order ${order}`,async()=>{
 const s={...fixture('direct-7-AVAILABLE'),order};
 const before=await run(s,false),after=await run(s);
 assert.deepEqual(after.trace.slice(0,7).map(t=>t.edge.train),order);
 assert.deepEqual(after.journeys,before.journeys);
});
test('late-class AVAILABLE on a later train survives five strong trains',async()=>{
 const s:Scenario={...fixture('direct-7-AVAILABLE'),inventory:e=>e.a===0&&e.b===19?(e.train<5||e.c==='2S'?'AVAILABLE':'RAC'):'WAITLIST'};
 const before=await run(s,false),after=await run(s);
 assert.deepEqual(after.journeys,before.journeys);
 assert.ok(after.trace.some(t=>t.edge.train===6&&t.edge.c==='2S'));
 assert.equal(after.actualProviderCalls,25);
});
test('unresolved later train receives recovery after five strong results',async()=>{
 const r=await run({...fixture('direct-7-AVAILABLE'),inventory:e=>e.train<5?e.a===0&&e.b===19?'AVAILABLE':'WAITLIST':e.a===0&&e.b===10||e.a===10&&e.b===19?'AVAILABLE':'WAITLIST'});
 assert.equal(r.fullJourneys,7);
 assert.ok(r.trace.some(t=>t.edge.train===6&&t.edge.b===10));
});
test('known fares keep cheaper lower-preference classes eligible',async()=>{
 const s:Scenario={...fixture('direct-7-AVAILABLE'),fare:e=>e.c==='2S'?10:100};
 const before=await run(s,false),after=await run(s);
 assert.equal(after.actualProviderCalls,35);assert.deepEqual(after.journeys,before.journeys);
 assert.ok(after.journeys.every(j=>j.segments.some(s=>s.type==='RESERVED'&&s.selectedClass==='2S'&&s.fare?.totalFare===10)));
});
for(const minutes of [10,20,25])test(`later unresolved schedules at ${minutes} minutes per stop retain competitive recovery only`,async()=>{
 const r=await run({...fixture('direct-7-AVAILABLE'),minutesPerStop:[20,20,20,20,20,minutes,minutes],inventory:e=>e.train<5?e.a===0&&e.b===19?'AVAILABLE':'WAITLIST':e.a===0&&e.b===10||e.a===10&&e.b===19?'AVAILABLE':'WAITLIST'});
 assert.equal(r.fullJourneys,minutes<=20?7:5);
 assert.equal(r.trace.some(t=>t.edge.train===6&&t.edge.b===10),minutes<=20);
 if(minutes===25)assert.equal(r.actualProviderCalls,25);
 if(minutes===10)assert.deepEqual(r.journeys.slice(0,2).map(j=>j.train),[5,6]);
});
for(const requestedClasses of [['SL'],['SL','3A']])test(`explicit ${requestedClasses} keeps complete class comparison`,async()=>{
 const s={...fixture('direct-7-AVAILABLE'),requestedClasses};
 const before=await run(s,false),after=await run(s);
 assert.deepEqual(after.trace,before.trace);assert.deepEqual(after.journeys,before.journeys);
});
for(const id of ['direct-1-AVAILABLE','direct-1-RAC','no-revisit','position-10','class-mixed','class-explicit-multiple','partials-only','failure-rate','failure-individual'])test(`preserves prior policy below strong threshold: ${id}`,async()=>{
 const before=await run(fixture(id),false),after=await run(fixture(id));
 assert.deepEqual(after.trace,before.trace);assert.deepEqual(after.journeys,before.journeys);
 assert.deepEqual(after.diagnostics.candidateRevisit,before.diagnostics.candidateRevisit);
});
for(const budget of [4,5,6,7,20,300])test(`shared provider ceiling ${budget}`,async()=>{
 const r=await run({...fixture('direct-7-AVAILABLE'),budget});
 assert.ok(r.actualProviderCalls<=budget);assert.equal(r.actualProviderCalls,r.diagnostics.providerAvailabilityCalls);
 assert.equal(r.fullJourneys,Math.min(7,budget));
});
for(const cacheLayer of ['hot','redis','persistent'] as const)test(`${cacheLayer} evidence remains free`,async()=>{
 const r=await run({...fixture('direct-7-AVAILABLE'),cacheLayer,warmPercent:100});
 assert.equal(r.actualProviderCalls,0);assert.equal(r.fullJourneys,7);
 assert.equal(r.diagnostics.checkedMatrixEdges,21);
});
