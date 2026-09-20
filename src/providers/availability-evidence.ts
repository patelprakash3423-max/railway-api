import {AsyncLocalStorage} from 'node:async_hooks';
import type {AvailabilityRequest,AvailabilityResult} from '../domain/types/availability.js';
import {providerFailureCategories,type ProviderFailureCategory} from '../domain/types/provider-failure.js';
export const identityPresenceFields=['providerTrainIdentityPresent','providerFromIdentityPresent','providerToIdentityPresent','providerClassIdentityPresent','providerQuotaIdentityPresent','providerJourneyDateIdentityPresent'] as const;
export type ProviderIdentityEvidence=Record<typeof identityPresenceFields[number],boolean>&{
 providerIdentityValidation:'VALIDATED'|'REJECTED'|'NOT_PROVIDED'|'NOT_EVALUATED';
};
export type AvailabilityEvidenceSource='FRESH_PROVIDER'|'SHARED_INFLIGHT'|'SHARED_CACHE'|'UNSUPPORTED_EVIDENCE_CACHE'|'SEARCH_LOCAL_CACHE'|'NOT_OBSERVED';
export interface AvailabilityEvidence extends ProviderIdentityEvidence {
 trainNumber:string;from:string;to:string;requestedDate:string;travelClass:string;quota:'GN';
 resultStatus:string;availabilityText?:string;canBook:boolean|'ABSENT';
 matchingAvailabilityRows:number|null;exactRequestedDateFound:boolean|null;
 evidenceSource:AvailabilityEvidenceSource;sdkInvokedForCheck:boolean;
 failureCategory?:ProviderFailureCategory|'PROVIDER_UNAVAILABLE';
}
export function safeIdentityEvidence(value?:Partial<ProviderIdentityEvidence>):ProviderIdentityEvidence {
 return {...Object.fromEntries(identityPresenceFields.map(k=>[k,value?.[k]===true])) as Record<typeof identityPresenceFields[number],boolean>,
  providerIdentityValidation:['VALIDATED','REJECTED','NOT_PROVIDED'].includes(value?.providerIdentityValidation??'')?value!.providerIdentityValidation!:'NOT_EVALUATED'};
}
/** Reject arbitrary provider messages; never rely on redaction as an allowlist. */
export function safeAvailabilityText(value:unknown):string|undefined {
 if(typeof value!=='string'||value.length>64)return undefined;
 const text=value.trim();
 return /^(?:(?:AVAILABLE|AVBL|AVL)(?:[ ]*[-:]?[ ]*\d{1,6})?|RAC(?:[ ]*[-:]?[ ]*\d{1,6})?(?:[ ]*\/[ ]*RAC[ ]*\d{1,6})?|(?:GNWL|RLWL|PQWL|RQWL|TQWL|WL)[ ]*\d{1,6}(?:[ ]*\/[ ]*WL[ ]*\d{1,6})?|WAITLIST|NOT_AVAILABLE)$/i.test(text)&&!/[\r\n\t]/.test(text)?text:undefined;
}
const identityObserver=new AsyncLocalStorage<(identity:ProviderIdentityEvidence)=>void>();
export function observeProviderIdentity<T>(record:(identity:ProviderIdentityEvidence)=>void,work:()=>Promise<T>):Promise<T>{return identityObserver.run(record,work);}
/** The scheduler calls this in each waiter's context before discarding raw identity. */
export function providerIdentityObserved(identity:ProviderIdentityEvidence){identityObserver.getStore()?.(safeIdentityEvidence(identity));}
const logger=new AsyncLocalStorage<((evidence:AvailabilityEvidence)=>void)|undefined>();
export function withAvailabilityEvidenceLogger<T>(record:((evidence:AvailabilityEvidence)=>void)|undefined,work:()=>Promise<T>):Promise<T>{return logger.run(record,work);}
export function availabilityEvidence(request:AvailabilityRequest,check:{status:string;errorCategory?:string;rawDetails?:AvailabilityResult},source:AvailabilityEvidenceSource,sdkInvoked:boolean,identity?:ProviderIdentityEvidence):AvailabilityEvidence {
 const raw=check.rawDetails,rows=raw?.providerState==='SUCCESS'&&Array.isArray(raw.days)?raw.days.filter(d=>d.date===request.journeyDate):undefined;
 const day=rows?.length===1?rows[0]:undefined;
 const failure=check.errorCategory;
 return {trainNumber:request.trainNumber,from:request.fromStationCode,to:request.toStationCode,requestedDate:request.journeyDate,travelClass:request.travelClass,quota:request.quota,
  resultStatus:check.status,...safeIdentityEvidence(identity??raw?.identityEvidence),
  ...(safeAvailabilityText(day?.availabilityText)?{availabilityText:safeAvailabilityText(day!.availabilityText)}:{}),
  canBook:typeof day?.canBook==='boolean'?day.canBook:'ABSENT',matchingAvailabilityRows:rows?.length??null,exactRequestedDateFound:rows?rows.length>0:null,
  evidenceSource:source,sdkInvokedForCheck:sdkInvoked,
  ...(failure&&(providerFailureCategories.includes(failure as ProviderFailureCategory)||failure==='PROVIDER_UNAVAILABLE')?{failureCategory:failure as ProviderFailureCategory|'PROVIDER_UNAVAILABLE'}:{})};
}
export function emitAvailabilityEvidence(evidence:AvailabilityEvidence):void {
 // Requests normally arrive validated. Never log arbitrary strings from injected callers.
 if(!/^\d{5}$/.test(evidence.trainNumber)||![evidence.from,evidence.to].every(c=>/^[A-Z0-9]{1,5}$/.test(c))||!/^\d{2}-\d{2}-\d{4}$/.test(evidence.requestedDate)||!['SL','3A','2A','CC','2S','1A','EC','3E'].includes(evidence.travelClass)||evidence.quota!=='GN')return;
 try{logger.getStore()?.({...evidence});}catch{/* Diagnostics cannot fail a search. */}
}
