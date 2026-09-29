import {AsyncLocalStorage} from 'node:async_hooks';
import {searchTimingCounter} from '../utils/search-timing.js';
export interface AvailabilityMetrics {
 redisCacheHits:number;redisCacheMisses:number;redisCacheStale:number;redisCacheReadErrors:number;redisCacheWriteErrors:number;
 hotCacheHits:number;persistentCacheHits:number;persistentCacheMisses:number;persistentCacheStale:number;persistentCacheReadErrors:number;persistentCacheWriteErrors:number;
 logicalAvailabilityChecks:number;attemptedAvailabilityChecks:number;actualSdkInvocations:number;cacheHits:number;
 providerSuccesses:number;providerErrors:number;localConfigurationFailures:number;unsupportedClassSkips:number;
 providerQueueWaits:number;providerQueueWaitMs:number;sharedInflightHits:number;sharedCacheHits:number;
 unsupportedEvidenceCacheHits:number;providerUnsupportedResponses:number;
 providerRateLimited:number;providerTimeouts:number;
}
export const emptyAvailabilityMetrics=():AvailabilityMetrics=>({
 redisCacheHits:0,redisCacheMisses:0,redisCacheStale:0,redisCacheReadErrors:0,redisCacheWriteErrors:0,
 hotCacheHits:0,persistentCacheHits:0,persistentCacheMisses:0,persistentCacheStale:0,persistentCacheReadErrors:0,persistentCacheWriteErrors:0,
 logicalAvailabilityChecks:0,attemptedAvailabilityChecks:0,actualSdkInvocations:0,cacheHits:0,providerSuccesses:0,providerErrors:0,
 localConfigurationFailures:0,unsupportedClassSkips:0,providerQueueWaits:0,providerQueueWaitMs:0,
 unsupportedEvidenceCacheHits:0,providerUnsupportedResponses:0,
 sharedInflightHits:0,sharedCacheHits:0,providerRateLimited:0,providerTimeouts:0,
});
const observer=new AsyncLocalStorage<()=>void>();
const metrics=new AsyncLocalStorage<(key:keyof AvailabilityMetrics,amount:number)=>void>();
const quota=new AsyncLocalStorage<()=>void>();
export function observeAvailabilityMetrics<T>(record:(key:keyof AvailabilityMetrics,amount:number)=>void,work:()=>Promise<T>):Promise<T>{return metrics.run(record,work);}
export function availabilityMetric(key:keyof AvailabilityMetrics,amount=1){searchTimingCounter(key,amount);metrics.getStore()?.(key,amount);}
export function observeAvailabilitySdk<T>(onInvocation:()=>void,work:()=>Promise<T>):Promise<T>{return observer.run(onInvocation,work);}
export function chargeAvailabilitySdk<T>(charge:()=>void,work:()=>Promise<T>):Promise<T>{return quota.run(charge,work);}
/** SDK invocation, not proof of network traffic or billing. */
export function availabilitySdkInvoked():void{quota.getStore()?.();searchTimingCounter('actualSdkInvocations');observer.getStore()?.();}
