import test from 'node:test';
import assert from 'node:assert/strict';
import {balancedRouteNodes,balancedSpine} from '../../journey/availability/recovery/evidence-search.js';
import {evaluateScenario,fiveClasses,type Scenario} from '../../test-support/availability-evaluation/harness.js';
import {scenarios} from '../../test-support/availability-evaluation/scenarios.js';
const fixture=(id:string)=>scenarios.find(s=>s.id===id)!;
const run=(s:Scenario,balancedFairness=true)=>evaluateScenario({...s,candidateRevisit:true,balancedFairness});
test('balanced ordering is deterministic, complete and bounded across route sizes/classes',()=>{
 for(const n of [2,3,4,5,9,20,30,60]){
  const nodes=[...balancedRouteNodes(1,n-2)],pairs=[...balancedSpine(n,fiveClasses)];
  assert.equal(nodes.length,n-2);assert.equal(new Set(nodes).size,n-2);
  assert.equal(pairs.length,(n-2)*5);assert.equal(new Set(pairs.map(e=>`${e.k}:${e.c}`)).size,pairs.length);
  assert.deepEqual(pairs,[...balancedSpine(n,fiveClasses)]);
 }
 assert.deepEqual([...balancedRouteNodes(1,18)].slice(0,6),[1,18,10,17,5,14]);
 const early=[...balancedSpine(20,fiveClasses)].slice(0,15);
 for(const c of fiveClasses)assert.deepEqual(early.filter(e=>e.c===c).map(e=>e.k),[1,18,10]);
});
for(const id of ['position-1','position-10','position-17','position-18','class-SL','class-2A','class-2S'])test(`same Phase 4 fixture improves or preserves ${id}`,async()=>{
 const s=fixture(id),before=await run(s,false),after=await run(s);
 assert.equal(after.fullJourneys,1);assert.ok(after.actualProviderCalls<=before.actualProviderCalls);
 assert.ok(after.actualProviderCalls<=(s.budget??300));
 assert.deepEqual(after.trace.slice(0,s.classes?.length??5).map(t=>t.edge),before.trace.slice(0,s.classes?.length??5).map(t=>t.edge),'whole-leg breadth unchanged');
});
for(const id of ['train-position-0','train-position-1','train-position-2','train-position-0-100','train-position-1-100','train-position-2-100','no-revisit','no-revisit-counterfactual'])test(`candidate/revisit discovery preserved for ${id}`,async()=>{
 const before=await run(fixture(id),false),after=await run(fixture(id));
 assert.ok(after.fullJourneys>=before.fullJourneys);assert.equal(after.fullJourneys,1);
 assert.ok(after.actualProviderCalls<=before.actualProviderCalls);
});
for(const id of ['class-mixed','class-explicit','class-explicit-multiple','bridge-50-cold','bridge-50-warm','bridge-150-cold','bridge-150-warm','gap-no-bridge'])test(`fairness preserves inventory/class truth in ${id}`,async()=>{
 const s=fixture(id),r=await run(s);
 if(id.includes('explicit')){assert.equal(r.fullJourneys,0);assert.ok(r.trace.every(t=>s.requestedClasses!.includes(t.edge.c)));assert.ok(r.journeys.every(j=>j.classChanges===0));}
 else if(id==='gap-no-bridge'||id.startsWith('bridge-50-')){assert.equal(r.fullJourneys,0);assert.equal(r.partialJourneys,1);}
 else assert.equal(r.fullJourneys,1);
 for(const j of r.journeys)for(const segment of j.segments)if(segment.type==='RESERVED')for(const p of segment.reservationParts)assert.ok(r.trace.some(t=>t.request.trainNumber===segment.trainNumber&&t.request.fromStationCode===p.fromStation&&t.request.toStationCode===p.toStation&&t.edge.c===segment.selectedClass&&t.result.days.some(d=>d.state===p.availabilityStatus)));
});
for(const budget of [5,10,20,50,100,300])test(`balanced scheduler retains provider cap ${budget}`,async()=>{
 const r=await run(fixture(`budget-${budget}`));assert.ok(r.actualProviderCalls<=budget);
 assert.equal(r.diagnostics.providerAvailabilityCalls,r.actualProviderCalls);assert.equal(r.journeys[0].unknownKm,1900);
});
test('cache-only complete exploration remains provider-free',async()=>{
 const r=await run(fixture('cache-100'));assert.equal(r.actualProviderCalls,0);assert.equal(r.diagnostics.checkedMatrixEdges,950);
});
test('whole-leg breadth spending unchanged after sufficient direct results',async()=>{
 for(const count of [1,5,7]){const r=await run(fixture(`direct-${count}-AVAILABLE`));assert.equal(r.actualProviderCalls,count*5);assert.equal(r.fullJourneys,count);}
});
test('balanced first pass preserves Phase 5A multi-candidate revisit turns',async()=>{
 const r=await run({id:'wide-revisit',group:'revisit',nodes:20,sizes:[20,20,3],budget:150,inventory:e=>e.train<2&&e.a===0&&e.b===1?'AVAILABLE':'WAITLIST'});
 assert.deepEqual(r.diagnostics.candidateRevisit.turns.map(t=>[t.round,t.trainNumber,t.providerCalls]),[[1,'43001',8],[1,'43002',8],[2,'43001',4],[2,'43002',4]]);
 assert.equal(r.actualProviderCalls,150);assert.equal(r.fullJourneys,0);
});
test('balanced first pass can hand a cached missing gap to provider-free revisit',async()=>{
 const r=await run({id:'cached-revisit',group:'revisit',nodes:20,sizes:[20,3],budget:80,
  inventory:e=>e.train===0&&(e.a===0&&e.b===17&&e.c==='SL'||e.a===17&&e.b===19&&e.c==='2S')?'AVAILABLE':'WAITLIST',
  warmEdge:e=>e.train===0&&e.a===17&&e.b===19});
 assert.equal(r.fullJourneys,1);assert.equal(r.diagnostics.candidateRevisit.fullRecoveries,1);
 assert.equal(r.diagnostics.candidateRevisit.providerCalls,0);assert.equal(r.actualProviderCalls,55);
});
