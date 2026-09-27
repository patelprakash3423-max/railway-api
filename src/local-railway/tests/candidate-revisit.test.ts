import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateScenario,type Scenario} from '../../test-support/availability-evaluation/harness.js';
import {scenarios} from '../../test-support/availability-evaluation/scenarios.js';
const baseline=scenarios.find(s=>s.id==='no-revisit')!;
const run=(s:Scenario)=>evaluateScenario({...s,candidateRevisit:true});

test('Phase 5A completes the Phase 4 55/80 partial using the same global budget',async()=>{
 const before=await evaluateScenario(baseline),after=await run(baseline);
 assert.equal(before.actualProviderCalls,55);assert.equal(before.fullJourneys,0);
 assert.equal(after.actualProviderCalls,59);assert.equal(after.fullJourneys,1);
 assert.equal(after.diagnostics.providerCallBudgetRemaining,21);
 assert.equal(after.diagnostics.candidateRevisit.providerCalls,4);
 assert.equal(after.diagnostics.candidateRevisit.fullRecoveries,1);
 assert.deepEqual(after.trace.slice(0,before.trace.length),before.trace);
 assert.equal(new Set(after.trace.map(t=>JSON.stringify(t.edge))).size,after.trace.length,'no first-pass edge is requested again');
 assert.ok(after.diagnostics.candidateRevisit.turns.every(t=>t.trainNumber==='43001'),'exact-complete second train never revisited');
});

const multiple:Scenario={id:'multiple',group:'revisit',nodes:20,sizes:[20,20,3],budget:150,
 inventory:e=>e.train<2&&e.a===0&&e.b===18?'AVAILABLE':'WAITLIST'};
test('bounded rounds give both promising candidates a turn, including the later train',async()=>{
 const r=await run(multiple),d=r.diagnostics.candidateRevisit;
 assert.equal(d.candidates,2);assert.ok(d.turns.some(t=>t.trainNumber==='43002'));
 const first=d.turns.filter(t=>t.round===1);assert.equal(new Set(first.map(t=>t.trainNumber)).size,2);
 assert.ok(d.turns.every(t=>t.logicalChecks<=8&&t.providerCalls<=8));assert.ok(d.rounds<=4);
 assert.equal(r.fullJourneys,0);assert.ok(r.actualProviderCalls<=150);
 assert.ok(r.journeys.filter(j=>j.train<2).every(j=>j.coverage>0&&j.coverage<1&&j.unknownKm>0));
});
test('cached missing gap edges complete revisit without provider calls',async()=>{
 const r=await run({...baseline,warmEdge:e=>e.train===0&&e.a===1&&e.b===19});
 assert.equal(r.fullJourneys,1);assert.equal(r.diagnostics.candidateRevisit.fullRecoveries,1);
 assert.equal(r.diagnostics.candidateRevisit.providerCalls,0);assert.ok(r.diagnostics.candidateRevisit.logicalChecks>0);
});
test('wide-gap candidates alternate bounded turns and share the final provider attempts',async()=>{
 const r=await run({...multiple,inventory:e=>e.train<2&&e.a===0&&e.b===1?'AVAILABLE':'WAITLIST'});
 const turns=r.diagnostics.candidateRevisit.turns;
 assert.deepEqual(turns.map(t=>[t.round,t.trainNumber,t.providerCalls]),[[1,'43001',8],[1,'43002',8],[2,'43001',4],[2,'43002',4]]);
 assert.equal(r.actualProviderCalls,150);assert.equal(r.diagnostics.candidateRevisit.providerCalls,24);
 assert.equal(r.fullJourneys,0);
});
test('near-complete later candidate is prioritized before a smaller reserved prefix',async()=>{
 const r=await run({...multiple,inventory:e=>e.a===0&&(e.train===0&&e.b===1||e.train===1&&e.b===18)?'AVAILABLE':'WAITLIST'});
 assert.equal(r.diagnostics.candidateRevisit.turns[0].trainNumber,'43002');
});
test('independent candidate logical limit survives first pass and revisit',async()=>{
 const r=await run({...baseline,candidateLogicalLimit:38});
 assert.ok(r.diagnostics.candidateRevisit.logicalChecks<=3);
 assert.equal(r.fullJourneys,0);assert.ok(r.actualProviderCalls<=80);
});
test('explicit classes cannot mix during gap reinvestment',async()=>{
 const r=await run({...baseline,requestedClasses:['SL','2S']});
 assert.equal(r.fullJourneys,0);assert.ok(r.trace.every(t=>['SL','2S'].includes(t.edge.c)));
 assert.ok(r.journeys.every(j=>j.classChanges===0));
});
for(const state of ['WAITLIST','NOT_AVAILABLE'] as const)test(`${state} gaps stay non-reserved during revisit`,async()=>{
 const r=await run({...multiple,inventory:e=>e.train<2&&e.a===0&&e.b===18?'AVAILABLE':state});
 assert.equal(r.fullJourneys,0);assert.ok(r.diagnostics.candidateRevisit.logicalChecks>0);
 for(const j of r.journeys)for(const s of j.segments)if(s.type==='RESERVED')assert.equal(s.toStation,'S18');
});
for(const budget of [5,20,55,60,80,100,300])test(`revisit preserves global cap ${budget}`,async()=>{
 const r=await run({...baseline,budget});assert.ok(r.actualProviderCalls<=budget);
 assert.equal(r.diagnostics.providerAvailabilityCalls,r.actualProviderCalls);
 assert.equal(r.diagnostics.providerCallBudgetRemaining,budget-r.actualProviderCalls);
});
test('exact-complete scopes and expired deadlines never start revisit',async()=>{
 const exact=await run({...baseline,nodes:5,sizes:[5],classes:['SL'],inventory:e=>e.a===0&&e.b===1?'AVAILABLE':'WAITLIST'});
 assert.equal(exact.diagnostics.stopReason,'EXACT_MATRIX_COMPLETE');assert.equal(exact.diagnostics.candidateRevisit.candidates,0);
 const expired=await run({...baseline,deadlineMs:30,attemptMs:10});
 assert.equal(expired.diagnostics.stopReason,'DEADLINE');assert.equal(expired.diagnostics.candidateRevisit.candidates,0);
});
