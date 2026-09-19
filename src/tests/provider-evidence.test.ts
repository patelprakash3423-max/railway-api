import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {AvailabilityScheduler} from '../providers/railkit/availability-scheduler.js';
import {RailKitProvider} from '../providers/railkit/railkit-provider.js';
import {AvailabilitySession} from '../journey/availability/session.js';
import {normalizeAvailability,availabilityFailure} from '../providers/railkit/railkit-normalizers.js';
import {normalizeInventory,usable} from '../journey/availability/inventory.js';
import {hardeningConfig} from '../config/hardening.js';
import type {AvailabilityRequest} from '../domain/types/availability.js';
import type {ProviderFailureCategory} from '../domain/types/provider-failure.js';
const request:AvailabilityRequest={trainNumber:'30001',fromStationCode:'AAA',toStationCode:'CCC',journeyDate:'20-09-2099',travelClass:'3A',quota:'GN'};
const unsupported='Class does not exist in this train for this train route';
function payload(status='AVAILABLE',canBook?:boolean,train:Record<string,unknown>={}){
 return {success:true,data:{train,availability:[{date:request.journeyDate,status,canBook}]}};
}
function mockedProvider(t:TestContext,fetcher:typeof fetch,timeout=1000){
 const previousFetch=globalThis.fetch,previousKey=process.env.RAILKIT_API_KEY;
 process.env.RAILKIT_API_KEY='offline-evidence-test';globalThis.fetch=fetcher;
 t.after(()=>{globalThis.fetch=previousFetch;if(previousKey===undefined)delete process.env.RAILKIT_API_KEY;else process.env.RAILKIT_API_KEY=previousKey;});
 return new RailKitProvider(new AvailabilityScheduler({...hardeningConfig({}),providerTimeoutMs:timeout}));
}
const cases:[number,string,ProviderFailureCategory][]=[
 [400,unsupported,'UNSUPPORTED_CLASS'],[400,'Bad request','INVALID_REQUEST'],[401,unsupported,'AUTHENTICATION_FAILED'],
 [403,unsupported,'ACCESS_DENIED'],[429,unsupported,'RATE_LIMITED'],[500,unsupported,'PROVIDER_SERVER_ERROR'],[503,'Service failed','PROVIDER_SERVER_ERROR'],
 [200,'Unrecognized failure','UNKNOWN_PROVIDER_ERROR'],
];
for(const [status,error,category] of cases)test(`HTTP ${status} / ${category} survives SDK, shared fan-out, JSON and session`,async t=>{
 let calls=0;
 const provider=mockedProvider(t,async()=>{calls++;return new Response(JSON.stringify({success:false,error}),{status});});
 const a=new AvailabilitySession(provider,3),b=new AvailabilitySession(provider,3);
 const checks=await Promise.all([a.get(request),b.get(request)]);
 assert.equal(calls,1);assert.equal(b.statistics().sharedInflightHits,1);
 for(const [i,check] of checks.entries()){
  assert.equal(check.status,category==='UNSUPPORTED_CLASS'?'UNSUPPORTED_CLASS':'PROVIDER_ERROR');
  assert.equal(check.errorCategory,category);assert.equal(usable(check),false);
  assert.equal(check.rawDetails?.transportEvidence?.statusCode,status);
  const copied=JSON.parse(JSON.stringify(check.rawDetails));
  assert.equal(normalizeInventory(request,copied).errorCategory,category);
  const stats=[a,b][i].statistics();assert.equal(stats.unavailableResponses,0);
  assert.equal(stats.providerRateLimited,category==='RATE_LIMITED'?1:0);
 }
 const c=new AvailabilitySession(provider,1);await c.get(request);assert.equal(calls,category==='UNSUPPORTED_CLASS'?1:2,'only exact unsupported evidence is retained across searches');
 assert.equal(c.statistics().unsupportedEvidenceCacheHits,category==='UNSUPPORTED_CLASS'?1:0);
});
for(const status of [400,401,403,429,500])test(`non-enumerable SDK status ${status} is captured before cloning`,async()=>{
 const value=Object.defineProperty({success:false,error:unsupported},'statusCode',{value:status,enumerable:false});
 assert.equal(Object.keys(value).includes('statusCode'),false);
 const scheduler=new AvailabilityScheduler(hardeningConfig({}));
 const raw=await scheduler.execute(request,async()=>value);
 const result=normalizeAvailability(raw,request);
 assert.equal(result.transportEvidence?.statusCode,status);
 assert.equal(result.failureCategory,cases.find(c=>c[0]===status)![2]);
 assert.deepEqual(result.days,[]);
 // Direct normalization must also work without the scheduler.
 assert.equal(normalizeAvailability(value,request).transportEvidence?.statusCode,status);
});
test('thrown non-enumerable transport error also retains status and exact unsupported evidence',async()=>{
 const scheduler=new AvailabilityScheduler(hardeningConfig({}));
 const error=Object.defineProperty(new Error(unsupported),'statusCode',{value:400});
 const result=await scheduler.execute(request,async()=>{throw error;}).then(value=>normalizeAvailability(value,request),error=>availabilityFailure(request,error));
 assert.equal(result.transportEvidence?.statusCode,400);assert.equal(result.failureCategory,'UNSUPPORTED_CLASS');
});
for(const status of [400,401,403,429,500])test(`success-shaped HTTP ${status} is never usable`,async t=>{
 const provider=mockedProvider(t,async()=>new Response(JSON.stringify(payload()),{status}));
 const session=new AvailabilitySession(provider,1);const check=await session.get(request);
 assert.equal(check.status,'PROVIDER_ERROR');assert.equal(session.statistics().unavailableResponses,0);
});
test('network failure is preserved before SDK generic-message conversion',async t=>{
 const provider=mockedProvider(t,async()=>{throw new TypeError('fetch failed: PRIVATE_NETWORK_DETAILS');});
 const session=new AvailabilitySession(provider,1),check=await session.get(request);
 assert.equal(check.errorCategory,'NETWORK_FAILURE');assert.equal(check.status,'PROVIDER_ERROR');
 assert.equal(session.statistics().unavailableResponses,0);assert.ok(!JSON.stringify(check).includes('PRIVATE'));
});
test('fetch TimeoutError counts once and remains unverified',async t=>{
 const provider=mockedProvider(t,async()=>{throw new DOMException('private timeout','TimeoutError');});
 const session=new AvailabilitySession(provider,1),check=await session.get(request);
 assert.equal(check.errorCategory,'PROVIDER_TIMEOUT');assert.equal(check.status,'PROVIDER_ERROR');assert.equal(session.statistics().providerTimeouts,1);
});
test('scheduler timeout retains its category and increments diagnostics exactly once',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let release!:(r:Response)=>void;
 const provider=mockedProvider(t,()=>new Promise<Response>(r=>{release=r;}),10);
 const session=new AvailabilitySession(provider,1),pending=session.get(request);
 await new Promise<void>(r=>setImmediate(r));t.mock.timers.tick(10);
 const check=await pending;assert.equal(check.errorCategory,'PROVIDER_TIMEOUT');assert.equal(check.status,'PROVIDER_ERROR');
 assert.equal(session.statistics().providerTimeouts,1);assert.equal(session.statistics().unavailableResponses,0);
 release(new Response(JSON.stringify(payload())));await new Promise<void>(r=>setImmediate(r));
});
for(const body of ['not JSON','null','{}',JSON.stringify({success:true,data:{availability:'invalid'}})])test(`invalid response ${body} remains invalid`,async t=>{
 const provider=mockedProvider(t,async()=>new Response(body));
 const session=new AvailabilitySession(provider,1),check=await session.get(request);
 assert.equal(check.errorCategory,'INVALID_PROVIDER_RESPONSE');assert.equal(check.status,'PROVIDER_ERROR');
 assert.equal(session.statistics().unavailableResponses,0);
});
for(const status of ['AVAILABLE','RAC'])for(const canBook of [false,true,undefined])test(`${status} canBook=${canBook} coverage and shared-cache policy`,async t=>{
 let calls=0;const provider=mockedProvider(t,async()=>{calls++;return new Response(JSON.stringify(payload(status,canBook)));});
 for(let i=0;i<2;i++){
  const session=new AvailabilitySession(provider,1),check=await session.get(request);
  assert.equal(usable(check),canBook!==false);assert.equal(check.status,canBook===false?'PROVIDER_ERROR':status);
  assert.equal(session.statistics().unavailableResponses,0);
 }
 assert.equal(calls,canBook===false?2:1);
 // Also guard normalized results from alternate provider implementations.
 const result=normalizeAvailability(payload(status,canBook),request);
 assert.equal(usable(normalizeInventory(request,result)),canBook!==false);
});
const identity={trainNo:request.trainNumber,from:request.fromStationCode,to:request.toStationCode,travelClass:request.travelClass,quota:request.quota,journeyDate:request.journeyDate};
for(const [field,wrong] of Object.entries({trainNo:'30002',from:'BBB',to:'DDD',travelClass:'SL',quota:'TQ',journeyDate:'21-09-2099'}))test(`conflicting returned ${field} is unverified and not shared-cached`,async t=>{
 let calls=0;const provider=mockedProvider(t,async()=>{calls++;return new Response(JSON.stringify(payload('AVAILABLE',true,{...identity,[field]:wrong})));});
 for(let i=0;i<2;i++){
  const check=await new AvailabilitySession(provider,1).get(request);
  assert.equal(check.status,'PROVIDER_ERROR');assert.equal(check.errorCategory,'INVALID_PROVIDER_RESPONSE');assert.equal(usable(check),false);
 }
 assert.equal(calls,2);
});
test('missing optional identity and normalized matching codes/dates are accepted',()=>{
 for(const train of [{},{...identity,from:' aaa ',to:'ccc',travelClass:'3a',quota:'gn',journeyDate:'2099-09-20'}]){
  assert.equal(usable(normalizeInventory(request,normalizeAvailability(payload('AVAILABLE',true,train),request))),true);
 }
 const value=payload();Object.assign(value.data,{journeyDate:'2099-09-21'});
 assert.equal(normalizeAvailability(value,request).failureCategory,'INVALID_PROVIDER_RESPONSE');
});
test('unsupported-class evidence never excludes the train class for another route/date',async t=>{
 let calls=0;const provider=mockedProvider(t,async()=>{calls++;return new Response(JSON.stringify(calls===1?{success:false,error:unsupported}:payload()),{status:calls===1?400:200});});
 const session=new AvailabilitySession(provider,4);
 const first=await session.get(request);assert.equal(first.unsupportedScope,'EXACT_REQUEST');assert.equal(session.unsupported.size,0);
 assert.equal((await session.get({...request,fromStationCode:'BBB'})).status,'AVAILABLE');
 assert.equal((await session.get(request)).status,'UNSUPPORTED_CLASS');assert.equal(calls,2);
 const next=await session.get({...request,journeyDate:'21-09-2099'});
 assert.equal(next.errorCategory,'INVALID_PROVIDER_RESPONSE');assert.equal(calls,3,'a different date still reaches the provider');assert.equal(session.unsupported.size,0);
});
test('arbitrary error bodies, credentials and headers never enter normalized evidence',async t=>{
 const secret='Bearer OTHER_SECRET';
 const provider=mockedProvider(t,async()=>new Response(JSON.stringify({success:false,error:`${secret} offline-evidence-test`,authorization:secret,raw:'PRIVATE_BODY'}),{status:400,headers:{authorization:secret}}));
 const result=await provider.getAvailability(request),serialized=JSON.stringify(result);
 for(const forbidden of ['OTHER_SECRET','offline-evidence-test','PRIVATE_BODY','authorization'])assert.ok(!serialized.includes(forbidden));
 assert.equal(result.failureCategory,'INVALID_REQUEST');
});
