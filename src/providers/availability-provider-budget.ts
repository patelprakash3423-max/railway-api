import {AsyncLocalStorage} from 'node:async_hooks';

/** Application per-search safety ceiling, independent of provider window/account quotas. */
export const maximumAvailabilityProviderCalls = 500;
export interface ProviderCallDiagnostics {
  providerAvailabilityCalls:number;
  providerCallBudgetLimit:number;
  providerCallBudgetRemaining:number;
  providerCallBudgetExhausted:boolean;
}
/** Internal control flow, never negative inventory or shared-cache evidence. */
export class ProviderCallBudgetExhausted extends Error {
  readonly failureCategory = 'PROVIDER_BUDGET_EXHAUSTED' as const;
  constructor(){super('Availability provider request budget exhausted.');}
}
export class AvailabilityProviderBudget {
  private used=0;
  private denied=false;
  constructor(readonly limit=maximumAvailabilityProviderCalls){
    if(!Number.isSafeInteger(limit)||limit<1||limit>maximumAvailabilityProviderCalls)
      throw new Error('Invalid availability provider request limit');
  }
  get stopped(){return this.denied;}
  /** Reserve synchronously before other admission checks; roll back only when
   * admission fails. No await or check/increment split can oversubscribe it. */
  acquire(admit:()=>void=()=>{}):void {
    if(this.used>=this.limit){this.denied=true;throw new ProviderCallBudgetExhausted();}
    this.used++;
    try{admit();}catch(error){this.used--;throw error;}
  }
  statistics():ProviderCallDiagnostics {
    return {providerAvailabilityCalls:this.used,providerCallBudgetLimit:this.limit,
      providerCallBudgetRemaining:this.limit-this.used,providerCallBudgetExhausted:this.used===this.limit};
  }
}
const searchBudget=new AsyncLocalStorage<AvailabilityProviderBudget>();
const attempt=new AsyncLocalStorage<{firstTransport:boolean;admit:()=>void}>();
export function withAvailabilityProviderBudget<T>(budget:AvailabilityProviderBudget,work:()=>Promise<T>):Promise<T>{
  return searchBudget.run(budget,work);
}
/** Called only by the executing cache/dedupe owner immediately before the SDK
 * (or an injected adapter with no internal cache). Thrown attempts still count. */
export function invokeAvailabilityProvider<T>(admit:()=>void,work:()=>Promise<T>):Promise<T>{
  const budget=searchBudget.getStore();
  if(budget)budget.acquire(admit);else admit();
  return attempt.run({firstTransport:true,admit},work);
}
/** The first fetch belongs to its admitted SDK call. Additional SDK fetches,
 * including retries, require another admission before touching the transport. */
export function admitAvailabilityTransport():void {
  const invocation=attempt.getStore();
  if(!invocation)return;
  if(invocation.firstTransport){invocation.firstTransport=false;return;}
  const budget=searchBudget.getStore();
  if(budget)budget.acquire(invocation.admit);else invocation.admit();
}
