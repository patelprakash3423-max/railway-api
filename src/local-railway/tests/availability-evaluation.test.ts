import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateScenario,type EvaluationResult} from '../../test-support/availability-evaluation/harness.js';
import {scenarios} from '../../test-support/availability-evaluation/scenarios.js';
import {revisitScenario} from '../../test-support/availability-evaluation/suite.js';

function invariants(r:EvaluationResult){
 const d=r.diagnostics;
 assert.equal(d.providerAvailabilityCalls,r.actualProviderCalls,'diagnostics must count actual fake boundary invocations');
 assert.ok(r.actualProviderCalls<=d.providerCallBudgetLimit&&d.providerCallBudgetLimit<=300);
 assert.equal(d.providerCallBudgetRemaining,d.providerCallBudgetLimit-r.actualProviderCalls);
 assert.equal(d.matrixCoverage,100*d.checkedMatrixEdges/d.possibleMatrixEdges);
 const valid=new Set(r.trace.filter(t=>t.result.providerState==='SUCCESS'&&t.result.days.length===1).map(t=>JSON.stringify(t.edge)));
 assert.equal(d.checkedMatrixEdges,valid.size,'only successful distinct observed edges count as coverage');
 assert.equal(d.directTrainsConsidered,r.sizes.length);
 assert.ok(r.structural.solverInvocations>0,'V8 instrumentation must count the actual production solver');
 assert.ok(r.structural.solverInvocations<=2*d.logicalAvailabilityChecks+4*r.sizes.length);
 assert.ok(r.structural.generatedIntervals<=r.sizes.reduce((n,size)=>n+size*(size-1)/2,0));
 assert.ok(r.structural.requestedClassEdges<=d.possibleMatrixEdges);
 for(const j of r.journeys){
  const parts=j.segments.flatMap(s=>s.type==='RESERVED'?s.reservationParts.map(p=>({...p,c:s.selectedClass})):[]);
  for(const p of parts)assert.ok(r.trace.some(t=>t.edge.train===j.train&&t.request.fromStationCode===p.fromStation&&t.request.toStationCode===p.toStation&&t.request.travelClass===p.c&&t.result.days.some(day=>day.state===p.availabilityStatus)),'every reservation part must have matching observed AVAILABLE/RAC evidence');
  if(j.coverage===1){assert.equal(parts[0].fromStation,'A');assert.equal(parts.at(-1)!.toStation,'B');for(let i=1;i<parts.length;i++)assert.equal(parts[i-1].toStation,parts[i].fromStation);assert.equal(j.unknownKm,0);}
  const candidate=d.directExploration.find(p=>Number(p.trainNumber)-43001===j.train)!;
  if(j.coverage<1&&(candidate.matrixCoverage??0)<100)assert.ok(j.unknownKm>0,'unexplored inventory stays unknown');
 }
 if(d.stopReason==='EXACT_MATRIX_COMPLETE')assert.equal(d.matrixCoverage,100);
}

test('Phase 4 deterministic production-planner evaluation',async t=>{
 const results=new Map<string,EvaluationResult>();
 for(const s of scenarios)await t.test(s.id,async()=>{const r=await evaluateScenario(s);results.set(s.id,r);invariants(r);
  if(s.group==='budget'){assert.equal(r.fullJourneys,0);assert.equal(r.journeys[0].unknownKm,1900);}
  if(s.id==='small-exact'||s.id.startsWith('representative-')){assert.equal(r.diagnostics.searchMode,'EXACT_MATRIX');assert.equal(r.diagnostics.matrixCoverage,100);}
  if(s.id==='cache-100'){assert.equal(r.actualProviderCalls,0);assert.equal(r.diagnostics.checkedMatrixEdges,950);assert.ok(r.diagnostics.logicalAvailabilityChecks>300);}
  if(s.id.startsWith('cache-only-')){assert.equal(r.actualProviderCalls,0);assert.equal(r.diagnostics.matrixCoverage,100);assert.equal(r.diagnostics[`${s.cacheLayer}CacheHits` as 'hotCacheHits'|'redisCacheHits'|'persistentCacheHits'],180);}
  if(s.id==='class-explicit'||s.id==='class-explicit-multiple'){assert.equal(r.fullJourneys,0);assert.ok(r.trace.every(row=>s.requestedClasses!.includes(row.request.travelClass)));assert.ok(r.journeys.every(j=>j.classChanges===0));}
  if(s.id==='class-mixed'){assert.equal(r.fullJourneys,1);assert.ok(r.journeys[0].classChanges>0);}
  if(s.id==='gap-no-bridge'||s.id.startsWith('bridge-50-')){assert.equal(r.fullJourneys,0);assert.equal(r.partialJourneys,1);}
  if(s.id.startsWith('bridge-150-'))assert.equal(r.fullJourneys,1);
  if(s.id==='deadline-30'){assert.equal(r.diagnostics.stopReason,'DEADLINE');assert.equal(r.actualProviderCalls,3);assert.equal(r.partialJourneys,1);}
  if(s.group==='failure'){assert.equal(r.partialJourneys,1);assert.equal(r.diagnostics.stopReason,s.failure==='rate'?'PROVIDER_RATE_LIMIT':'PROVIDER_UNAVAILABLE');assert.ok(r.diagnostics.matrixCoverage<100);}
  if(s.id==='very-large-adaptive'||s.id==='very-large-dense'){assert.equal(r.diagnostics.possibleMatrixEdges,2175);assert.equal(r.diagnostics.searchMode,'ADAPTIVE_GRAPH');assert.ok(r.structural.solverInvocations<=10);assert.ok(r.structural.generatedIntervals<=435);assert.ok(r.structural.frontierAddAttempts<=1000);}
  if(s.id==='very-large-branching'){assert.ok(r.structural.solverInvocations<=40);assert.ok(r.structural.generatedIntervals<=435);assert.ok(r.structural.frontierAddAttempts<=1000);assert.equal(r.partialJourneys,1);}
 });
 await t.test('no-revisit continuation spends only remaining global capacity',async()=>{
  const baseline=results.get('no-revisit')!,replay=await evaluateScenario(revisitScenario(baseline));invariants(replay);
  assert.equal(baseline.fullJourneys,0);assert.equal(baseline.partialJourneys,1);assert.equal(baseline.diagnostics.stopReason,'FAIRNESS_RESERVE');assert.ok(baseline.diagnostics.providerCallBudgetRemaining>0);
  assert.equal(replay.fullJourneys,1);assert.ok(baseline.actualProviderCalls+replay.actualProviderCalls<=baseline.diagnostics.providerCallBudgetLimit);
 });
 await t.test('measured cost and fairness comparisons remain reproducible',()=>{
  assert.equal(results.get('representative-cold')!.actualProviderCalls,180);assert.equal(results.get('representative-warm90')!.actualProviderCalls,18);
  for(const id of ['position-1','position-17','position-18'])assert.equal(results.get(id)!.fullJourneys,1);
  assert.equal(results.get('position-10')!.fullJourneys,0);
  for(const count of [1,5,7])for(const state of ['AVAILABLE','RAC']){const r=results.get(`direct-${count}-${state}`)!;assert.equal(r.fullJourneys,count);assert.equal(r.actualProviderCalls,count*5);assert.equal(r.callsAfterFirstFull,count*5-1);if(count>=5)assert.equal(r.callsAfterFifthFull,count*5-5);}
 });
 await t.test('repeat seeded cache case has identical non-timing metrics',async()=>{
  const original=results.get('cache-50')!,repeat=await evaluateScenario(scenarios.find(s=>s.id==='cache-50')!);
  assert.deepEqual(repeat.diagnostics,original.diagnostics);assert.deepEqual(repeat.seeds,original.seeds);assert.deepEqual(repeat.trace,original.trace);
 });
});
