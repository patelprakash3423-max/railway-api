import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {AvailabilityScheduler} from '../providers/railkit/availability-scheduler.js';
import {RailKitProvider} from '../providers/railkit/railkit-provider.js';
import {AvailabilitySession} from '../journey/availability/session.js';
import {availabilityRequestKey} from '../utils/availability-key.js';
import {requestKey} from '../journey/availability/inventory.js';
import {hardeningConfig} from '../config/hardening.js';
import {inAvailabilityScope} from '../providers/railkit/availability-abort.js';
import {emptyAvailabilityMetrics,observeAvailabilityMetrics} from '../providers/availability-observation.js';
import {normalizeAvailability} from '../providers/railkit/railkit-normalizers.js';
import type {AvailabilityRequest} from '../domain/types/availability.js';
const request:AvailabilityRequest={trainNumber:'12345',fromStationCode:'NDLS',toStationCode:'CNB',journeyDate:'25-09-2099',travelClass:'SL',quota:'GN'};
const unsupported=()=>({success:false,error:'Class does not exist in this train for this train route'});
const inventory=(status:string)=>({success:true,data:{availability:[{date:request.journeyDate,status}]}});
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};}
function mocked(t:TestContext,fetcher:typeof fetch,config=hardeningConfig({}),now=Date.now){
 const key=process.env.RAILKIT_API_KEY,fetch=globalThis.fetch;
 process.env.RAILKIT_API_KEY='offline-unsupported-test';globalThis.fetch=fetcher;
 t.after(()=>{globalThis.fetch=fetch;if(key===undefined)delete process.env.RAILKIT_API_KEY;else process.env.RAILKIT_API_KEY=key;});
 const scheduler=new AvailabilityScheduler(config,now);
 return {scheduler,provider:new RailKitProvider(scheduler)};
}
test('cross-search unsupported reuse costs one check but zero SDK/quota; local reuse costs no new check',async t=>{
 let calls=0;
 const {provider,scheduler}=mocked(t,async()=>{calls++;return new Response(JSON.stringify(unsupported()),{status:400});},{...hardeningConfig({}),monthly:1,burst:1});
 const first=new AvailabilitySession(provider,30);assert.equal((await first.get(request)).status,'UNSUPPORTED_CLASS');
 assert.equal(first.statistics().actualSdkInvocations,1);assert.equal(first.statistics().providerUnsupportedResponses,1);
 const second=new AvailabilitySession(provider,30),check=await second.get(request);
 assert.equal(check.status,'UNSUPPORTED_CLASS');assert.equal(check.unsupportedScope,'EXACT_REQUEST');
 assert.equal(second.statistics().unsupportedEvidenceCacheHits,1);assert.equal(second.statistics().actualSdkInvocations,0);
 assert.equal(second.statistics().attemptedAvailabilityChecks,1);assert.equal(second.statistics().budgetRemaining,29);
 assert.equal(second.statistics().sharedCacheHits,0);assert.equal(second.statistics().unsupportedClassSkips,0);
 assert.equal(second.statistics().providerUnsupportedResponses,0);assert.equal(second.statistics().unsupportedClassResponses,1);
 assert.equal(second.unsupported.size,0);assert.equal(first.unsupported.size,0);
 await second.get(request);assert.equal(second.statistics().cacheHits,1);assert.equal(second.statistics().attemptedAvailabilityChecks,1);
 assert.equal(second.statistics().unsupportedEvidenceCacheHits,1);assert.equal(calls,1);
 assert.deepEqual(scheduler.quota.snapshot(),{monthlyUsed:1,burstUsed:1,reservedProviderCalls:0});
});
for(const patch of [{fromStationCode:'GZB'},{toStationCode:'HWH'},{journeyDate:'26-09-2099'},{travelClass:'3A'},{trainNumber:'12346'}])test(`unsupported evidence does not leak to ${JSON.stringify(patch)}`,async t=>{
 let calls=0;const {provider}=mocked(t,async()=>{calls++;return new Response(JSON.stringify(unsupported()),{status:400});});
 await new AvailabilitySession(provider,30).get(request);
 const session=new AvailabilitySession(provider,30);await session.get({...request,...patch});
 assert.equal(calls,2);assert.equal(session.statistics().actualSdkInvocations,1);assert.equal(session.statistics().unsupportedEvidenceCacheHits,0);
});
test('quota key is independent at scheduler boundary; GN-only public validation is not expanded',async()=>{
 const scheduler=new AvailabilityScheduler(hardeningConfig({}));let invocations=0;
 const invoke=async()=>{invocations++;return unsupported();};
 await scheduler.execute(request,invoke);
 await scheduler.execute({...request,quota:'TQ'} as unknown as AvailabilityRequest,invoke);
 assert.equal(invocations,2);
 await scheduler.execute(request,invoke);assert.equal(invocations,2);
});
test('canonical key is shared, normalizes safe equivalents and preserves leading zeroes and invalid dates',async()=>{
 assert.equal(requestKey,availabilityRequestKey);
 const equivalent={...request,trainNumber:' 12345 ',fromStationCode:' ndls ',toStationCode:'cnb',journeyDate:'2099-09-25',travelClass:' sl ',quota:' gn '} as unknown as AvailabilityRequest;
 assert.equal(requestKey(request),requestKey(equivalent));
 assert.equal(requestKey({...request,journeyDate:'5-9-2099'}),requestKey({...request,journeyDate:'05-09-2099'}));
 assert.notEqual(requestKey({...request,trainNumber:'01234'}),requestKey({...request,trainNumber:'1234'}));
 assert.notEqual(requestKey({...request,journeyDate:'31-02-2099'}),requestKey({...request,journeyDate:'03-03-2099'}));
 let calls=0;const scheduler=new AvailabilityScheduler(hardeningConfig({})),invoke=async()=>{calls++;return unsupported();};
 await scheduler.execute(request,invoke);await scheduler.execute(equivalent,invoke);assert.equal(calls,1);
});
test('TTL expires at the boundary; hits do not extend it and returned data cannot mutate evidence',async t=>{
 let time=0,calls=0;const {provider}=mocked(t,async()=>{calls++;return new Response(JSON.stringify(unsupported()),{status:400});},{...hardeningConfig({}),unsupportedCacheTtlMs:100},()=>time);
 await provider.getAvailability(request);time=99;
 const hit=await provider.getAvailability(request);hit.transportEvidence!.failureCategory='RATE_LIMITED';
 assert.equal((await provider.getAvailability(request)).failureCategory,'UNSUPPORTED_CLASS');assert.equal(calls,1);
 time=100;await provider.getAvailability(request);assert.equal(calls,2);
});
test('bounded FIFO eviction is deterministic and hits do not refresh insertion order',async()=>{
 const scheduler=new AvailabilityScheduler({...hardeningConfig({}),unsupportedCacheEntries:2});
 const calls:string[]=[];const run=(trainNumber:string)=>scheduler.execute({...request,trainNumber},async()=>{calls.push(trainNumber);return unsupported();});
 await run('12345');await run('12346');await run('12345');await run('12347');await run('12346');
 assert.deepEqual(calls,['12345','12346','12347']);
 await run('12345');assert.deepEqual(calls,['12345','12346','12347','12345']);
 for(let i=0;i<20;i++)await run(String(20000+i));
 // Every insertion evicts the oldest; both most recent entries remain cached.
 const before=calls.length;await run('20018');await run('20019');assert.equal(calls.length,before);
 await run('20017');assert.equal(calls.length,before+1);
});
for(const status of [400,401,403,429,500])test(`HTTP ${status} generic failures never persist as unsupported`,async t=>{
 let calls=0;const {provider}=mocked(t,async()=>{calls++;return new Response(JSON.stringify({success:false,error:'Generic failure'}),{status});});
 for(let i=0;i<2;i++){
  const session=new AvailabilitySession(provider,30);assert.equal((await session.get(request)).status,'PROVIDER_ERROR');
  assert.equal(session.statistics().unsupportedEvidenceCacheHits,0);
 }
 assert.equal(calls,2);
});
for(const kind of ['NETWORK','INVALID_JSON','UNKNOWN'] as const)test(`${kind} failures never persist as unsupported`,async t=>{
 let calls=0;const {provider}=mocked(t,async()=>{calls++;if(kind==='NETWORK')throw new TypeError('fetch failed');return new Response(kind==='INVALID_JSON'?'invalid':JSON.stringify({success:false,error:'Unknown failure'}));});
 for(let i=0;i<2;i++)assert.equal((await new AvailabilitySession(provider,30).get(request)).status,'PROVIDER_ERROR');
 assert.equal(calls,2);
});
test('timeout and late unsupported completion do not poison the cache',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const response=deferred<Response>();let calls=0;
 const {provider}=mocked(t,async()=>{calls++;return calls===1?response.promise:new Response(JSON.stringify(unsupported()),{status:400});},{...hardeningConfig({}),providerTimeoutMs:10});
 const first=new AvailabilitySession(provider,30),pending=first.get(request);await tick();t.mock.timers.tick(10);
 assert.equal((await pending).errorCategory,'PROVIDER_TIMEOUT');
 response.resolve(new Response(JSON.stringify(unsupported()),{status:400}));await tick();
 const second=new AvailabilitySession(provider,30);await second.get(request);assert.equal(calls,2);assert.equal(second.statistics().unsupportedEvidenceCacheHits,0);
});
for(const status of ['NOT_AVAILABLE','WAITLIST','AVAILABLE','RAC'])test(`${status} keeps inventory TTL and never uses unsupported retention`,async t=>{
 let time=0,calls=0;const {provider}=mocked(t,async()=>{calls++;return new Response(JSON.stringify(inventory(status)));},{...hardeningConfig({}),providerCacheTtlMs:10,unsupportedCacheTtlMs:1000},()=>time);
 await new AvailabilitySession(provider,30).get(request);
 const hit=new AvailabilitySession(provider,30);await hit.get(request);assert.equal(hit.statistics().sharedCacheHits,1);assert.equal(hit.statistics().unsupportedEvidenceCacheHits,0);
 time=10;await new AvailabilitySession(provider,30).get(request);assert.equal(calls,2);
});
test('inventory and unsupported capacity policies do not evict each other',async()=>{
 const scheduler=new AvailabilityScheduler({...hardeningConfig({}),providerCacheEntries:1,unsupportedCacheEntries:1});let calls=0;
 const run=(travelClass:string,value:unknown)=>scheduler.execute({...request,travelClass},async()=>{calls++;return value;});
 await run('SL',unsupported());await run('3A',inventory('AVAILABLE'));await run('2A',inventory('RAC'));await run('SL',unsupported());
 assert.equal(calls,3);await run('CC',unsupported());await run('2A',inventory('RAC'));assert.equal(calls,4);
});
test('concurrent sessions share one unsupported SDK result; later search uses evidence cache',async t=>{
 const response=deferred<Response>();let calls=0;const {provider}=mocked(t,async()=>{calls++;return response.promise;});
 const a=new AvailabilitySession(provider,30),b=new AvailabilitySession(provider,30);
 const one=a.get(request),two=b.get(request);await tick();assert.equal(calls,1);
 response.resolve(new Response(JSON.stringify(unsupported()),{status:400}));
 assert.equal((await one).status,'UNSUPPORTED_CLASS');assert.equal((await two).status,'UNSUPPORTED_CLASS');
 assert.equal(a.statistics().actualSdkInvocations,1);assert.equal(b.statistics().actualSdkInvocations,0);assert.equal(b.statistics().sharedInflightHits,1);
 assert.equal(a.statistics().providerUnsupportedResponses,1);assert.equal(b.statistics().providerUnsupportedResponses,0);
 const c=new AvailabilitySession(provider,30);await c.get(request);assert.equal(c.statistics().unsupportedEvidenceCacheHits,1);assert.equal(c.statistics().actualSdkInvocations,0);assert.equal(calls,1);
});
test('cancelling one waiter preserves followers and subsequent unsupported reuse',async t=>{
 const response=deferred<Response>();let calls=0;const {provider}=mocked(t,async()=>{calls++;return response.promise;});
 const controller=new AbortController();const one=inAvailabilityScope(controller.signal,()=>provider.getAvailability(request));
 const two=provider.getAvailability(request);controller.abort(new Error('cancelled'));
 assert.equal((await one).providerState,'PROVIDER_ERROR');response.resolve(new Response(JSON.stringify(unsupported()),{status:400}));
 assert.equal((await two).failureCategory,'UNSUPPORTED_CLASS');
 const next=new AvailabilitySession(provider,30);await next.get(request);assert.equal(next.statistics().unsupportedEvidenceCacheHits,1);assert.equal(calls,1);
});
test('all waiters cancelled cannot publish late unsupported evidence',async()=>{
 const scheduler=new AvailabilityScheduler(hardeningConfig({})),controller=new AbortController(),result=deferred<unknown>();let calls=0;
 const pending=inAvailabilityScope(controller.signal,()=>scheduler.execute(request,()=>{calls++;return result.promise;}));
 const rejected=assert.rejects(pending);controller.abort();await rejected;result.resolve(unsupported());await tick();
 await scheduler.execute(request,async()=>{calls++;return unsupported();});assert.equal(calls,2);
});
test('fresh unknown classes still reach provider; evidence does not learn train-wide exclusions',async t=>{
 let calls=0;const {provider}=mocked(t,async()=>{calls++;return new Response(JSON.stringify(calls===1?unsupported():inventory('AVAILABLE')),{status:calls===1?400:200});});
 const first=new AvailabilitySession(provider,30);await first.get(request);
 const second=new AvailabilitySession(provider,30);await second.get(request);
 assert.equal((await second.get({...request,travelClass:'3A'})).status,'AVAILABLE');assert.equal(calls,2);assert.equal(second.unsupported.size,0);
});
test('thrown recognized evidence also replays safely with non-enumerable status',async()=>{
 const scheduler=new AvailabilityScheduler(hardeningConfig({}));let calls=0;
 const invoke=async()=>{calls++;throw Object.defineProperty(new Error(unsupported().error),'statusCode',{value:400});};
 await assert.rejects(scheduler.execute(request,invoke));
 const metrics=emptyAvailabilityMetrics();const value=await observeAvailabilityMetrics((k,n)=>{metrics[k]+=n;},()=>scheduler.execute(request,invoke));
 assert.equal(normalizeAvailability(value,request).failureCategory,'UNSUPPORTED_CLASS');assert.equal(metrics.unsupportedEvidenceCacheHits,1);assert.equal(calls,1);
});
test('warm unsupported cache cannot bypass configuration checks',async t=>{
 let calls=0;const {provider}=mocked(t,async()=>{calls++;return new Response(JSON.stringify(unsupported()),{status:400});});
 await provider.getAvailability(request);delete process.env.RAILKIT_API_KEY;
 await assert.rejects(provider.getAvailability(request),{code:'PROVIDER_CONFIGURATION_ERROR'});assert.equal(calls,1);
});
test('unsupported config defaults, upper bounds and invalid values follow fail-fast policy',()=>{
 const config=hardeningConfig({});assert.equal(config.unsupportedCacheTtlMs,900000);assert.equal(config.unsupportedCacheEntries,1000);
 for(const [key,max] of [['RAILKIT_UNSUPPORTED_CACHE_TTL_MS',86400000],['RAILKIT_UNSUPPORTED_CACHE_MAX_ENTRIES',10000]] as const){
  for(const value of ['0','-1','1.5','NaN','Infinity',String(max+1),String(Number.MAX_SAFE_INTEGER+1)])assert.throws(()=>hardeningConfig({[key]:value}),new RegExp(key));
  assert.doesNotThrow(()=>hardeningConfig({[key]:String(max)}));assert.doesNotThrow(()=>hardeningConfig({[key]:'1'}));
 }
});
