import test from 'node:test';
import assert from 'node:assert/strict';
import {AvailabilityScheduler} from '../providers/railkit/availability-scheduler.js';
import {RailKitProvider} from '../providers/railkit/railkit-provider.js';
import {hardeningConfig} from '../config/hardening.js';
import {SearchProtection,clientIdentity} from '../api/search-protection.js';
import {AvailabilitySession} from '../journey/availability/session.js';
import {guardedProvider} from '../api/services/protected-journey-service.js';
import {inAvailabilityScope,availabilitySignal} from '../providers/railkit/availability-abort.js';
import {emptyAvailabilityMetrics,observeAvailabilityMetrics} from '../providers/availability-observation.js';
import type {AvailabilityRequest} from '../domain/types/availability.js';
const request:AvailabilityRequest={trainNumber:'30001',fromStationCode:'AAA',toStationCode:'CCC',journeyDate:'20-09-2099',travelClass:'3A',quota:'GN'};
const payload=(status='AVAILABLE',date=request.journeyDate)=>({success:true,data:{availability:[{date,status}]}});
const tick=()=>new Promise<void>(r=>setImmediate(r));
function deferred<T>(){let resolve!:(v:T)=>void;let reject!:(e:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}

test('untrusted proxy users share all global slots, never a per-client=1 slot or five-search bucket',()=>{
 const limiter=new SearchProtection(hardeningConfig({}));
 const ids=['spoof-a','spoof-b','spoof-c'].map(x=>clientIdentity('127.0.0.1',x));
 assert.equal(new Set(ids).size,1);
 for(let round=0;round<6;round++){
  const leases=ids.map(id=>limiter.acquire(id,30));
  assert.throws(()=>limiter.acquire(clientIdentity('other','spoof-d'),30),{failureCategory:'GLOBAL_CONCURRENCY'});
  assert.equal(limiter.snapshot(ids[0]).reservedProviderCalls,0);
  assert.equal(limiter.snapshot(ids[0]).monthlyUsed,0);
  leases.forEach(l=>l.release());
 }
 const direct=limiter.acquire(clientIdentity('1.2.3.4',undefined,'DIRECT_PEER'),30);
 assert.throws(()=>limiter.acquire('1.2.3.4',30),{failureCategory:'CLIENT_CONCURRENCY'});
 direct.release();
});

test('SDK boundary shares concurrent checks, isolates metrics, caches success and preserves search budgets',async t=>{
 const previousKey=process.env.RAILKIT_API_KEY,previousFetch=globalThis.fetch;
 process.env.RAILKIT_API_KEY='offline-test-placeholder';
 const response=deferred<Response>();let calls=0;
 globalThis.fetch=async()=>{calls++;return response.promise;};
 t.after(()=>{globalThis.fetch=previousFetch;if(previousKey===undefined)delete process.env.RAILKIT_API_KEY;else process.env.RAILKIT_API_KEY=previousKey;});
 const scheduler=new AvailabilityScheduler({...hardeningConfig({}),monthly:1,burst:1});
 const provider=new RailKitProvider(scheduler);
 const a=new AvailabilitySession(provider,1),b=new AvailabilitySession(provider,1);
 const one=a.get(request),two=b.get(request);
 await tick();assert.equal(calls,1);
 response.resolve(new Response(JSON.stringify(payload())));
 assert.equal((await one).status,'AVAILABLE');assert.equal((await two).status,'AVAILABLE');
 assert.equal(a.statistics().actualSdkInvocations+b.statistics().actualSdkInvocations,1);
 assert.equal(b.statistics().sharedInflightHits,1);
 const c=new AvailabilitySession(provider,1);
 assert.equal((await c.get(request)).status,'AVAILABLE');
 assert.equal(c.statistics().sharedCacheHits,1);assert.equal(c.statistics().actualSdkInvocations,0);
 assert.equal(c.statistics().attemptedAvailabilityChecks,1);
 await assert.rejects(c.get({...request,travelClass:'SL'}),/allowance exhausted/);
 const d=new AvailabilitySession(provider,1);
 assert.equal((await d.get({...request,travelClass:'SL'})).status,'PROVIDER_ERROR');
 assert.equal(d.statistics().providerRateLimited,1);
 assert.equal(d.statistics().actualSdkInvocations,0);assert.equal(calls,1);
 assert.deepEqual(scheduler.quota.snapshot(),{monthlyUsed:1,burstUsed:1,reservedProviderCalls:0});
});

test('queue bounds SDK concurrency and rotates all waiting search owners',async()=>{
 let time=0,active=0,max=0;
 const scheduler=new AvailabilityScheduler({...hardeningConfig({}),providerConcurrency:1},()=>time);
 const owners=[new AbortController(),new AbortController(),new AbortController()];
 const starts:string[]=[],releases:(()=>void)[]=[];
 const metrics=emptyAvailabilityMetrics();
 const launch=(owner:number,id:string)=>observeAvailabilityMetrics((k,n)=>{metrics[k]+=n;},()=>inAvailabilityScope(owners[owner].signal,()=>scheduler.execute({...request,trainNumber:id},async()=>{
  active++;max=Math.max(max,active);starts.push(id);
  await new Promise<void>(r=>releases.push(r));active--;return payload();
 })));
 const jobs=[launch(0,'30001'),launch(0,'30002'),launch(0,'30003'),launch(1,'40001'),launch(1,'40002'),launch(2,'50001')];
 await tick();assert.equal(max,1);time=10;
 for(let i=0;i<jobs.length;i++){assert.equal(releases.length,i+1);releases[i]();await tick();}
 await Promise.all(jobs);
 assert.deepEqual(starts,['30001','30002','40001','50001','30003','40002']);
 assert.equal(max,1);assert.equal(metrics.providerQueueWaits,5);assert.equal(metrics.providerQueueWaitMs,50);
});

test('cache exact keys, TTL, bounds and mutation isolation',async()=>{
 let time=0,calls=0;
 const scheduler=new AvailabilityScheduler({...hardeningConfig({}),providerCacheTtlMs:10,providerCacheEntries:2},()=>time);
 const run=(r=request)=>scheduler.execute(r,async()=>{calls++;return payload('AVAILABLE',r.journeyDate);});
 const first=await run() as ReturnType<typeof payload>;first.data.availability[0].status='WAITLIST';
 assert.equal((await run() as ReturnType<typeof payload>).data.availability[0].status,'AVAILABLE');
 assert.equal(calls,1);
 time=10;await run();assert.equal(calls,2);
 for(const patch of [{travelClass:'SL'},{journeyDate:'21-09-2099'},{fromStationCode:'BBB'},{toStationCode:'DDD'},{trainNumber:'30002'}]){
  await run({...request,...patch});
 }
 assert.equal(calls,7);
 await run();assert.equal(calls,8); // Oldest exact key was evicted.
});

for(const status of ['AVAILABLE','RAC','WAITLIST','NOT_AVAILABLE'])test('shared cache explicitly accepts '+status,async()=>{
 const scheduler=new AvailabilityScheduler(hardeningConfig({}));let calls=0;
 const invoke=async()=>{calls++;return payload(status);};
 await scheduler.execute(request,invoke);await scheduler.execute(request,invoke);
 assert.equal(calls,1);
});
for(const value of [{success:false,error:'failure'},payload('UNKNOWN'),payload('AVAILABLE','21-09-2099'),{success:true,data:{availability:[]}},payload('PROVIDER_UNAVAILABLE')])
 test('shared cache rejects unsuccessful or nonmatching evidence '+JSON.stringify(value),async()=>{
  const scheduler=new AvailabilityScheduler(hardeningConfig({}));let calls=0;
  const invoke=async()=>{calls++;return value;};
  await scheduler.execute(request,invoke);await scheduler.execute(request,invoke);assert.equal(calls,2);
 });

test('cancelling the initiating waiter leaves shared work alive for another search',async()=>{
 const scheduler=new AvailabilityScheduler(hardeningConfig({}));
 const a=new AbortController(),b=new AbortController(),result=deferred<unknown>();
 let calls=0,transport:AbortSignal|undefined;
 const invoke=async()=>{calls++;transport=availabilitySignal();return result.promise;};
 const one=inAvailabilityScope(a.signal,()=>scheduler.execute(request,invoke));
 const two=inAvailabilityScope(b.signal,()=>scheduler.execute(request,invoke));
 const rejected=assert.rejects(one,/cancelled/);a.abort(new Error('cancelled'));await rejected;
 assert.equal(transport?.aborted,false);result.resolve(payload());
 assert.deepEqual(await two,payload());assert.equal(calls,1);
});

test('all waiters cancelled abort transport; queued cancellations make zero invocations',async()=>{
 const scheduler=new AvailabilityScheduler({...hardeningConfig({}),providerConcurrency:1});
 const a=new AbortController(),b=new AbortController();
 const pending=deferred<unknown>();let calls=0,transport:AbortSignal|undefined;
 const one=inAvailabilityScope(a.signal,()=>scheduler.execute(request,async()=>{calls++;transport=availabilitySignal();return pending.promise;}));
 const two=inAvailabilityScope(b.signal,()=>scheduler.execute({...request,travelClass:'SL'},async()=>{calls++;return payload();}));
 const rejectedOne=assert.rejects(one),rejectedTwo=assert.rejects(two);
 b.abort();a.abort();await Promise.all([rejectedOne,rejectedTwo]);assert.equal(calls,1);assert.equal(transport?.aborted,true);
 pending.resolve(payload());await tick();
 await scheduler.execute(request,async()=>{calls++;return payload();});assert.equal(calls,2); // No cache from cancelled work.
});

test('timeout retains physical slots until SDK settles and is not cached or claimed as unavailable',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const scheduler=new AvailabilityScheduler({...hardeningConfig({}),providerConcurrency:2,providerTimeoutMs:10});
 const first=deferred<unknown>(),second=deferred<unknown>();let calls=0;
 const metrics=emptyAvailabilityMetrics();
 const one=observeAvailabilityMetrics((k,n)=>{metrics[k]+=n;},()=>scheduler.execute(request,async()=>{calls++;return first.promise;}));
 const two=scheduler.execute({...request,travelClass:'SL'},async()=>{calls++;return second.promise;});
 const third=scheduler.execute({...request,travelClass:'2A'},async()=>{calls++;return payload();});
 const failures=[assert.rejects(one,{code:'PROVIDER_TIMEOUT'}),assert.rejects(two,{code:'PROVIDER_TIMEOUT'})];
 t.mock.timers.tick(10);await Promise.all(failures);
 assert.equal(calls,2);assert.equal(metrics.providerTimeouts,1);
 first.resolve(payload());await tick();await third;assert.equal(calls,3);
 second.resolve(payload());await tick();
 await scheduler.execute(request,async()=>{calls++;return payload();});assert.equal(calls,4);
});

test('provider SDK timeout produces unknown evidence and a truthful timeout counter',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const previousKey=process.env.RAILKIT_API_KEY,previousFetch=globalThis.fetch;
 process.env.RAILKIT_API_KEY='offline-test-placeholder';const response=deferred<Response>();let calls=0;
 globalThis.fetch=async()=>{calls++;return response.promise;};
 t.after(()=>{globalThis.fetch=previousFetch;if(previousKey===undefined)delete process.env.RAILKIT_API_KEY;else process.env.RAILKIT_API_KEY=previousKey;});
 const scheduler=new AvailabilityScheduler({...hardeningConfig({}),providerTimeoutMs:10});
 const session=new AvailabilitySession(new RailKitProvider(scheduler),1);
 const check=session.get(request);await tick();t.mock.timers.tick(10);
 assert.equal((await check).status,'PROVIDER_ERROR');
 assert.equal(session.statistics().providerTimeouts,1);assert.equal(session.statistics().providerErrors,1);
 assert.equal(session.statistics().unavailableResponses,0);assert.equal(calls,1);
 response.resolve(new Response(JSON.stringify(payload())));await tick();
});

test('failed SDK invocations consume quota; rolling burst and UTC month reset independently',()=>{
 let time=Date.UTC(2099,8,20);
 const scheduler=new AvailabilityScheduler({...hardeningConfig({}),monthly:3,burst:2,burstWindowMs:100},()=>time);
 scheduler.quota.consume();scheduler.quota.consume();assert.throws(()=>scheduler.quota.consume(),{code:'RATE_LIMITED'});
 time+=100;scheduler.quota.consume();assert.throws(()=>scheduler.quota.consume(),{code:'RATE_LIMITED'});
 assert.equal(scheduler.quota.snapshot().monthlyUsed,3);
 time=Date.UTC(2099,9,1);scheduler.quota.consume();assert.equal(scheduler.quota.snapshot().monthlyUsed,1);
});

test('new provider settings reject zero, fractional and invalid values',()=>{
 for(const key of ['RAILKIT_AVAILABILITY_MAX_CONCURRENT','RAILKIT_AVAILABILITY_CACHE_TTL_MS','RAILKIT_AVAILABILITY_CACHE_MAX_ENTRIES'])
  for(const value of ['0','-1','1.5','NaN'])assert.throws(()=>hardeningConfig({[key]:value}));
});

for(const status of [429,500])test('HTTP '+status+' cannot become cached inventory even with a success-shaped body',async t=>{
 const previousKey=process.env.RAILKIT_API_KEY,previousFetch=globalThis.fetch;
 process.env.RAILKIT_API_KEY='offline-test-placeholder';let calls=0;
 globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify(payload()),{status});};
 t.after(()=>{globalThis.fetch=previousFetch;if(previousKey===undefined)delete process.env.RAILKIT_API_KEY;else process.env.RAILKIT_API_KEY=previousKey;});
 const scheduler=new AvailabilityScheduler(hardeningConfig({})),provider=new RailKitProvider(scheduler);
 for(let i=0;i<2;i++){
  const session=new AvailabilitySession(provider,1);
  assert.equal((await session.get(request)).status,'PROVIDER_ERROR');
  assert.equal(session.statistics().providerSuccesses,0);
  assert.equal(session.statistics().providerRateLimited,status===429?1:0);
  assert.equal(session.statistics().actualSdkInvocations,1);
 }
 assert.equal(calls,2);assert.equal(scheduler.quota.snapshot().monthlyUsed,2);
});

test('two provider instances use one production scheduler',()=>{
 assert.equal(new RailKitProvider().availabilityScheduler,new RailKitProvider().availabilityScheduler);
});

test('warm shared cache never bypasses local configuration validation',async t=>{
 const previousKey=process.env.RAILKIT_API_KEY,previousFetch=globalThis.fetch;
 process.env.RAILKIT_API_KEY='offline-test-placeholder';let calls=0;
 globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify(payload()));};
 t.after(()=>{globalThis.fetch=previousFetch;if(previousKey===undefined)delete process.env.RAILKIT_API_KEY;else process.env.RAILKIT_API_KEY=previousKey;});
 const scheduler=new AvailabilityScheduler(hardeningConfig({})),provider=new RailKitProvider(scheduler);
 await provider.getAvailability(request);delete process.env.RAILKIT_API_KEY;
 await assert.rejects(provider.getAvailability(request),{code:'PROVIDER_CONFIGURATION_ERROR'});
 assert.equal(calls,1);assert.equal(scheduler.quota.snapshot().monthlyUsed,1);
});

test('last queued initiator may cancel while its follower still executes and owns accounting',async()=>{
 const scheduler=new AvailabilityScheduler({...hardeningConfig({}),providerConcurrency:1});
 const block=deferred<unknown>(),a=new AbortController(),b=new AbortController();
 const first=scheduler.execute({...request,travelClass:'SL'},()=>block.promise);
 let owner:AbortSignal|undefined,calls=0;
 const invoke=async()=>{calls++;owner=availabilitySignal();return payload();};
 const one=inAvailabilityScope(a.signal,()=>scheduler.execute(request,invoke));
 const two=inAvailabilityScope(b.signal,()=>scheduler.execute(request,invoke));
 const failed=assert.rejects(one);a.abort();await failed;
 block.resolve(payload());await first;assert.deepEqual(await two,payload());
 assert.equal(calls,1);assert.equal(owner?.aborted,false);
});
