import {availabilityMetric} from '../availability-observation.js';
import {validateObservation,makeObservation,type AvailabilityIdentity,type AvailabilityObservation,type AvailabilityObservationStore,type ObservationResult} from './model.js';
import {AvailabilityFreshnessPolicy} from './freshness.js';
export type ObservationLookup={state:'FRESH';observation:AvailabilityObservation;freshUntil:number}|{state:'STALE'|'MISS'};
/** Backend-neutral failure boundary. Storage never authorizes a provider call. */
export class AvailabilityObservations {
 constructor(readonly store:AvailabilityObservationStore,readonly policy=new AvailabilityFreshnessPolicy()){}
 async lookup(identity:AvailabilityIdentity,now:()=>number=Date.now):Promise<ObservationLookup>{
  try{
   const raw=await this.store.getLatest(identity);
   if(raw===undefined||raw===null){availabilityMetric('persistentCacheMisses');return {state:'MISS'};}
   const time=now();if(!Number.isSafeInteger(time)||time<0)throw Error('Invalid observation clock');
   const observation=validateObservation(raw,identity),freshUntil=this.policy.freshUntil(observation.identity.journeyDate,observation.observedAt,time);
   if(time>=freshUntil){availabilityMetric('persistentCacheStale');return {state:'STALE'};}
   availabilityMetric('persistentCacheHits');return {state:'FRESH',observation,freshUntil};
  }catch{availabilityMetric('persistentCacheReadErrors');return {state:'MISS'};}
 }
 async remember(result:ObservationResult,observedAt:number):Promise<AvailabilityObservation|undefined>{
  let observation:AvailabilityObservation;
  try{observation=makeObservation(result,observedAt);}catch{return undefined;}
  try{await this.store.upsertLatest(observation);}catch{availabilityMetric('persistentCacheWriteErrors');}
  return observation;
 }
}
