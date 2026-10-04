import {checkFirstRoute} from '../test-support/selected-route.js';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {availabilityStateConfig} from '../config/availability-state.js';
import {availabilityRedisConfig} from '../config/availability-redis.js';
import {hardeningConfig} from '../config/hardening.js';
import {SqliteAvailabilityObservationStore} from '../providers/observations/sqlite-store.js';
import {AvailabilityObservations} from '../providers/observations/cache.js';
import {AvailabilityFreshnessPolicy} from '../providers/observations/freshness.js';
import {RedisAvailabilityCache,redisObservationKey,type AvailabilityRedisAdapter} from '../providers/observations/redis-cache.js';
import {configuredRedisAvailabilityCache} from '../providers/observations/redis-client.js';
import {makeObservation,observationKey,type AvailabilityObservationStore,type AvailabilityObservation} from '../providers/observations/model.js';
import {normalizeAvailability} from '../providers/railkit/railkit-normalizers.js';
import {RailKitProvider} from '../providers/railkit/railkit-provider.js';
import {AvailabilityScheduler} from '../providers/railkit/availability-scheduler.js';
import {AvailabilitySession} from '../journey/availability/session.js';
import {AvailabilityProviderBudget} from '../providers/availability-provider-budget.js';
import {emptyAvailabilityMetrics,observeAvailabilityMetrics} from '../providers/availability-observation.js';
import type {AvailabilityRequest} from '../domain/types/availability.js';
import {inAvailabilityScope} from '../providers/railkit/availability-abort.js';

const date='20-09-2099',start=Date.UTC(2099,8,1),hour=3600000;
const request:AvailabilityRequest={trainNumber:'30001',fromStationCode:'AAA',toStationCode:'BBB',journeyDate:date,travelClass:'SL',quota:'GN'};
const raw=(state='AVAILABLE',r=request)=>({success:true,data:{availability:[{date:r.journeyDate,status:state,availabilityText:state==='AVAILABLE'?'AVAILABLE 20':state==='WAITLIST'?'WL 12':state}]}});
const observation=(state='AVAILABLE',observedAt=start,r=request)=>makeObservation(normalizeAvailability(raw(state,r),r),observedAt);

class FakeRedis implements AvailabilityRedisAdapter {
 values=new Map<string,string>();
 expirations=new Map<string,number>();
 writes:{key:string;value:string;observedAt:number;expiresAt:number}[]=[];
 reads=0;closed=false;readError=false;writeError=false;
 beforeRead?:()=>Promise<void>;beforeWrite?:()=>Promise<void>;
 async get(key:string,signal:AbortSignal){
  this.reads++;await this.beforeRead?.();signal.throwIfAborted();
  if(this.readError)throw Error('secret Redis URL read failure');
  // Deliberately retain expired entries: application freshness must distrust Redis TTL.
  return this.values.get(key)??null;
 }
 async putIfNewer(key:string,value:string,observedAt:number,expiresAt:number,signal:AbortSignal){
  await this.beforeWrite?.();signal.throwIfAborted();
  if(this.writeError)throw Error('secret Redis URL write failure');
  this.writes.push({key,value,observedAt,expiresAt});
  let previous:AvailabilityObservation|undefined;
  try{previous=JSON.parse(this.values.get(key)??'null');}catch{}
  if(previous&&previous.observedAt>=observedAt)return;
  this.values.set(key,value);
  this.expirations.set(key,expiresAt);
 }
 seed(value:unknown,key=redisObservationKey(request)){this.values.set(key,typeof value==='string'?value:JSON.stringify(value));}
 close(){this.closed=true;}
}
function setup(t:TestContext,options:{disabled?:boolean;timeoutMs?:number;hotTtl?:number;store?:(real:SqliteAvailabilityObservationStore)=>AvailabilityObservationStore}={}){
 let time=start,calls=0,state='AVAILABLE',reads=0;const now=()=>time,redis=new FakeRedis();
 const real=new SqliteAvailabilityObservationStore({...availabilityStateConfig({}),path:':memory:'},now);
 const backend=options.store?.(real)??real;
 const store:AvailabilityObservationStore={getLatest:r=>{reads++;return backend.getLatest(r);},upsertLatest:o=>backend.upsertLatest(o),cleanup:n=>backend.cleanup(n),close:()=>backend.close()};
 const policy=new AvailabilityFreshnessPolicy(),cache=new RedisAvailabilityCache(redis,options.timeoutMs??150);
 const observations=new AvailabilityObservations(store,policy,options.disabled?undefined:cache);
 const config={...hardeningConfig({}),burst:1000,providerCacheTtlMs:options.hotTtl??15000};
 const create=()=>new RailKitProvider(new AvailabilityScheduler(config,now,observations));
 const previous=globalThis.fetch,key=process.env.RAILKIT_API_KEY;process.env.RAILKIT_API_KEY='offline-test-placeholder';
 globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify(raw(state)));};
 t.after(()=>{globalThis.fetch=previous;if(key===undefined)delete process.env.RAILKIT_API_KEY;else process.env.RAILKIT_API_KEY=key;observations.close();real.close();});
 return {real,redis,cache,policy,observations,create,now,config,
  session:(limit=3,provider=create(),budget=new AvailabilityProviderBudget(limit))=>new AvailabilitySession(provider,100,budget,now),
  advance:(ms:number)=>{time+=ms;},reply:(next:string)=>{state=next;},calls:()=>calls,reads:()=>reads};
}

test('Redis fresh hit avoids SQLite and provider, has its own source and zero admission',async t=>{
 const h=setup(t);h.redis.seed(observation());const s=h.session(),check=await s.get(request),d=s.statistics();
 assert.equal(check.status,'AVAILABLE');assert.equal(check.rawDetails!.days[0].availableCount,20);
 assert.equal(h.calls(),0);assert.equal(h.reads(),0);assert.equal(d.redisCacheHits,1);assert.equal(d.providerAvailabilityCalls,0);
 assert.equal(d.persistentCacheHits,0);assert.equal(d.hotCacheHits,0);assert.equal(check.evidence!.evidenceSource,'REDIS_CACHE');
 assert.equal(check.evidence!.observedAt,start);assert.equal(check.evidence!.sdkInvokedForCheck,false);
 assert.equal(check.evidence!.providerIdentityValidation,'NOT_PROVIDED');
});

test('Redis miss promotes SQLite with only 20 minutes remaining and original observedAt',async t=>{
 const h=setup(t),observedAt=start-(5*hour+40*60000);h.real.upsertLatest(observation('AVAILABLE',observedAt));
 const s=h.session(),check=await s.get(request),d=s.statistics(),written=h.redis.writes[0];
 assert.equal(check.status,'AVAILABLE');assert.equal(h.calls(),0);assert.equal(d.redisCacheMisses,1);assert.equal(d.persistentCacheHits,1);
 assert.equal(d.redisCacheHits,0);assert.equal(d.providerAvailabilityCalls,0);
 assert.equal(written.expiresAt-h.now(),20*60000);assert.equal(JSON.parse(written.value).observedAt,observedAt);
 assert.equal(check.rawDetails!.observation!.observedAt,observedAt);
 const second=h.session();await second.get(request);assert.equal(second.statistics().redisCacheHits,1);assert.equal(h.reads(),1);
 assert.equal(h.redis.writes.length,1);
});

test('cold miss writes SQLite before Redis and exposes reusable local hot evidence',async t=>{
 const h=setup(t);h.redis.beforeWrite=async()=>{assert.equal(h.real.getLatest(request)!.observedAt,start);};
 const provider=h.create(),s=h.session(3,provider);await s.get(request);const d=s.statistics();
 assert.equal(h.calls(),1);assert.equal(d.providerAvailabilityCalls,1);assert.equal(d.redisCacheMisses,1);assert.equal(d.persistentCacheMisses,1);
 assert.equal(h.redis.writes.length,1);assert.equal(JSON.parse(h.redis.writes[0].value).observedAt,start);
 const hot=h.session(3,provider);await hot.get(request);assert.equal(hot.statistics().hotCacheHits,1);assert.equal(h.redis.reads,1);assert.equal(h.reads(),1);
 assert.equal(hot.statistics().redisCacheHits,0);assert.equal(hot.statistics().providerAvailabilityCalls,0);
});

test('delayed older writer and equal-time promotion retain newer Redis truth and expiration',async()=>{
 const redis=new FakeRedis(),policy=new AvailabilityFreshnessPolicy(),now=()=>start;
 const first=new RedisAvailabilityCache(redis),second=new RedisAvailabilityCache(redis);
 let release!:()=>void,started!:()=>void;
 const gate=new Promise<void>(resolve=>release=resolve),waiting=new Promise<void>(resolve=>started=resolve);
 redis.beforeWrite=async()=>{started();await gate;};
 const older=first.remember(observation('AVAILABLE',start-60000),policy,now);
 await waiting;redis.beforeWrite=undefined;
 await second.remember(observation('WAITLIST'),policy,now);
 const key=redisObservationKey(request),value=redis.values.get(key),expiration=redis.expirations.get(key);
 release();await older;
 // An equal-time writer with a different TTL policy must not replace or renew it.
 const longer=new AvailabilityFreshnessPolicy({over30:86400000,over15:86400000,over7:86400000,over2:86400000,near:86400000});
 await first.remember(observation('AVAILABLE'),longer,now);
 assert.equal(redis.values.get(key),value);assert.equal(redis.expirations.get(key),expiration);
 const hit=await second.lookup(request,policy,now);
 assert.equal(hit.state,'FRESH');
 if(hit.state==='FRESH'){assert.equal(hit.observation.result.days[0].state,'WAITLIST');assert.equal(hit.observation.observedAt,start);}
 await second.remember(observation('NOT_AVAILABLE',start+1),policy,()=>start+1);
 assert.equal(JSON.parse(redis.values.get(key)!).result.days[0].state,'NOT_AVAILABLE');
 assert.equal(redis.expirations.get(key),start+1+6*hour);
 first.close();second.close();
});

test('a second instance with its own empty SQLite store reuses the first instance Redis evidence',async t=>{
 const h=setup(t);await h.session().get(request);
 const secondStore=new SqliteAvailabilityObservationStore({...availabilityStateConfig({}),path:':memory:'},h.now);t.after(()=>secondStore.close());
 const secondObservations=new AvailabilityObservations(secondStore,h.policy,new RedisAvailabilityCache(h.redis));
 const provider=new RailKitProvider(new AvailabilityScheduler(h.config,h.now,secondObservations));
 const second=h.session(3,provider);assert.equal((await second.get(request)).status,'AVAILABLE');
 assert.equal(second.statistics().redisCacheHits,1);assert.equal(second.statistics().providerAvailabilityCalls,0);
 assert.equal(secondStore.getLatest(request),undefined);assert.equal(h.calls(),1);
});

for(const state of ['WAITLIST','NOT_AVAILABLE'])test('provider '+state+' is persisted and reused through Redis unchanged',async t=>{
 const h=setup(t);h.reply(state);const a=h.session();await a.get(request);
 assert.equal(h.real.getLatest(request)!.result.days[0].state,state);
 assert.equal(JSON.parse(h.redis.writes[0].value).result.days[0].state,state);
 const b=h.session();assert.equal((await b.get(request)).status,state==='NOT_AVAILABLE'?'UNAVAILABLE':state);
 assert.equal(b.statistics().redisCacheHits,1);assert.equal(h.calls(),1);
});

for(const state of ['WAITLIST','NOT_AVAILABLE','RAC'])test('Redis preserves '+state+' evidence',async t=>{
 const h=setup(t);h.redis.seed(observation(state));const s=h.session(),check=await s.get(request);
 assert.equal(check.status,state==='NOT_AVAILABLE'?'UNAVAILABLE':state);assert.equal(h.calls(),0);assert.equal(s.statistics().redisCacheHits,1);
 if(state==='WAITLIST')assert.equal(check.rawDetails!.days[0].waitlistNumber,12);
});

test('stale Redis evidence falls through to SQLite fresh evidence without status upgrade',async t=>{
 const h=setup(t);h.redis.seed(observation('AVAILABLE',start-6*hour));h.real.upsertLatest(observation('WAITLIST'));
 const s=h.session(),check=await s.get(request);assert.equal(check.status,'WAITLIST');assert.equal(h.calls(),0);
 assert.equal(s.statistics().redisCacheStale,1);assert.equal(s.statistics().redisCacheHits,0);assert.equal(s.statistics().persistentCacheHits,1);
});

const corruptCases:[string,(o:AvailabilityObservation)=>unknown][]=[
 ['invalid JSON',()=>'{'],['oversize JSON',()=> ' '.repeat(8193)],['missing evidence',()=>({})],
 ['wrong schema',o=>({...o,namespace:'railkit:availability:v0'})],
 ['invalid timestamp',o=>({...o,observedAt:'secret'})],
 ['fractional timestamp',o=>({...o,observedAt:start+0.5})],
 ['conflicting counts',o=>{o.result.days[0].availableCount=999;return o;}],
 ['unbookable AVAILABLE',o=>{o.result.days[0].canBook=false;return o;}],
 ['UNKNOWN status',o=>{(o.result.days[0] as {state:string}).state='UNKNOWN';return o;}],
 ['success-shaped provider failure',o=>({...o,result:{...o.result,failureCategory:'RATE_LIMITED'}})],
];
for(const [name,mutate]of corruptCases)test('Redis rejects '+name+' and uses budgeted provider fallback',async t=>{
 const h=setup(t);h.redis.seed(mutate(observation()));h.reply('NOT_AVAILABLE');const s=h.session(),check=await s.get(request);
 assert.equal(check.status,'UNAVAILABLE');assert.equal(s.statistics().redisCacheReadErrors,1);assert.equal(s.statistics().redisCacheHits,0);
 assert.equal(s.statistics().redisCacheMisses,0);assert.equal(s.statistics().providerAvailabilityCalls,1);assert.equal(h.calls(),1);
 assert.doesNotMatch(JSON.stringify(s.statistics()),/secret/);
});

for(const field of ['travelClass','journeyDate','quota','trainNumber','fromStationCode','toStationCode'] as const)test('Redis rejects mismatched '+field,async t=>{
 const h=setup(t),o=observation();
 const changes={travelClass:'3A',journeyDate:'21-09-2099',quota:'TQ',trainNumber:'30002',fromStationCode:'CCC',toStationCode:'DDD'};
 o.identity[field]=changes[field];o.result.request[field]=changes[field];
 if(field==='journeyDate')o.result.days[0].date=changes[field];
 h.redis.seed(o);h.reply('WAITLIST');const s=h.session();assert.equal((await s.get(request)).status,'WAITLIST');
 assert.equal(s.statistics().redisCacheReadErrors,1);assert.equal(h.calls(),1);
});

test('future observation is stale, even when Redis contains it',async t=>{
 const h=setup(t);h.redis.seed(observation('AVAILABLE',start+1));h.reply('NOT_AVAILABLE');const s=h.session();
 assert.equal((await s.get(request)).status,'UNAVAILABLE');assert.equal(s.statistics().redisCacheStale,1);assert.equal(h.calls(),1);
});

test('Redis read failure falls back to SQLite without provider cost',async t=>{
 const h=setup(t);h.redis.readError=true;h.real.upsertLatest(observation('WAITLIST'));const s=h.session();
 assert.equal((await s.get(request)).status,'WAITLIST');assert.equal(s.statistics().redisCacheReadErrors,1);
 assert.equal(s.statistics().persistentCacheHits,1);assert.equal(s.statistics().providerAvailabilityCalls,0);assert.equal(h.calls(),0);
});

test('Redis write failure cannot turn a valid provider result into failure',async t=>{
 const h=setup(t);h.redis.writeError=true;const s=h.session();assert.equal((await s.get(request)).status,'AVAILABLE');
 assert.equal(s.statistics().redisCacheWriteErrors,1);assert.equal(s.statistics().providerAvailabilityCalls,1);assert.equal(h.calls(),1);
 assert.equal(h.real.getLatest(request)!.observedAt,start);assert.doesNotMatch(JSON.stringify(s.statistics()),/secret/);
});

test('SQLite write failure still permits Redis reuse of validated provider evidence',async t=>{
 const h=setup(t,{store:real=>({getLatest:r=>real.getLatest(r),upsertLatest:()=>{throw Error('secret database path');},cleanup:()=>0,close:()=>{}})});
 const a=h.session();assert.equal((await a.get(request)).status,'AVAILABLE');assert.equal(a.statistics().persistentCacheWriteErrors,1);
 assert.equal(h.real.getLatest(request),undefined);assert.equal(h.redis.writes.length,1);
 const b=h.session();assert.equal((await b.get(request)).status,'AVAILABLE');assert.equal(b.statistics().redisCacheHits,1);assert.equal(h.calls(),1);
});

test('disabled Redis leaves the Phase 2A path and all Redis metrics untouched',async t=>{
 const h=setup(t,{disabled:true});h.redis.readError=true;h.redis.writeError=true;
 const a=h.session();await a.get(request);const provider=h.create(),b=h.session(3,provider);await b.get(request);
 const c=h.session(3,provider);await c.get(request);
 assert.equal(a.statistics().providerAvailabilityCalls,1);assert.equal(b.statistics().persistentCacheHits,1);assert.equal(c.statistics().hotCacheHits,1);
 assert.equal(h.redis.reads,0);assert.equal(h.redis.writes.length,0);assert.equal(h.calls(),1);
 for(const s of [a,b,c])for(const [key,value]of Object.entries(s.statistics()))if(key.startsWith('redis'))assert.equal(value,0);
});

test('twenty local inflight waiters still perform one Redis/SQLite lookup and provider attempt',async t=>{
 const h=setup(t);let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);h.redis.beforeRead=()=>gate;
 const provider=h.create(),sessions=Array.from({length:20},()=>h.session(3,provider)),pending=sessions.map(s=>s.get(request));
 await new Promise(resolve=>setImmediate(resolve));release();await Promise.all(pending);
 assert.equal(h.redis.reads,1);assert.equal(h.reads(),1);assert.equal(h.calls(),1);assert.equal(h.redis.writes.length,1);
 assert.equal(sessions.reduce((n,s)=>n+s.statistics().providerAvailabilityCalls,0),1);
 assert.equal(sessions.reduce((n,s)=>n+s.statistics().sharedInflightHits,0),19);
 assert.equal(sessions.reduce((n,s)=>n+s.statistics().redisCacheMisses,0),1);
});

test('Redis hit costs zero at exhausted admission; outages and misses cannot bypass the cap',async t=>{
 const h=setup(t),budget=new AvailabilityProviderBudget(1);budget.acquire();h.redis.seed(observation());
 const s=h.session(1,h.create(),budget);assert.equal((await s.get(request)).status,'AVAILABLE');assert.equal(h.calls(),0);
 h.redis.readError=true;const denied=await s.get({...request,trainNumber:'30002'});
 assert.equal(denied.errorCategory,'PROVIDER_BUDGET_EXHAUSTED');assert.equal(s.statistics().providerAvailabilityCalls,1);assert.equal(h.calls(),0);
});

test('fresh Redis reuse followed by a miss consumes exactly one provider admission',async t=>{
 const h=setup(t);h.redis.seed(observation());const s=h.session(1);await s.get(request);await s.get({...request,travelClass:'3A'});
 assert.equal(h.calls(),1);assert.equal(s.statistics().providerAvailabilityCalls,1);assert.equal(s.statistics().redisCacheHits,1);
 assert.equal((await s.get({...request,travelClass:'2A'})).errorCategory,'PROVIDER_BUDGET_EXHAUSTED');assert.equal(h.calls(),1);
});

test('same provider observation retains one expiration through SQLite, Redis, hot and session caches',async t=>{
 const h=setup(t,{hotTtl:hour});const a=h.session();await a.get(request);
 const expiresAt=start+6*hour;assert.equal(h.real.getLatest(request)!.observedAt,start);assert.equal(h.redis.writes[0].expiresAt,expiresAt);
 h.redis.values.clear();h.advance(5*hour+40*60000);
 const b=h.session();await b.get(request);assert.equal(b.statistics().persistentCacheHits,1);
 assert.equal(h.redis.writes[1].expiresAt,expiresAt);assert.equal(JSON.parse(h.redis.writes[1].value).observedAt,start);
 const provider=h.create(),c=h.session(3,provider);await c.get(request);assert.equal(c.statistics().redisCacheHits,1);
 h.advance(10*60000);const d=h.session(3,provider),hot=await d.get(request);assert.equal(d.statistics().hotCacheHits,1);
 assert.deepEqual(hot.rawDetails!.observation,{observedAt:start,freshUntil:expiresAt});
 h.advance(10*60000);h.reply('NOT_AVAILABLE');const expired=await d.get(request);
 assert.equal(expired.status,'UNAVAILABLE');assert.equal(d.statistics().cacheHits,0);assert.equal(d.statistics().redisCacheStale,1);
 assert.equal(d.statistics().persistentCacheStale,1);assert.equal(h.calls(),2);assert.equal(d.statistics().providerAvailabilityCalls,1);
});

test('promotion latency cannot extend expiration or return evidence that expired during promotion',async t=>{
 const h=setup(t);h.real.upsertLatest(observation('AVAILABLE',start-6*hour+5));
 h.redis.beforeWrite=async()=>{h.advance(10);};h.reply('WAITLIST');const s=h.session();
 assert.equal((await s.get(request)).status,'WAITLIST');assert.equal(s.statistics().persistentCacheHits,0);
 assert.equal(s.statistics().persistentCacheStale,1);assert.equal(h.redis.writes[0].expiresAt,start+5);assert.equal(h.calls(),1);
});

test('hanging Redis read and write are bounded and fail open',async t=>{
 const h=setup(t,{timeoutMs:5});h.redis.beforeRead=()=>new Promise(()=>{});h.redis.beforeWrite=()=>new Promise(()=>{});
 const s=h.session();assert.equal((await s.get(request)).status,'AVAILABLE');assert.equal(h.calls(),1);
 assert.equal(s.statistics().redisCacheReadErrors,1);assert.equal(s.statistics().redisCacheWriteErrors,1);
 assert.equal(s.statistics().providerAvailabilityCalls,1);
});

test('cancellation during Redis read cannot invoke provider or publish local evidence',async t=>{
 const h=setup(t);let release!:()=>void;h.redis.beforeRead=()=>new Promise<void>(resolve=>release=resolve);
 const provider=h.create(),controller=new AbortController();const pending=inAvailabilityScope(controller.signal,()=>provider.getAvailability(request));
 await new Promise(resolve=>setImmediate(resolve));controller.abort();release();await pending;
 await new Promise(resolve=>setImmediate(resolve));assert.equal(h.calls(),0);assert.equal(h.reads(),0);assert.equal(h.redis.writes.length,0);
 h.redis.beforeRead=undefined;const s=h.session(3,provider);await s.get(request);assert.equal(s.statistics().hotCacheHits,0);assert.equal(h.calls(),1);
});

test('cancellation during Redis write prevents late Redis and hot-cache publication',async t=>{
 const h=setup(t),started=new Promise<void>(resolve=>{
  h.redis.beforeWrite=async()=>{resolve();await gate;};
 });
 let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
 const provider=h.create(),controller=new AbortController();
 const pending=inAvailabilityScope(controller.signal,()=>provider.getAvailability(request));
 await started;controller.abort();release();await pending;await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.calls(),1);assert.equal(h.redis.writes.length,0);
 // SQLite was written while the provider response was still active; cancellation
 // only prevents the later Redis/hot publication, not this completed durable write.
 assert.equal(h.real.getLatest(request)!.observedAt,start);
 h.redis.beforeWrite=undefined;const s=h.session(3,provider);await s.get(request);
 assert.equal(s.statistics().hotCacheHits,0);assert.equal(s.statistics().persistentCacheHits,1);assert.equal(h.calls(),1);
});

test('past journey observations are neither reusable nor written to Redis',async()=>{
 const redis=new FakeRedis(),cache=new RedisAvailabilityCache(redis),policy=new AvailabilityFreshnessPolicy();redis.seed(observation());
 const now=()=>Date.UTC(2099,8,21),metrics=emptyAvailabilityMetrics();
 await observeAvailabilityMetrics((key,n)=>metrics[key]+=n,async()=>{
  assert.equal((await cache.lookup(request,policy,now)).state,'STALE');await cache.remember(observation(),policy,now);
 });
 assert.equal(metrics.redisCacheStale,1);assert.equal(redis.writes.length,0);
});

test('Redis key uses the exact Phase 2A canonical identity and isolates class/date/quota',()=>{
 assert.equal(redisObservationKey(request),'railway:availability:'+observationKey(request));
 assert.equal(redisObservationKey({...request,trainNumber:' 30001 ',fromStationCode:' aaa ',travelClass:' sl ',journeyDate:'2099-09-20'}),redisObservationKey(request));
 for(const change of [{travelClass:'3A'},{journeyDate:'21-09-2099'},{quota:'TQ'}])assert.notEqual(redisObservationKey({...request,...change}),redisObservationKey(request));
});

test('Redis configuration is opt-in, validates bounds and never echoes credentials',()=>{
 assert.equal(availabilityRedisConfig({}).enabled,false);assert.equal(configuredRedisAvailabilityCache(availabilityRedisConfig({REDIS_URL:'redis://unused'})),undefined);
 assert.equal(availabilityRedisConfig({REDIS_ENABLED:'true',REDIS_URL:'rediss://localhost:6379'}).enabled,true);
 for(const env of [{REDIS_ENABLED:'yes'},{REDIS_ENABLED:'true'},{REDIS_ENABLED:'true',REDIS_URL:'https://user:secret@localhost'},
  {REDIS_OPERATION_TIMEOUT_MS:'0'},{REDIS_OPERATION_TIMEOUT_MS:'1001'},{REDIS_OPERATION_TIMEOUT_MS:'1.5'},{REDIS_RETRY_COOLDOWN_MS:'60001'}]){
  assert.throws(()=>availabilityRedisConfig(env),error=>error instanceof Error&&/^Invalid REDIS_/.test(error.message)&&!error.message.includes('secret'));
 }
});

test('V2 response diagnostics and completion logs include Redis reuse',async t=>{
 const {RailwayDatabase}=await import('../local-railway/database.js');
 const {ProtectedJourneyService}=await import('../api/services/protected-journey-service.js');
 const db=new RailwayDatabase(':memory:');t.after(()=>db.close());
 db.replace({stations:['AAA','BBB'].map(code=>({code,name:code})),trains:[{number:'30001',name:'Fixture',sourceCode:'AAA',destinationCode:'BBB',runningDaysRaw:'Daily',runningDays:['MON','TUE','WED','THU','FRI','SAT','SUN']}],stops:[{trainNumber:'30001',stationCode:'AAA',sequence:1,dayOffset:0,departureTime:'06:00',distanceKm:0},{trainNumber:'30001',stationCode:'BBB',sequence:2,dayOffset:0,arrivalTime:'08:00',distanceKm:100}],metadata:{source:'RAILPULL_NTES',importedAt:'2099-09-01T00:00:00Z',trainCount:1,stationCount:2,stopCount:2}});
 const h=setup(t);h.redis.seed(observation());const logs:Record<string,unknown>[]=[];
 const service=new ProtectedJourneyService(db,h.create(),hardeningConfig({}),{diagnostics:true,logger:r=>logs.push(r)},h.now);
 const response=await checkFirstRoute(service,{from:'aaa',to:'bbb',date,classes:['sl']});
 assert.equal(response.results[0].status,'FULLY_RESERVED_USABLE');assert.equal(response.diagnostics!.redisCacheHits,1);
 assert.equal(response.diagnostics!.providerAvailabilityCalls,0);assert.equal(response.diagnostics!.persistentCacheHits,0);assert.equal(h.calls(),0);
 assert.equal(logs.find(r=>r.event==='journey_v2_search_completed')!.redisCacheHits,1);
 const evidence=logs.find(r=>r.event==='journey_v2_availability_evidence')!.evidence as Record<string,unknown>;
 assert.equal(evidence.evidenceSource,'REDIS_CACHE');assert.equal(evidence.observedAt,start);
});
