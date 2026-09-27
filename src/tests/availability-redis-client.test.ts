import test from 'node:test';
import assert from 'node:assert/strict';
import type {createClient} from 'redis';
import {NodeRedisAvailabilityAdapter,putLatestObservationScript} from '../providers/observations/redis-client.js';
import {RedisAvailabilityCache} from '../providers/observations/redis-cache.js';
import {AvailabilityFreshnessPolicy} from '../providers/observations/freshness.js';
import {availabilityRedisConfig} from '../config/availability-redis.js';
import {emptyAvailabilityMetrics,observeAvailabilityMetrics} from '../providers/availability-observation.js';
import {makeObservation} from '../providers/observations/model.js';
import {normalizeAvailability} from '../providers/railkit/railkit-normalizers.js';

const config=availabilityRedisConfig({REDIS_ENABLED:'true',REDIS_URL:'redis://user:secret@localhost:6379',REDIS_OPERATION_TIMEOUT_MS:'5',REDIS_RETRY_COOLDOWN_MS:'100'});
const request={trainNumber:'30001',fromStationCode:'AAA',toStationCode:'BBB',journeyDate:'20-09-2099',travelClass:'SL',quota:'GN' as const};
const start=Date.UTC(2099,8,1);
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
function transport(){
 const options:unknown[]=[],commands:{script:string;options:unknown}[]=[];
 let created=0,connects=0,gets=0,destroys=0,handlers=0;
 let connectHook=async()=>{},getHook=async()=>{},evalHook=async()=>{};
 const clients:{isOpen:boolean;isReady:boolean}[]=[];
 const factory=((o:unknown)=>{
  created++;options.push(o);
  const client={isOpen:false,isReady:false,
   on:()=>{handlers++;return client;},
   connect:async()=>{connects++;client.isOpen=true;await connectHook();client.isReady=client.isOpen;return client;},
   get:async()=>{gets++;await getHook();return null;},
   eval:async(script:string,options:unknown)=>{commands.push({script,options});await evalHook();return 1;},
   destroy:()=>{destroys++;client.isOpen=false;client.isReady=false;},
  };clients.push(client);return client;
 }) as unknown as typeof createClient;
 return {factory,options,commands,clients,counts:()=>({created,connects,gets,destroys,handlers}),
  connecting:(hook:()=>Promise<void>)=>{connectHook=hook;},reading:(hook:()=>Promise<void>)=>{getHook=hook;},writing:(hook:()=>Promise<void>)=>{evalHook=hook;}};
}

test('node-redis is lazy, shares one connection and disables offline/reconnect queues',async()=>{
 const fake=transport(),adapter=new NodeRedisAvailabilityAdapter(config,()=>start,fake.factory);
 assert.equal(fake.counts().created,0);const signal=new AbortController().signal;
 assert.deepEqual(await Promise.all([adapter.get('a',signal),adapter.get('b',signal)]),[null,null]);
 assert.deepEqual(fake.counts(),{created:1,connects:1,gets:2,destroys:0,handlers:1});
 assert.deepEqual(fake.options[0],{url:config.url,disableOfflineQueue:true,commandsQueueMaxLength:64,socket:{connectTimeout:5,reconnectStrategy:false}});
 adapter.close();assert.equal(fake.counts().destroys,1);
 await assert.rejects(adapter.get('a',signal),/Redis unavailable/);assert.equal(fake.counts().created,1);
});

test('connection failure is sanitized and retries only on demand after cooldown',async()=>{
 const fake=transport();let time=start;fake.connecting(async()=>{throw Error('secret URL');});
 const adapter=new NodeRedisAvailabilityAdapter(config,()=>time,fake.factory),signal=new AbortController().signal;
 await assert.rejects(adapter.get('a',signal),error=>error instanceof Error&&error.message==='Redis unavailable');
 await assert.rejects(adapter.get('a',signal),/Redis unavailable/);assert.equal(fake.counts().created,1);
 time+=100;fake.connecting(async()=>{});assert.equal(await adapter.get('a',signal),null);assert.equal(fake.counts().created,2);adapter.close();
});

test('command failure destroys connection and is counted as one Redis read error',async()=>{
 const fake=transport();fake.reading(async()=>{throw Error('secret URL');});
 const adapter=new NodeRedisAvailabilityAdapter(config,()=>start,fake.factory),cache=new RedisAvailabilityCache(adapter),metrics=emptyAvailabilityMetrics();
 await observeAvailabilityMetrics((key,n)=>metrics[key]+=n,async()=>{
  assert.equal((await cache.lookup(request,new AvailabilityFreshnessPolicy(),()=>start)).state,'MISS');
 });
 assert.equal(metrics.redisCacheReadErrors,1);assert.equal(metrics.redisCacheMisses,0);assert.equal(fake.counts().destroys,1);
 assert.doesNotMatch(JSON.stringify(metrics),/secret/);cache.close();
});

test('connection timeout destroys socket and a late connection never dispatches its queued read',async()=>{
 const fake=transport(),gate=deferred();fake.connecting(()=>gate.promise);
 const adapter=new NodeRedisAvailabilityAdapter(config,()=>start,fake.factory),cache=new RedisAvailabilityCache(adapter,5);
 assert.equal((await cache.lookup(request,new AvailabilityFreshnessPolicy(),()=>start)).state,'MISS');
 assert.equal(fake.counts().destroys,1);assert.equal(fake.counts().gets,0);
 gate.resolve();await new Promise(resolve=>setImmediate(resolve));assert.equal(fake.counts().gets,0);cache.close();
});

test('command timeout destroys connection without exposing a late response',async()=>{
 const fake=transport(),gate=deferred();fake.reading(()=>gate.promise);
 const adapter=new NodeRedisAvailabilityAdapter(config,()=>start,fake.factory),cache=new RedisAvailabilityCache(adapter,5);
 assert.equal((await cache.lookup(request,new AvailabilityFreshnessPolicy(),()=>start)).state,'MISS');
 assert.equal(fake.counts().gets,1);assert.equal(fake.counts().destroys,1);
 gate.resolve();await new Promise(resolve=>setImmediate(resolve));cache.close();
});

test('latest write uses one atomic script and the original absolute expiration',async()=>{
 const fake=transport(),adapter=new NodeRedisAvailabilityAdapter(config,()=>start,fake.factory),signal=new AbortController().signal;
 await adapter.putIfNewer('canonical-key','validated-json',start,start+1200000,signal);
 assert.deepEqual(fake.commands,[{script:putLatestObservationScript,options:{keys:['canonical-key'],arguments:['validated-json',String(start),String(start+1200000)]}}]);
 adapter.close();
});

test('write timeout destroys the connection and cooldown prevents another dispatch',async()=>{
 const fake=transport(),gate=deferred();fake.writing(()=>gate.promise);
 const adapter=new NodeRedisAvailabilityAdapter(config,()=>start,fake.factory),cache=new RedisAvailabilityCache(adapter,5);
 const value=makeObservation(normalizeAvailability({success:true,data:{availability:[{date:request.journeyDate,status:'WAITLIST',availabilityText:'WL 12'}]}},request),start);
 const metrics=emptyAvailabilityMetrics();
 await observeAvailabilityMetrics((key,n)=>metrics[key]+=n,async()=>{
  await cache.remember(value,new AvailabilityFreshnessPolicy(),()=>start);
  await cache.remember(value,new AvailabilityFreshnessPolicy(),()=>start);
 });
 assert.equal(metrics.redisCacheWriteErrors,2);assert.equal(fake.commands.length,1);
 assert.equal(fake.counts().destroys,1);assert.equal(fake.counts().created,1);
 gate.resolve();await new Promise(resolve=>setImmediate(resolve));cache.close();
});

test('an already cancelled command creates no Redis connection',async()=>{
 const fake=transport(),adapter=new NodeRedisAvailabilityAdapter(config,()=>start,fake.factory),abort=new AbortController();abort.abort();
 await assert.rejects(adapter.get('a',abort.signal));assert.equal(fake.counts().created,0);adapter.close();
});

test('closing the observation facade also closes Redis when SQLite close fails',async()=>{
 const {AvailabilityObservations}=await import('../providers/observations/cache.js');
 const fake=transport(),adapter=new NodeRedisAvailabilityAdapter(config,()=>start,fake.factory);
 await adapter.get('a',new AbortController().signal);
 const observations=new AvailabilityObservations({getLatest:()=>undefined,upsertLatest:()=>{},cleanup:()=>0,close:()=>{throw Error('SQLite closed');}},new AvailabilityFreshnessPolicy(),new RedisAvailabilityCache(adapter));
 assert.throws(()=>observations.close(),/SQLite closed/);assert.equal(fake.counts().destroys,1);
});
