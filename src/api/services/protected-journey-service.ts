import {JourneyV2ApiService,validateJourneyV2Request} from './journey-v2-service.js';
import type {RailwayDatabase} from '../../local-railway/database.js';
import type {AvailabilityProvider} from '../../journey/availability/types.js';
import type {HardeningConfig} from '../../config/hardening.js';
import {searchModeConfig} from '../../application/search-mode.js';
import {PublicError} from '../../application/errors.js';
import {parseDate} from '../../journey/connection/timing.js';
import {SearchProtection} from '../search-protection.js';
import {abortable,inAvailabilityScope} from '../../providers/railkit/availability-abort.js';
export interface SearchContext {signal?:AbortSignal;clientId?:string}
export function validateBookingDate(date:string,horizon:number,now=Date.now()){
 // Journey dates are Indian calendar dates, independent of server timezone.
 const today=Math.floor((now+330*60000)/86400000),day=Math.floor(parseDate(date)/1440);
 if(day<today||day>today+horizon)throw new PublicError('INVALID_DATE',`Choose a date from today through the next ${horizon} days.`);
}
export function guardedProvider(provider:AvailabilityProvider,signal:AbortSignal,timeoutMs:number,consume:()=>void):AvailabilityProvider {
 return {getAvailability:async request=>{
  signal.throwIfAborted();
  const timeout=new AbortController();
  const timer=setTimeout(()=>timeout.abort(new PublicError('PROVIDER_TIMEOUT','Availability provider timed out.',504)),timeoutMs);
  const combined=AbortSignal.any([signal,timeout.signal]);
  try{return await abortable(combined,()=>{combined.throwIfAborted();consume();return inAvailabilityScope(combined,()=>provider.getAvailability(request));});}
  finally{clearTimeout(timer);}
 }};
}
/** Production boundary; planner/allocation/recovery retain their exact rules. */
export class ProtectedJourneyService {
 private protection:SearchProtection;
 constructor(private readonly database:RailwayDatabase,private readonly provider:AvailabilityProvider,private readonly config:HardeningConfig,private readonly options:{diagnostics?:boolean;logger?:(r:Record<string,unknown>)=>void}={},private readonly now:()=>number=Date.now){this.protection=new SearchProtection(config,now);}
 async search(input:unknown,requestId?:string,context:SearchContext={}){
  const search=validateJourneyV2Request(input);validateBookingDate(search.date,this.config.horizonDays,this.now());
  if(!this.database.station(search.from)||!this.database.station(search.to))throw new PublicError('INVALID_STATION','Station code is not present in the local railway dataset.');
  context.signal?.throwIfAborted();
  const lease=this.protection.acquire(context.clientId??'unknown-client',searchModeConfig(search.mode).budget!.maxAvailabilityCalls!);
  const deadline=new AbortController();
  const signal=context.signal?AbortSignal.any([context.signal,deadline.signal]):deadline.signal;
  const end=this.now()+this.config.searchTimeoutMs;
  const timer=setTimeout(()=>deadline.abort(new PublicError('SEARCH_TIMEOUT','Journey search timed out. Please try again.',504)),this.config.searchTimeoutMs);
  const checkTime=()=>{if(this.now()>=end)deadline.abort(new PublicError('SEARCH_TIMEOUT','Journey search timed out. Please try again.',504));signal.throwIfAborted();};
  const provider=guardedProvider(this.provider,signal,this.config.providerTimeoutMs,()=>{checkTime();lease.consume();});
  try{
   const result=await abortable(signal,()=>new JourneyV2ApiService(this.database,provider,this.options).search(search,requestId));
   checkTime();return result;
  }finally{clearTimeout(timer);lease.release();}
 }
}
