import {availabilityRequestKey} from '../../utils/availability-key.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {hardeningConfig,type HardeningConfig} from '../../config/hardening.js';
import {PublicError} from '../../application/errors.js';
import {ProviderQuota} from '../provider-quota.js';
import {availabilityMetric} from '../availability-observation.js';
import {availabilitySignal,availabilityTimeoutMs,inAvailabilityScope} from './availability-abort.js';
import {providerTransportEvidence,type ProviderFailureCategory} from '../../domain/types/provider-failure.js';
import {normalizeAvailability} from './railkit-normalizers.js';
import type {AvailabilityRequest} from '../../domain/types/availability.js';

type CacheKind='INVENTORY'|'UNSUPPORTED_CLASS';
type CachedEvidence={expires:number;value:unknown};
type Waiter={signal?:AbortSignal;run:ReturnType<typeof AsyncLocalStorage.snapshot>;resolve:(v:unknown)=>void;reject:(e:unknown)=>void;cleanup:()=>void;queuedAt:number;waited:boolean};
type Entry={timeoutMs:number;httpStatus?:number;transportFailure?:ProviderFailureCategory;key:string;request:AvailabilityRequest;owner:unknown;invoke:()=>Promise<unknown>;waiters:Set<Waiter>;controller:AbortController;running:boolean;timer?:ReturnType<typeof setTimeout>};
/** One default instance covers every raw/normalized availability SDK entry point.
 * Queue owners rotate after each start. Running calls are never preempted.
 * Aborted/time-out SDKs retain their slots until the SDK promise actually settles:
 * an SDK ignoring abort must not let physical concurrency exceed the hard cap.
 */
export class AvailabilityScheduler {
 readonly quota:ProviderQuota;
 private active=0;
 private pending=new Map<string,Entry>();
 private queue:Entry[]=[];
 // One cache mechanism with independent retention/capacity policies.
 private caches:Record<CacheKind,Map<string,CachedEvidence>>={INVENTORY:new Map(),UNSUPPORTED_CLASS:new Map()};
 constructor(private readonly config:HardeningConfig,private readonly now=Date.now){this.quota=new ProviderQuota(config,now);}
 execute(request:AvailabilityRequest,invoke:()=>Promise<unknown>):Promise<unknown>{
  const signal=availabilitySignal();signal?.throwIfAborted();
  const key=availabilityRequestKey(request);
  for(const kind of ['INVENTORY','UNSUPPORTED_CLASS'] as const){
   const cache=this.caches[kind],cached=cache.get(key);
   if(cached&&cached.expires>this.now()){
    availabilityMetric(kind==='INVENTORY'?'sharedCacheHits':'unsupportedEvidenceCacheHits');
    return Promise.resolve(structuredClone(cached.value));
   }
   if(cached)cache.delete(key);
  }
  let entry=this.pending.get(key);
  if(entry)availabilityMetric('sharedInflightHits');
  else{
   entry={timeoutMs:availabilityTimeoutMs()??this.config.providerTimeoutMs,key,request:{...request},owner:signal??Symbol(),invoke,waiters:new Set(),controller:new AbortController(),running:false};
   this.pending.set(key,entry);this.queue.push(entry);
  }
  const work=entry;
  const promise=new Promise<unknown>((resolve,reject)=>{
   const waiter:Waiter={signal,run:AsyncLocalStorage.snapshot(),resolve,reject,cleanup:()=>{},queuedAt:this.now(),waited:!work.running&&this.active>=this.config.providerConcurrency};
   if(waiter.waited)availabilityMetric('providerQueueWaits');
   const abort=()=>{
    this.finishWait(waiter);work.waiters.delete(waiter);reject(signal!.reason);
    if(!work.waiters.size){
     this.remove(work);work.controller.abort(signal!.reason);
     if(!work.running){this.queue=this.queue.filter(e=>e!==work);this.drain();}
    }
   };
   waiter.cleanup=()=>signal?.removeEventListener('abort',abort);
   work.waiters.add(waiter);signal?.addEventListener('abort',abort,{once:true});
  });
  this.drain();
  return promise;
 }
 private finishWait(w:Waiter){
  w.cleanup();
  if(w.waited){w.run(()=>availabilityMetric('providerQueueWaitMs',Math.max(0,this.now()-w.queuedAt)));w.waited=false;}
 }
 private remove(entry:Entry){if(this.pending.get(entry.key)===entry)this.pending.delete(entry.key);}
 private drain(){
  while(this.active<this.config.providerConcurrency&&this.queue.length){
   const entry=this.queue.shift()!;
   // Rotate the chosen owner's remaining jobs behind every other owner.
   this.queue=[...this.queue.filter(e=>e.owner!==entry.owner),...this.queue.filter(e=>e.owner===entry.owner)];
   if(!entry.waiters.size)continue;
   entry.running=true;this.active++;
   const first=entry.waiters.values().next().value!;
   for(const w of entry.waiters){
    if(w.waited){w.run(()=>availabilityMetric('providerQueueWaitMs',Math.max(0,this.now()-w.queuedAt)));w.waited=false;}
   }
   entry.timer=setTimeout(()=>{
    const error=new PublicError('PROVIDER_TIMEOUT','Availability provider timed out.',504);
    entry.controller.abort(error);this.settle(entry,undefined,error);
   },entry.timeoutMs);
   // Restore the active initiating waiter's accounting context, then replace its
   // fetch signal with the shared controller. A departed waiter cannot kill peers.
   const task=first.run(()=>inAvailabilityScope(entry.controller.signal,async()=>{
    entry.controller.signal.throwIfAborted();
    return entry.invoke();
   },{onResponse:status=>{entry.httpStatus=status;},onFailure:category=>{entry.transportFailure=category;}}));
   void task.then(value=>{
    if(entry.controller.signal.aborted)return;
    // RailKit can return a success-shaped body even for HTTP 429/5xx.
    // Preserve structural transport evidence without guessing from error text.
    const evidence=providerTransportEvidence(value,entry.httpStatus);
    if(entry.transportFailure&&!(entry.httpStatus&&entry.httpStatus>=400)){
     evidence.failureCategory=entry.transportFailure;evidence.message=`Availability provider failure: ${entry.transportFailure}.`;
    }
    const failed=entry.transportFailure||(evidence.statusCode!==undefined&&evidence.statusCode>=400)||
     (value&&typeof value==='object'&&'success' in value&&value.success===false);
    // Materialize evidence BEFORE structuredClone/spread/serialization can lose it.
    if(failed)value={success:false,error:evidence.message,transportEvidence:evidence};
    const normalized=normalizeAvailability(value,entry.request);
    if(normalized.providerState!=='SUCCESS'){
     const transportEvidence=providerTransportEvidence(normalized,entry.httpStatus);
     value={success:false,error:transportEvidence.message,transportEvidence};
    }
    const matching=normalized.days.filter(d=>d.date===entry.request.journeyDate);
    // Only validated evidence for the exact date is reusable. NOT_AVAILABLE is
    // explicit inventory; unsupported booking/class, errors and empty days aren't.
    if(normalized.providerState==='SUCCESS'&&matching.length===1&&
       ['AVAILABLE','RAC','WAITLIST','NOT_AVAILABLE'].includes(matching[0].state)&&
       !(matching[0].canBook===false&&['AVAILABLE','RAC'].includes(matching[0].state))){
     this.remember('INVENTORY',entry.key,value);
    }else if(normalized.failureCategory==='UNSUPPORTED_CLASS'){
     this.remember('UNSUPPORTED_CLASS',entry.key,value);
     first.run(()=>availabilityMetric('providerUnsupportedResponses'));
    }
    this.settle(entry,value);
   },error=>{
    const transportEvidence=providerTransportEvidence(entry.transportFailure?{failureCategory:entry.transportFailure}:error,entry.httpStatus);
    if(!entry.controller.signal.aborted&&transportEvidence.failureCategory==='UNSUPPORTED_CLASS'){
     this.remember('UNSUPPORTED_CLASS',entry.key,{success:false,error:transportEvidence.message,transportEvidence});
     first.run(()=>availabilityMetric('providerUnsupportedResponses'));
    }
    this.settle(entry,undefined,{transportEvidence});
   }).finally(()=>{
    clearTimeout(entry.timer);this.remove(entry);this.active--;this.drain();
   });
  }
 }
 private remember(kind:CacheKind,key:string,value:unknown){
  const cache=this.caches[kind],time=this.now();
  const ttl=kind==='INVENTORY'?this.config.providerCacheTtlMs:this.config.unsupportedCacheTtlMs;
  const limit=kind==='INVENTORY'?this.config.providerCacheEntries:this.config.unsupportedCacheEntries;
  for(const [key,cached]of cache)if(cached.expires<=time)cache.delete(key);
  // Reads do not refresh TTL or insertion order; eviction is deterministic FIFO.
  this.caches.INVENTORY.delete(key);this.caches.UNSUPPORTED_CLASS.delete(key);
  while(cache.size>=limit)cache.delete(cache.keys().next().value!);
  cache.set(key,{expires:time+ttl,value:structuredClone(value)});
 }
 private settle(entry:Entry,value?:unknown,error?:unknown){
  this.remove(entry);
  for(const w of entry.waiters){this.finishWait(w);if(error instanceof PublicError&&error.code==='PROVIDER_TIMEOUT')w.run(()=>availabilityMetric('providerTimeouts'));if(error!==undefined)w.reject(error);else w.resolve(structuredClone(value));}
  entry.waiters.clear();
 }
}
let shared:AvailabilityScheduler|undefined;
export function processAvailabilityScheduler(){return shared??=new AvailabilityScheduler(hardeningConfig());}
