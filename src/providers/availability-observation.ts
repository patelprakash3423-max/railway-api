import {AsyncLocalStorage} from 'node:async_hooks';
export interface AvailabilityMetrics {
 attemptedAvailabilityChecks:number;actualSdkInvocations:number;cacheHits:number;
 providerSuccesses:number;providerErrors:number;localConfigurationFailures:number;unsupportedClassSkips:number;
 providerQueueWaits:number;providerQueueWaitMs:number;sharedInflightHits:number;sharedCacheHits:number;
 unsupportedEvidenceCacheHits:number;providerUnsupportedResponses:number;
 providerRateLimited:number;providerTimeouts:number;
}
export const emptyAvailabilityMetrics=():AvailabilityMetrics=>({
 attemptedAvailabilityChecks:0,actualSdkInvocations:0,cacheHits:0,providerSuccesses:0,providerErrors:0,
 localConfigurationFailures:0,unsupportedClassSkips:0,providerQueueWaits:0,providerQueueWaitMs:0,
 unsupportedEvidenceCacheHits:0,providerUnsupportedResponses:0,
 sharedInflightHits:0,sharedCacheHits:0,providerRateLimited:0,providerTimeouts:0,
});
const observer=new AsyncLocalStorage<()=>void>();
const metrics=new AsyncLocalStorage<(key:keyof AvailabilityMetrics,amount:number)=>void>();
const quota=new AsyncLocalStorage<()=>void>();
export function observeAvailabilityMetrics<T>(record:(key:keyof AvailabilityMetrics,amount:number)=>void,work:()=>Promise<T>):Promise<T>{return metrics.run(record,work);}
export function availabilityMetric(key:keyof AvailabilityMetrics,amount=1){metrics.getStore()?.(key,amount);}
export function observeAvailabilitySdk<T>(onInvocation:()=>void,work:()=>Promise<T>):Promise<T>{return observer.run(onInvocation,work);}
export function chargeAvailabilitySdk<T>(charge:()=>void,work:()=>Promise<T>):Promise<T>{return quota.run(charge,work);}
/** SDK invocation, not proof of network traffic or billing. */
export function availabilitySdkInvoked():void{quota.getStore()?.();observer.getStore()?.();}
