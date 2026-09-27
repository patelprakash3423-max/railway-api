import {availabilityMetric} from '../availability-observation.js';
import {AvailabilityFreshnessPolicy} from './freshness.js';
import {observationKey,validateObservation,type AvailabilityIdentity,type AvailabilityObservation} from './model.js';
import type {ObservationLookup} from './cache.js';

/** Transport only. Adapters must stop queued work when the signal is aborted. */
export interface AvailabilityRedisAdapter {
 get(key:string,signal:AbortSignal):Promise<string|null>;
 putIfNewer(key:string,value:string,observedAt:number,expiresAt:number,signal:AbortSignal):Promise<void>;
 close():void;
}
export function redisObservationKey(identity:AvailabilityIdentity){return 'railway:availability:'+observationKey(identity);}

/** Redis is optional evidence acceleration, never a provider admission mechanism. */
export class RedisAvailabilityCache {
 constructor(private readonly adapter:AvailabilityRedisAdapter,private readonly timeoutMs=150){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>1000)throw Error('Invalid Redis operation timeout');
 }
 private async bounded<T>(work:(signal:AbortSignal)=>Promise<T>,parent?:AbortSignal):Promise<T>{
  const controller=new AbortController();
  const abort=()=>controller.abort(new Error('Redis operation cancelled'));
  parent?.throwIfAborted();parent?.addEventListener('abort',abort,{once:true});
  let rejectAbort!:(error:Error)=>void;
  const cancelled=new Promise<never>((_,reject)=>{rejectAbort=reject;});
  const reject=()=>rejectAbort(new Error('Redis operation unavailable'));
  controller.signal.addEventListener('abort',reject,{once:true});
  const timer=setTimeout(abort,this.timeoutMs);
  try{return await Promise.race([Promise.resolve().then(()=>{controller.signal.throwIfAborted();return work(controller.signal);}),cancelled]);}
  finally{clearTimeout(timer);parent?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',reject);}
 }
 async lookup(identity:AvailabilityIdentity,policy:AvailabilityFreshnessPolicy,now:()=>number,parent?:AbortSignal):Promise<ObservationLookup>{
  try{
   const raw=await this.bounded(signal=>this.adapter.get(redisObservationKey(identity),signal),parent);
   if(raw===null){availabilityMetric('redisCacheMisses');return {state:'MISS'};}
   if(typeof raw!=='string'||raw.length>8192)throw Error('Invalid Redis observation');
   const observation=validateObservation(JSON.parse(raw),identity),time=now();
   if(!Number.isSafeInteger(time)||time<0)throw Error('Invalid observation clock');
   const freshUntil=policy.freshUntil(observation.identity.journeyDate,observation.observedAt,time);
   if(time>=freshUntil){availabilityMetric('redisCacheStale');return {state:'STALE'};}
   availabilityMetric('redisCacheHits');return {state:'FRESH',observation,freshUntil};
  }catch{availabilityMetric('redisCacheReadErrors');return {state:'MISS'};}
 }
 async remember(value:AvailabilityObservation,policy:AvailabilityFreshnessPolicy,now:()=>number,parent?:AbortSignal):Promise<void>{
  try{
   const observation=validateObservation(value),time=now();
   if(!Number.isSafeInteger(time)||time<0)throw Error('Invalid observation clock');
   const expiresAt=policy.freshUntil(observation.identity.journeyDate,observation.observedAt,time);
   if(expiresAt<=time)return;
   const json=JSON.stringify(observation);if(json.length>8192)throw Error('Redis observation exceeds storage bound');
   // Absolute expiration prevents connection/command latency from adding lifetime.
   await this.bounded(signal=>this.adapter.putIfNewer(redisObservationKey(observation.identity),json,observation.observedAt,expiresAt,signal),parent);
  }catch{availabilityMetric('redisCacheWriteErrors');}
 }
 close(){try{this.adapter.close();}catch{/* Cache shutdown cannot fail API shutdown. */}}
}
