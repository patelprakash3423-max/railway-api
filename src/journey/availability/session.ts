import {ProviderConfigurationError} from '../../application/errors.js';
import {emptyAvailabilityMetrics,observeAvailabilitySdk,type AvailabilityMetrics} from '../../providers/availability-observation.js';
import type { AvailabilityRequest } from '../../domain/types/availability.js';
import { SearchBudget } from '../utils/search-budget.js';
import type { TravelClass } from '../types/journey-segment.js';
import { requestKey, normalizeInventory, errorCategory } from './inventory.js';
import type { AvailabilityProvider, AvailabilityDiagnostics, InventoryCheck } from './types.js';
export type SessionStatistics = Pick<AvailabilityDiagnostics,'availabilityBudgetLimit'|'availabilityRequestsUsed'|'availabilityCacheHits'|'budgetRemaining'|'classChecksByClass'|'availableResponses'|'racResponses'|'waitlistResponses'|'unavailableResponses'|'unsupportedClassResponses'|'providerErrors'|'providerErrorCategories'> & AvailabilityMetrics;
/** One user request, shared by whole-leg validation and subsequent recovery.
 * Callers serialize atomic groups; exact concurrent requests are also deduplicated. */
export class AvailabilitySession {
  readonly budget: SearchBudget;
  readonly unsupported = new Map<string, Set<TravelClass>>();
  private readonly cache = new Map<string, InventoryCheck>();
  private readonly pending = new Map<string, Promise<InventoryCheck>>();
  private readonly counts: Omit<SessionStatistics,'availabilityBudgetLimit'|'availabilityRequestsUsed'|'budgetRemaining'> = { ...emptyAvailabilityMetrics(),availabilityCacheHits:0,classChecksByClass:{},availableResponses:0,racResponses:0,waitlistResponses:0,unavailableResponses:0,unsupportedClassResponses:0,providerErrors:0,providerErrorCategories:{} };
  constructor(private readonly provider: AvailabilityProvider, readonly limit: number) { this.budget = new SearchBudget({ maxAvailabilityCalls:limit }); }
  private allowanceEnd = Infinity;
  private readonly skippedClasses = new Set<string>();
  private configurationChecked = false;
  private configurationFailure?: ProviderConfigurationError;
  recordUnsupportedClassSkip(trainNumber: string, travelClass: string): void {
    this.skippedClasses.add(JSON.stringify([trainNumber, travelClass]));
  }
  private checkConfiguration(): void {
    if (this.configurationFailure) throw this.configurationFailure;
    if (this.configurationChecked) return;
    try { this.provider.assertConfigured?.(); this.configurationChecked = true; }
    catch (error) {
      if (error instanceof ProviderConfigurationError) {
        this.counts.localConfigurationFailures++;
        this.configurationFailure = error;
      }
      throw error;
    }
  }
  /** A serialized scope caps spending inside the existing global budget/cache. */
  async withAllowance<T>(calls: number, work: () => Promise<T>): Promise<T> {
    if (!Number.isSafeInteger(calls) || calls < 0) throw new Error('Invalid session allowance');
    const previous = this.allowanceEnd;
    this.allowanceEnd = Math.min(previous, this.budget.callsUsed + calls);
    try { return await work(); } finally { this.allowanceEnd = previous; }
  }
  get remaining() { return Math.max(0, Math.min(this.limit, this.allowanceEnd) - this.budget.callsUsed); }
  peekKey(key: string) { return this.cache.get(key); }
  hasKey(key: string) { return this.cache.has(key) || this.pending.has(key); }
  missingRequests(requests: AvailabilityRequest[]) { return new Set(requests.map(requestKey).filter(key=>!this.hasKey(key))).size; }
  canAfford(requests: AvailabilityRequest[]) { return this.missingRequests(requests) <= this.remaining; }
  statistics(): SessionStatistics { return { ...this.counts, classChecksByClass:{...this.counts.classChecksByClass},providerErrorCategories:{...this.counts.providerErrorCategories},availabilityBudgetLimit:this.limit,availabilityRequestsUsed:this.budget.callsUsed,attemptedAvailabilityChecks:this.budget.callsUsed,cacheHits:this.counts.availabilityCacheHits,unsupportedClassSkips:this.skippedClasses.size,budgetRemaining:this.remaining }; }
  async get(request: AvailabilityRequest): Promise<InventoryCheck> {
    this.checkConfiguration();
    const r={...request},key=requestKey(r),hit=this.cache.get(key),pending=this.pending.get(key);
    if(hit||pending){this.counts.availabilityCacheHits++;return hit??pending!;}
    if(this.remaining < 1) throw new Error('Availability allowance exhausted');
    this.budget.consumeCall();const c=r.travelClass as TravelClass;this.counts.classChecksByClass[c]=(this.counts.classChecksByClass[c]??0)+1;
    // Defer invocation one microtask so the in-flight key exists even if a provider throws.
    const task=Promise.resolve().then(async()=>{
      let result:InventoryCheck;
      try{result=normalizeInventory(r,await observeAvailabilitySdk(()=>{this.counts.actualSdkInvocations++;},()=>this.provider.getAvailability({...r})));}catch(error){
        if (error instanceof ProviderConfigurationError) {
          this.counts.localConfigurationFailures++;
          this.configurationFailure = error;
          this.pending.delete(key);
          throw error;
        }
        const category=errorCategory(error);
        const explicit=error&&typeof error==='object'&&(error as {failureCategory?:string}).failureCategory==='UNSUPPORTED_CLASS';
        result={travelClass:c,status:'PROVIDER_ERROR',errorCategory:category,...(category==='UNSUPPORTED_CLASS'&&!explicit?{unsupportedScope:'EXACT_REQUEST' as const}:{})};
      }
      if(['AVAILABLE','RAC','WAITLIST','UNAVAILABLE'].includes(result.status))this.counts.providerSuccesses++;
      if(result.errorCategory==='UNSUPPORTED_CLASS')result={...result,status:'UNSUPPORTED_CLASS'};
      this.cache.set(key,result);
      if(result.errorCategory==='UNSUPPORTED_CLASS'&&result.unsupportedScope!=='EXACT_REQUEST'){const known=this.unsupported.get(r.trainNumber)??new Set<TravelClass>();known.add(c);this.unsupported.set(r.trainNumber,known);}
      if(result.status==='AVAILABLE')this.counts.availableResponses++;else if(result.status==='RAC')this.counts.racResponses++;else if(result.status==='WAITLIST')this.counts.waitlistResponses++;else if(result.status==='UNAVAILABLE')this.counts.unavailableResponses++;else if(result.errorCategory==='UNSUPPORTED_CLASS')this.counts.unsupportedClassResponses++;else{this.counts.providerErrors++;const category=result.errorCategory??'UNKNOWN_PROVIDER_ERROR';this.counts.providerErrorCategories[category]=(this.counts.providerErrorCategories[category]??0)+1;}
      this.pending.delete(key);return result;
    });
    this.pending.set(key,task);return task;
  }
}
