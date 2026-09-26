import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {AvailabilityProviderBudget,ProviderCallBudgetExhausted,withAvailabilityProviderBudget,invokeAvailabilityProvider} from '../providers/availability-provider-budget.js';
import {AvailabilitySession} from '../journey/availability/session.js';
import {AvailabilityScheduler} from '../providers/railkit/availability-scheduler.js';
import {RailKitProvider} from '../providers/railkit/railkit-provider.js';
import {hardeningConfig} from '../config/hardening.js';
import {inAvailabilityScope,installAvailabilityAbortTransport} from '../providers/railkit/availability-abort.js';
import {guardedProvider,ProtectedJourneyService} from '../api/services/protected-journey-service.js';
import {JourneyV2ApiService} from '../api/services/journey-v2-service.js';
import {RailwayDatabase} from '../local-railway/database.js';
import type {AvailabilityRequest,AvailabilityResult} from '../domain/types/availability.js';
const date='20-09-2099';
const request:AvailabilityRequest={trainNumber:'30001',fromStationCode:'AAA',toStationCode:'CCC',journeyDate:date,travelClass:'SL',quota:'GN'};
const unique=(n:number)=>({...request,trainNumber:String(30000+n)});
const config=()=>({...hardeningConfig({}),burst:10000,monthly:100000,providerConcurrency:10});
function mock(t:TestContext,reply:()=>Promise<Response>=async()=>new Response(JSON.stringify({success:true,data:{availability:[{date,status:'AVAILABLE'}]}}))){
 const key=process.env.RAILKIT_API_KEY,fetch=globalThis.fetch;process.env.RAILKIT_API_KEY='offline-test-placeholder';
 let calls=0;globalThis.fetch=async()=>{calls++;return reply();};
 t.after(()=>{globalThis.fetch=fetch;if(key===undefined)delete process.env.RAILKIT_API_KEY;else process.env.RAILKIT_API_KEY=key;});
 const scheduler=new AvailabilityScheduler(config());return {provider:new RailKitProvider(scheduler),scheduler,calls:()=>calls};
}
function fixture(t:TestContext){
 const db=new RailwayDatabase(':memory:');t.after(()=>db.close());
 const codes=['AAA','XXX','YYY','CCC'];
 db.replace({stations:codes.map(code=>({code,name:code})),trains:[{number:'30001',name:'Generic direct fixture',sourceCode:'AAA',destinationCode:'CCC',runningDaysRaw:'Daily',runningDays:['MON','TUE','WED','THU','FRI','SAT','SUN']}],stops:codes.map((stationCode,i)=>({trainNumber:'30001',stationCode,sequence:i+1,dayOffset:0,arrivalTime:i?'0'+(6+i)+':00':undefined,departureTime:i<3?'0'+(6+i)+':00':undefined,distanceKm:i*100})),metadata:{source:'RAILPULL_NTES',importedAt:'2099-09-01T00:00:00Z',trainCount:1,stationCount:4,stopCount:4}});
 return db;
}

test('validated provider ceiling defaults to 300 and can only be lowered',()=>{
 assert.equal(hardeningConfig({}).providerCallBudgetLimit,300);
 for(const n of [1,3,5,300])assert.equal(hardeningConfig({JOURNEY_AVAILABILITY_PROVIDER_CALL_LIMIT:String(n)}).providerCallBudgetLimit,n);
 for(const raw of ['0','-1','NaN','Infinity','3.1','301','invalid'])assert.throws(()=>hardeningConfig({JOURNEY_AVAILABILITY_PROVIDER_CALL_LIMIT:raw}));
 for(const n of [0,-1,NaN,Infinity,3.1,301])assert.throws(()=>new AvailabilityProviderBudget(n));
});

test('ten unique logical requests admit exactly three SDK/transport owners',async t=>{
 const h=mock(t),budget=new AvailabilityProviderBudget(3),session=new AvailabilitySession(h.provider,100,budget);
 const checks=[];for(let i=0;i<10;i++)checks.push(await session.get(unique(i)));
 assert.equal(h.calls(),3);assert.equal(h.scheduler.quota.snapshot().monthlyUsed,3);
 assert.equal(session.statistics().actualSdkInvocations,3);assert.equal(session.statistics().logicalAvailabilityChecks,10);
 assert.deepEqual(budget.statistics(),{providerAvailabilityCalls:3,providerCallBudgetLimit:3,providerCallBudgetRemaining:0,providerCallBudgetExhausted:true});
 assert.ok(checks.slice(3).every(c=>c.status==='PROVIDER_ERROR'&&c.errorCategory==='PROVIDER_BUDGET_EXHAUSTED'));
 assert.equal(session.statistics().unavailableResponses,0);
});

test('default production cap prevents the 301st unique outbound availability invocation',async t=>{
 const h=mock(t),budget=new AvailabilityProviderBudget();
 await withAvailabilityProviderBudget(budget,()=>Promise.all(Array.from({length:310},(_,i)=>h.provider.getAvailability(unique(i)))));
 assert.equal(h.calls(),300);assert.equal(budget.statistics().providerAvailabilityCalls,300);
 assert.equal(h.scheduler.quota.snapshot().monthlyUsed,300);
});

test('local and fresh shared inventory hits increase logical checks but cost zero provider calls',async t=>{
 const h=mock(t);await h.provider.getAvailability(request); // Warm outside this user search.
 const s=new AvailabilitySession(h.provider,100,new AvailabilityProviderBudget(3));
 await s.get(request);await s.get(request);
 assert.equal(s.statistics().logicalAvailabilityChecks,2);assert.equal(s.statistics().sharedCacheHits,1);
 assert.equal(s.statistics().cacheHits,1);assert.equal(s.statistics().providerAvailabilityCalls,0);assert.equal(h.calls(),1);
});

test('shared cache remains free even at zero remaining provider allowance',async t=>{
 const h=mock(t),budget=new AvailabilityProviderBudget(1);
 await withAvailabilityProviderBudget(budget,()=>h.provider.getAvailability(request));
 await withAvailabilityProviderBudget(budget,()=>h.provider.getAvailability(request));
 const denied=await withAvailabilityProviderBudget(budget,()=>h.provider.getAvailability(unique(9)));
 assert.equal(denied.failureCategory,'PROVIDER_BUDGET_EXHAUSTED');
 await withAvailabilityProviderBudget(budget,()=>h.provider.getAvailability(request));
 assert.equal(h.calls(),1);assert.equal(budget.statistics().providerAvailabilityCalls,1);
});

test('twenty concurrent identical shared misses charge one owner, not nineteen followers',async t=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
 const h=mock(t,async()=>{await gate;return new Response(JSON.stringify({success:true,data:{availability:[{date,status:'AVAILABLE'}]}}));});
 const budget=new AvailabilityProviderBudget(3),sessions=Array.from({length:20},()=>new AvailabilitySession(h.provider,100,budget));
 const pending=sessions.map(s=>s.get(request));await new Promise(resolve=>setImmediate(resolve));release();await Promise.all(pending);
 assert.equal(h.calls(),1);assert.equal(budget.statistics().providerAvailabilityCalls,1);
 assert.equal(sessions.reduce((n,s)=>n+s.statistics().logicalAvailabilityChecks,0),20);
 assert.equal(sessions.reduce((n,s)=>n+s.statistics().sharedInflightHits,0),19);
});

test('unique concurrent owners cannot race beyond the final remaining admission',async t=>{
 const h=mock(t);
 for(let round=0;round<5;round++){
  const budget=new AvailabilityProviderBudget(3),before=h.calls();
  await withAvailabilityProviderBudget(budget,async()=>{
   await h.provider.getAvailability(unique(100+round*30));await h.provider.getAvailability(unique(101+round*30));
   const results=await Promise.all(Array.from({length:20},(_,i)=>h.provider.getAvailability(unique(102+round*30+i))));
   assert.equal(results.filter(r=>r.providerState==='SUCCESS').length,1);
   assert.ok(results.filter(r=>r.providerState!=='SUCCESS').every(r=>r.failureCategory==='PROVIDER_BUDGET_EXHAUSTED'));
  });
  assert.equal(h.calls()-before,3);assert.equal(budget.statistics().providerAvailabilityCalls,3);
 }
});

test('different searches have independent budgets and a shared follower spends none',async t=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
 const h=mock(t,async()=>{await gate;return new Response(JSON.stringify({success:true,data:{availability:[{date,status:'AVAILABLE'}]}}));});
 const one=new AvailabilityProviderBudget(3),two=new AvailabilityProviderBudget(3);
 const a=withAvailabilityProviderBudget(one,()=>h.provider.getAvailability(request));
 const b=withAvailabilityProviderBudget(two,()=>h.provider.getAvailability(request));release();await Promise.all([a,b]);
 assert.equal(one.statistics().providerAvailabilityCalls,1);assert.equal(two.statistics().providerAvailabilityCalls,0);
 await Promise.all([withAvailabilityProviderBudget(one,()=>Promise.all([h.provider.getAvailability(unique(10)),h.provider.getAvailability(unique(11)),h.provider.getAvailability(unique(12))])),withAvailabilityProviderBudget(two,()=>Promise.all([h.provider.getAvailability(unique(20)),h.provider.getAvailability(unique(21)),h.provider.getAvailability(unique(22)),h.provider.getAvailability(unique(23))]))]);
 assert.equal(one.statistics().providerAvailabilityCalls,3);assert.equal(two.statistics().providerAvailabilityCalls,3);assert.equal(h.calls(),6);
});

test('admitted failing attempts count, while invalid input, pre-cancellation and quota denial do not',async t=>{
 const h=mock(t,async()=>{throw new Error('offline network failure');});
 const budget=new AvailabilityProviderBudget(3);
 await withAvailabilityProviderBudget(budget,()=>h.provider.getAvailability({...request,trainNumber:'invalid'}));
 assert.equal(budget.statistics().providerAvailabilityCalls,0);
 const abort=new AbortController();abort.abort(new Error('cancelled'));
 await assert.rejects(withAvailabilityProviderBudget(budget,()=>guardedProvider(h.provider,abort.signal,1000,()=>{}).getAvailability(request)),/cancelled/);
 assert.equal(budget.statistics().providerAvailabilityCalls,0);
 await withAvailabilityProviderBudget(budget,()=>h.provider.getAvailability(request));
 assert.equal(h.calls(),1);assert.equal(budget.statistics().providerAvailabilityCalls,1);
 assert.throws(()=>budget.acquire(()=>{throw new Error('quota denied');}),/quota denied/);
 assert.equal(budget.statistics().providerAvailabilityCalls,1);
 await assert.rejects(withAvailabilityProviderBudget(budget,async()=>invokeAvailabilityProvider(()=>{},async()=>{throw new Error('SDK threw');})),/SDK threw/);
 assert.equal(budget.statistics().providerAvailabilityCalls,2);
});

test('extra fetch attempts within one SDK invocation require fresh admission',async t=>{
 const h=mock(t),budget=new AvailabilityProviderBudget(3);let quota=0;
 installAvailabilityAbortTransport();
 await assert.rejects(withAvailabilityProviderBudget(budget,()=>inAvailabilityScope(new AbortController().signal,()=>invokeAvailabilityProvider(()=>{quota++;},async()=>{
  for(let i=0;i<4;i++)await fetch('https://offline.invalid/availability');
 }))),ProviderCallBudgetExhausted);
 assert.equal(h.calls(),3);assert.equal(quota,3);assert.equal(budget.statistics().providerAvailabilityCalls,3);
});

test('budget failures are not cached as shared inventory or unsupported evidence',async t=>{
 const h=mock(t),one=new AvailabilityProviderBudget(1),two=new AvailabilityProviderBudget(1);
 await withAvailabilityProviderBudget(one,()=>h.provider.getAvailability(request));
 const denied=await withAvailabilityProviderBudget(one,()=>h.provider.getAvailability(unique(20)));
 assert.equal(denied.failureCategory,'PROVIDER_BUDGET_EXHAUSTED');
 const later=await withAvailabilityProviderBudget(two,()=>h.provider.getAvailability(unique(20)));
 assert.equal(later.providerState,'SUCCESS');assert.equal(h.calls(),2);assert.equal(two.statistics().providerAvailabilityCalls,1);
});

test('direct, recovery, class rounds and subsequent phases share one budget and keep partial evidence',async t=>{
 const db=fixture(t);const calls:AvailabilityRequest[]=[];
 const provider={getAvailability:async(r:AvailabilityRequest):Promise<AvailabilityResult>=>{
  calls.push(r);return {request:r,provider:'railkit',providerState:'SUCCESS',days:[{date,state:r.fromStationCode==='AAA'&&r.toStationCode==='XXX'?'AVAILABLE':'WAITLIST'}]};
 }};
 const logs:Record<string,unknown>[]=[];
 const service=new ProtectedJourneyService(db,provider,{...config(),providerCallBudgetLimit:3},{diagnostics:true,logger:r=>logs.push(r)},()=>Date.UTC(2099,8,20));
 const input={from:'AAA',to:'CCC',date,classes:['SL'],mode:'STANDARD'};
 const r=await service.search(input),d=r.diagnostics!,j=r.results[0];
 assert.equal(calls.length,3);assert.equal(d.providerAvailabilityCalls,3);assert.equal(d.providerCallBudgetRemaining,0);assert.equal(d.providerCallBudgetExhausted,true);
 assert.equal(d.budgetLimit,32768);assert.ok(d.budgetRemaining>0);assert.ok(d.logicalAvailabilityChecks>=3);
 assert.equal(j.status,'INVENTORY_CHECK_INCOMPLETE');assert.equal(j.reservedCoverageRatio,1/3);assert.equal(j.unknownDistanceKm,200);
 assert.deepEqual(j.legs[0].segments.map(s=>[s.type,s.fromStation,s.toStation]),[['RESERVED','AAA','XXX']]);
 assert.equal(logs.find(l=>l.event==='journey_v2_search_completed')!.providerAvailabilityCalls,3);
 const again=await service.search(input);assert.equal(calls.length,6);assert.equal(again.diagnostics!.providerAvailabilityCalls,3);
});

test('unprotected V2 service also enforces the configured cap',async t=>{
 let calls=0;const provider={getAvailability:async(r:AvailabilityRequest):Promise<AvailabilityResult>=>{calls++;return {request:r,provider:'railkit',providerState:'SUCCESS',days:[{date,state:'WAITLIST'}]};}};
 const r=await new JourneyV2ApiService(fixture(t),provider,{diagnostics:true,providerCallBudgetLimit:3}).search({from:'AAA',to:'CCC',date,classes:'ALL'});
 assert.equal(calls,3);assert.equal(r.diagnostics!.providerAvailabilityCalls,3);assert.equal(r.results[0].status,'INVENTORY_CHECK_INCOMPLETE');
 assert.equal(r.results[0].reservedCoverageRatio,0);
});


test('fresh unsupported-class cache evidence costs no provider calls',async t=>{
 const h=mock(t,async()=>new Response(JSON.stringify({success:false,error:'Class does not exist in this train for this train route'}),{status:400}));
 await h.provider.getAvailability(request);
 const session=new AvailabilitySession(h.provider,100,new AvailabilityProviderBudget(3));
 const check=await session.get(request);
 assert.equal(check.status,'UNSUPPORTED_CLASS');assert.equal(session.statistics().unsupportedEvidenceCacheHits,1);
 assert.equal(session.statistics().providerAvailabilityCalls,0);assert.equal(h.calls(),1);
});

test('process quota denial does not spend the independent search provider budget',async t=>{
 const h=mock(t),scheduler=new AvailabilityScheduler({...config(),burst:1}),provider=new RailKitProvider(scheduler),budget=new AvailabilityProviderBudget(3);
 await withAvailabilityProviderBudget(budget,()=>provider.getAvailability(request));
 const denied=await withAvailabilityProviderBudget(budget,()=>provider.getAvailability(unique(9)));
 assert.equal(denied.failureCategory,'RATE_LIMITED');assert.equal(h.calls(),1);
 assert.equal(scheduler.quota.snapshot().monthlyUsed,1);assert.equal(budget.statistics().providerAvailabilityCalls,1);
 assert.equal(budget.statistics().providerCallBudgetExhausted,false);
});

test('a cancelled queued leader transfers accounting to the live executing follower',async t=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
 const h=mock(t,async()=>{await gate;return new Response(JSON.stringify({success:true,data:{availability:[{date,status:'AVAILABLE'}]}}));});
 const provider=new RailKitProvider(new AvailabilityScheduler({...config(),providerConcurrency:1}));
 const blocker=new AvailabilityProviderBudget(1),leader=new AvailabilityProviderBudget(1),follower=new AvailabilityProviderBudget(1),abort=new AbortController();
 const first=withAvailabilityProviderBudget(blocker,()=>provider.getAvailability(unique(10)));
 const second=withAvailabilityProviderBudget(leader,()=>inAvailabilityScope(abort.signal,()=>provider.getAvailability(request)));
 const third=withAvailabilityProviderBudget(follower,()=>provider.getAvailability(request));
 abort.abort(new Error('owner left'));release();await Promise.all([first,second,third]);
 assert.equal(h.calls(),2);assert.equal(blocker.statistics().providerAvailabilityCalls,1);
 assert.equal(leader.statistics().providerAvailabilityCalls,0);assert.equal(follower.statistics().providerAvailabilityCalls,1);
});

test('protected RailKit V2 reports only real admitted owners, including warm-search reuse',async t=>{
 const h=mock(t,async()=>new Response(JSON.stringify({success:true,data:{availability:[{date,status:'WAITLIST'}]}})));
 const service=new ProtectedJourneyService(fixture(t),h.provider,{...config(),providerCallBudgetLimit:3},{diagnostics:true},()=>Date.UTC(2099,8,20));
 const input={from:'AAA',to:'CCC',date,classes:['SL']};
 const first=await service.search(input);assert.equal(h.calls(),3);assert.equal(first.diagnostics!.providerAvailabilityCalls,3);
 const second=await service.search(input);assert.equal(second.diagnostics!.providerAvailabilityCalls,3);
 assert.equal(second.diagnostics!.sharedCacheHits,3);assert.equal(second.diagnostics!.logicalAvailabilityChecks,7);assert.equal(second.diagnostics!.cacheHits,1);assert.equal(h.calls(),6);
 assert.equal(second.diagnostics!.actualSdkInvocations,3);
});

test('indirect inventory uses the budget left by direct and same-train work',async t=>{
 const {JourneyRecoveryOrchestrator}=await import('../journey/availability/journey/orchestrator.js');
 const {LocalJourneyPlannerV2}=await import('../local-railway/planner/v2/planner.js');
 const db=fixture(t),direct=new LocalJourneyPlannerV2(db).search({from:'AAA',to:'CCC',date}).journeys[0],leg=direct.segments[0];
 const indirect={...direct,changes:1,segments:[{...leg,trainNumber:'31001',to:'XXX',toStation:'XXX',distanceKm:100},{...leg,trainNumber:'31002',from:'XXX',fromStation:'XXX',distanceKm:200}],connections:[{station:'XXX',minutes:60,safety:'GOOD' as const}]};
 const calls:AvailabilityRequest[]=[];
 const provider={getAvailability:async(r:AvailabilityRequest):Promise<AvailabilityResult>=>{calls.push(r);return {request:r,provider:'railkit',providerState:'SUCCESS',days:[{date,state:r.trainNumber==='30001'?'WAITLIST':'AVAILABLE'}]};}};
 const r=await new JourneyRecoveryOrchestrator(db,provider,{providerCallBudgetLimit:3,maxRecoveryRequestsPerCandidate:1}).validate({source:'AAA',destination:'CCC',journeyDate:date,requestedClasses:['SL'],plannerCandidates:[indirect,direct]});
 assert.equal(calls.length,3);assert.equal(calls.filter(r=>r.trainNumber==='30001').length,2);
 assert.equal(calls.filter(r=>r.trainNumber!=='30001').length,1);assert.equal(r.diagnostics.providerAvailabilityCalls,3);
 assert.equal(r.diagnostics.providerCallBudgetExhausted,true);assert.equal(r.diagnostics.indirectLaneStarted,true);
 assert.ok(r.journeys.every(j=>!j.journeyStatus.startsWith('FULLY_RESERVED')));
});


test('retry quota denial retains RATE_LIMITED and does not debit the search twice',async t=>{
 const {PublicError}=await import('../application/errors.js');
 const h=mock(t),budget=new AvailabilityProviderBudget(3);let admissions=0,category:string|undefined;
 installAvailabilityAbortTransport();
 await assert.rejects(withAvailabilityProviderBudget(budget,()=>inAvailabilityScope(new AbortController().signal,()=>invokeAvailabilityProvider(()=>{
  if(admissions===1)throw new PublicError('RATE_LIMITED','Quota exhausted',429);admissions++;
 },async()=>{await fetch('https://offline.invalid/availability');await fetch('https://offline.invalid/availability');}),{onFailure:value=>{category=value;}})),/Quota exhausted/);
 assert.equal(category,'RATE_LIMITED');assert.equal(h.calls(),1);assert.equal(budget.statistics().providerAvailabilityCalls,1);
 assert.equal(budget.statistics().providerCallBudgetExhausted,false);
});

test('restoring an already installed transport does not double-wrap or double-charge it',async t=>{
 const h=mock(t);installAvailabilityAbortTransport();const installed=globalThis.fetch;
 globalThis.fetch=async()=>new Response('{}');installAvailabilityAbortTransport();
 globalThis.fetch=installed;installAvailabilityAbortTransport();
 const budget=new AvailabilityProviderBudget(3);
 await withAvailabilityProviderBudget(budget,()=>inAvailabilityScope(new AbortController().signal,()=>invokeAvailabilityProvider(()=>{},async()=>{await fetch('https://offline.invalid/availability');})));
 assert.equal(h.calls(),1);assert.equal(budget.statistics().providerAvailabilityCalls,1);
});
