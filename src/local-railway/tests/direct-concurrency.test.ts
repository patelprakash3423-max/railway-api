import test from 'node:test';
import assert from 'node:assert/strict';
import {directConcurrencyFixture,type FakeState} from '../../test-support/availability-evaluation/direct-concurrency.js';
import {PublicError} from '../../application/errors.js';
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('two independent checks start, with a class barrier and reverse completion',async t=>{
 const releases:(()=>void)[]=[];
 const h=directConcurrencyFixture({classes:['SL','3A'],wait:()=>new Promise<void>(r=>releases.push(r))});t.after(()=>h.db.close());
 const result=h.run();await tick();assert.equal(h.calls.length,2);
 releases[1]();await tick();assert.equal(h.calls.length,2);
 releases[0]();await tick();assert.equal(h.calls.length,4);
 releases[3]();releases[2]();await tick();assert.equal(h.calls.length,6);
 assert.deepEqual(h.calls.slice(0,4).map(r=>r.travelClass),['SL','SL','SL','SL']);
 releases[5]();releases[4]();await tick();releases[7]();releases[6]();
 const r=await result;assert.equal(h.calls.length,8);assert.equal(h.counts().maxActive,2);
 assert.equal(r.diagnostics.wholeLegRequests,8);assert.equal(r.diagnostics.providerAvailabilityCalls,8);
});

for(const budget of [1,2,3,7,91])test(`atomic shared provider budget remains exact at ${budget}`,async t=>{
 const h=directConcurrencyFixture({rule:()=> 'WAITLIST',wait:tick});t.after(()=>h.db.close());
 const r=await h.run({providerCallBudgetLimit:budget});
 assert.equal(h.calls.length,budget);assert.equal(r.diagnostics.providerAvailabilityCalls,budget);
 assert.equal(r.diagnostics.providerCallBudgetRemaining,0);assert.equal(h.scheduler.quota.snapshot().burstUsed,budget);
 assert.ok(h.counts().maxActive<=2);
});

test('shared scheduler concurrency=1 remains authoritative',async t=>{
 const h=directConcurrencyFixture({schedulerConcurrency:1,classes:['SL'],wait:tick});t.after(()=>h.db.close());
 await h.run();assert.equal(h.counts().maxActive,1);assert.equal(h.calls.length,4);
});

test('120-call burst protection is unchanged with two admissions',async t=>{
 const h=directConcurrencyFixture({count:121,classes:['SL'],wait:tick});t.after(()=>h.db.close());
 const r=await h.run();assert.equal(h.calls.length,120);assert.equal(h.scheduler.quota.snapshot().burstUsed,120);
 assert.equal(r.diagnostics.providerAvailabilityCalls,120);assert.ok(h.counts().maxActive<=2);
});

test('deadline aborts both active checks and starts no later checks',async t=>{
 const controller=new AbortController();let aborted=0;
 const h=directConcurrencyFixture({signal:controller.signal,wait:(_r,signal)=>new Promise<void>((_,reject)=>signal.addEventListener('abort',()=>{aborted++;reject(signal.reason);},{once:true}))});t.after(()=>h.db.close());
 const result=h.run();const rejected=assert.rejects(result,{code:'SEARCH_TIMEOUT'});
 await tick();assert.equal(h.calls.length,2);
 controller.abort(new PublicError('SEARCH_TIMEOUT','deadline',504));await rejected;await tick();
 assert.equal(aborted,2);assert.equal(h.calls.length,2);assert.equal(h.counts().active,0);
});

for(const state of ['AVAILABLE','RAC','WAITLIST','UNSUPPORTED'] as FakeState[])test(`ranked evidence and call order equal sequential baseline: ${state}`,async t=>{
 const rule=()=>state;
 const one=directConcurrencyFixture({count:7,rule,wait:tick}),two=directConcurrencyFixture({count:7,rule,wait:tick});
 t.after(()=>{one.db.close();two.db.close();});
 const a=await one.run({directWholeLegConcurrency:1}),b=await two.run();
 assert.deepEqual(b.journeys,a.journeys);assert.deepEqual(two.calls,one.calls);
 for(const key of ['wholeLegRequests','providerAvailabilityCalls','waitlistResponses','unsupportedClassResponses','candidateRevisit'] as const)assert.deepEqual(b.diagnostics[key],a.diagnostics[key]);
 assert.ok(two.counts().maxActive<=2);
});

test('threshold crossing flushes before a newly redundant lower-preference check',async t=>{
 // Four SL successes. The first 2S completion supplies the fifth, so the next
 // train's redundant 2S must not be speculatively admitted in the same window.
 const rule=(r:{trainNumber:string;travelClass:string}):FakeState=>r.trainNumber==='43001'?(r.travelClass==='2S'?'AVAILABLE':'WAITLIST'):(r.travelClass==='SL'?'AVAILABLE':'WAITLIST');
 const one=directConcurrencyFixture({count:5,rule,wait:tick}),two=directConcurrencyFixture({count:5,rule,wait:tick});
 t.after(()=>{one.db.close();two.db.close();});
 const a=await one.run({directWholeLegConcurrency:1}),b=await two.run();
 assert.deepEqual(two.calls,one.calls);assert.deepEqual(b.journeys,a.journeys);
 assert.deepEqual(two.calls.filter(r=>r.travelClass==='2S').map(r=>r.trainNumber),['43001']);
});

test('unsupported whole-leg class remains exact-scope; mixed-class recovery stays sequential',async t=>{
 const rule=(r:{travelClass:string;fromStationCode:string;toStationCode:string}):FakeState=>{
  if(r.fromStationCode==='A'&&r.toStationCode==='B')return r.travelClass==='SL'?'UNSUPPORTED':'WAITLIST';
  return r.toStationCode==='X'&&r.travelClass==='SL'||r.fromStationCode==='X'&&r.travelClass==='3A'?'AVAILABLE':'WAITLIST';
 };
 const one=directConcurrencyFixture({rule,wait:tick}),two=directConcurrencyFixture({rule,wait:tick});
 t.after(()=>{one.db.close();two.db.close();});
 const a=await one.run({directWholeLegConcurrency:1}),b=await two.run();
 assert.deepEqual(two.calls,one.calls);assert.deepEqual(b.journeys,a.journeys);
 assert.equal(two.counts().maxActive,2);assert.equal(two.counts().maxRecoveryActive,1);
 assert.ok(b.journeys.every(j=>j.reservedCoverageRatio===1));
 assert.equal(b.diagnostics.unsupportedClassResponses,4);assert.ok(b.diagnostics.waitlistResponses>0);
 assert.ok(two.calls.some(r=>r.toStationCode==='X'&&r.travelClass==='SL'));
});
