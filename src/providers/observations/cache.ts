import {availabilityMetric} from '../availability-observation.js';
import {validateObservation,makeObservation,type AvailabilityIdentity,type AvailabilityObservation,type AvailabilityObservationStore,type ObservationResult} from './model.js';
import {AvailabilityFreshnessPolicy} from './freshness.js';
import type {RedisAvailabilityCache} from './redis-cache.js';
export type ObservationLookup={state:'FRESH';observation:AvailabilityObservation;freshUntil:number}|{state:'STALE'|'MISS'};
/** Backend-neutral failure boundary. Storage never authorizes a provider call. */
export class AvailabilityObservations {
 constructor(readonly store:AvailabilityObservationStore,readonly policy=new AvailabilityFreshnessPolicy(),private readonly redis?:RedisAvailabilityCache){}
 close(){try{this.store.close();}finally{this.redis?.close();}}
 async lookup(identity:AvailabilityIdentity,now:()=>number=Date.now,signal?:AbortSignal):Promise<ObservationLookup>{
  if(this.redis){
   const cached=await this.redis.lookup(identity,this.policy,now,signal);
   signal?.throwIfAborted();
   if(cached.state==='FRESH')return cached;
  }
  try{
   const raw=await this.store.getLatest(identity);
   if(raw===undefined||raw===null){availabilityMetric('persistentCacheMisses');return {state:'MISS'};}
   const time=now();if(!Number.isSafeInteger(time)||time<0)throw Error('Invalid observation clock');
   const observation=validateObservation(raw,identity),freshUntil=this.policy.freshUntil(observation.identity.journeyDate,observation.observedAt,time);
   if(time>=freshUntil){availabilityMetric('persistentCacheStale');return {state:'STALE'};}
   await this.redis?.remember(observation,this.policy,now,signal);
   signal?.throwIfAborted();
   // Promotion consumes time, not freshness. Recheck before publishing a hit.
   const publishedUntil=this.policy.freshUntil(observation.identity.journeyDate,observation.observedAt,now());
   if(now()>=publishedUntil){availabilityMetric('persistentCacheStale');return {state:'STALE'};}
   availabilityMetric('persistentCacheHits');return {state:'FRESH',observation,freshUntil:publishedUntil};
  }catch{availabilityMetric('persistentCacheReadErrors');return {state:'MISS'};}
 }
 async remember(result:ObservationResult,observedAt:number,now:()=>number=Date.now,signal?:AbortSignal):Promise<AvailabilityObservation|undefined>{
  let observation:AvailabilityObservation;
  try{observation=makeObservation(result,observedAt);}catch{return undefined;}
  try{await this.store.upsertLatest(observation);}catch{availabilityMetric('persistentCacheWriteErrors');}
  // Valid provider evidence remains usable even if optional durability is unavailable.
  if(!signal?.aborted)await this.redis?.remember(observation,this.policy,now,signal);
  return observation;
 }
}
