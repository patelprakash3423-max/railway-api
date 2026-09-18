import {AsyncLocalStorage} from 'node:async_hooks';

export interface AvailabilityMetrics {
  attemptedAvailabilityChecks: number;
  actualSdkInvocations: number;
  cacheHits: number;
  providerSuccesses: number;
  providerErrors: number;
  localConfigurationFailures: number;
  unsupportedClassSkips: number;
}
export const emptyAvailabilityMetrics = (): AvailabilityMetrics => ({
  attemptedAvailabilityChecks: 0, actualSdkInvocations: 0, cacheHits: 0,
  providerSuccesses: 0, providerErrors: 0, localConfigurationFailures: 0,
  unsupportedClassSkips: 0,
});

const observer = new AsyncLocalStorage<() => void>();
const quota = new AsyncLocalStorage<() => void>();
export function observeAvailabilitySdk<T>(onInvocation: () => void, work: () => Promise<T>): Promise<T> {
  return observer.run(onInvocation, work);
}
export function chargeAvailabilitySdk<T>(charge: () => void, work: () => Promise<T>): Promise<T> {
  return quota.run(charge, work);
}
/** Called after local validation/configuration, immediately before the SDK.
 * This proves an SDK invocation, not an HTTP start or a billable request. */
export function availabilitySdkInvoked(): void {
  quota.getStore()?.();
  observer.getStore()?.();
}
