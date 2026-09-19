import {isAnonymousClient,type ClientIdentityClass} from '../client-identity.js';
import {JourneyV2ApiService,validateJourneyV2Request} from './journey-v2-service.js';
import type {RailwayDatabase} from '../../local-railway/database.js';
import type {AvailabilityProvider} from '../../journey/availability/types.js';
import type {HardeningConfig} from '../../config/hardening.js';
import {searchModeConfig} from '../../application/search-mode.js';
import {PublicError,ProviderConfigurationError} from '../../application/errors.js';
import {randomUUID} from 'node:crypto';
import {chargeAvailabilitySdk,emptyAvailabilityMetrics} from '../../providers/availability-observation.js';
import {parseDate} from '../../journey/connection/timing.js';
import {RailKitProvider} from '../../providers/railkit/railkit-provider.js';
import {SearchProtection,AdmissionError} from '../search-protection.js';
import {abortable,inAvailabilityScope} from '../../providers/railkit/availability-abort.js';
export interface SearchContext {signal?:AbortSignal;clientId?:string;clientIdentityClass?:ClientIdentityClass}
export function validateBookingDate(date:string,horizon:number,now=Date.now()){
 // Journey dates are Indian calendar dates, independent of server timezone.
 const today=Math.floor((now+330*60000)/86400000),day=Math.floor(parseDate(date)/1440);
 if(day<today||day>today+horizon)throw new PublicError('INVALID_DATE',`Choose a date from today through the next ${horizon} days.`);
}
export function guardedProvider(provider:AvailabilityProvider,signal:AbortSignal,timeoutMs:number,consume:()=>void):AvailabilityProvider {
 return {getAvailability:async request=>{
  signal.throwIfAborted();
  // Shared RailKit work owns its execution timeout and transport signal.
  // The search signal cancels only this waiter; quota belongs to the scheduler.
  if(provider.quotaAccounting==='SDK_INVOCATION')
   return chargeAvailabilitySdk(consume,()=>inAvailabilityScope(signal,()=>provider.getAvailability(request),{timeoutMs}));
  const timeout=new AbortController();
  const timer=setTimeout(()=>timeout.abort(new PublicError('PROVIDER_TIMEOUT','Availability provider timed out.',504)),timeoutMs);
  const combined=AbortSignal.any([signal,timeout.signal]);
  try{return await abortable(combined,()=>{
   combined.throwIfAborted();
   const invoke=()=>inAvailabilityScope(combined,()=>provider.getAvailability(request));
   consume();return invoke();
  });}
  finally{clearTimeout(timer);}
 }};
}
/** Production boundary; planner/allocation/recovery retain their exact rules. */
export class ProtectedJourneyService {
 private protection:SearchProtection;
 constructor(private readonly database:RailwayDatabase,private readonly provider:AvailabilityProvider,private readonly config:HardeningConfig,private readonly options:{diagnostics?:boolean;logger?:(r:Record<string,unknown>)=>void}={},private readonly now:()=>number=Date.now){this.protection=new SearchProtection(config,now,provider instanceof RailKitProvider?provider.availabilityScheduler.quota:undefined);}
 async search(input:unknown,requestId:string=randomUUID(),context:SearchContext={}){
  const search=validateJourneyV2Request(input);validateBookingDate(search.date,this.config.horizonDays,this.now());
  if(!this.database.station(search.from)||!this.database.station(search.to))throw new PublicError('INVALID_STATION','Station code is not present in the local railway dataset.');
  context.signal?.throwIfAborted();
  const client=context.clientId??'unknown-client';
  // Only static classification and policy flags are logged, never the identity key.
  const identityDiagnostics={clientIdentityClass:context.clientIdentityClass??(isAnonymousClient(client)?'UNKNOWN_PEER':'INTERNAL_CLIENT'),
   perClientEnforced:!isAnonymousClient(client)};
  const serviceOptions={...this.options,logger:(record:Record<string,unknown>)=>this.options.logger?.({
   ...record,...identityDiagnostics,
   ...(record.event==='journey_v2_search_started'?{protection:this.protection.snapshot(client)}:{})
  })};
  const budgetLimit=searchModeConfig(search.mode).budget!.maxAvailabilityCalls!;
  let lease:ReturnType<SearchProtection['acquire']>;
  try{
   // Search-time validation keeps health available without credentials. No planner,
   // admission or per-check budget is entered on local configuration failure.
   this.provider.assertConfigured?.();
   lease=this.protection.acquire(client,budgetLimit);
  }catch(error){
   if(error instanceof ProviderConfigurationError||error instanceof AdmissionError){
    try{this.options.logger?.({level:'error',event:'journey_v2_search_rejected',requestId,...identityDiagnostics,
     code:error.code,failureCategory:error instanceof AdmissionError?error.failureCategory:'LOCAL_CONFIGURATION_FAILURE',
     ...emptyAvailabilityMetrics(),localConfigurationFailures:Number(error instanceof ProviderConfigurationError),
     budgetLimit,budgetUsed:0,availabilityCalls:0,availabilityCallsMeaning:'BUDGETED_CHECKS',
     protection:error instanceof AdmissionError?error.counters:this.protection.snapshot(client)});}catch{/* Logging cannot affect admission. */}
   }
   throw error;
  }
  const deadline=new AbortController();
  const signal=context.signal?AbortSignal.any([context.signal,deadline.signal]):deadline.signal;
  const end=this.now()+this.config.searchTimeoutMs;
  const timer=setTimeout(()=>deadline.abort(new PublicError('SEARCH_TIMEOUT','Journey search timed out. Please try again.',504)),this.config.searchTimeoutMs);
  const checkTime=()=>{if(this.now()>=end)deadline.abort(new PublicError('SEARCH_TIMEOUT','Journey search timed out. Please try again.',504));signal.throwIfAborted();};
  const provider=guardedProvider(this.provider,signal,this.config.providerTimeoutMs,()=>{if(this.provider.quotaAccounting!=='SDK_INVOCATION'){checkTime();lease.consume();}});
  try{
   const result=await abortable(signal,()=>new JourneyV2ApiService(this.database,provider,serviceOptions).search(search,requestId));
   checkTime();return result;
  }finally{clearTimeout(timer);lease.release();}
 }
}
