import type {AvailabilityRequest,AvailabilityResult,AvailabilityDay} from '../../domain/types/availability.js';
import {availabilityRequestKey} from '../../utils/availability-key.js';
import {identityPresenceFields,safeAvailabilityText,type ProviderIdentityEvidence} from '../availability-evidence.js';
import {normalizeAvailability} from '../railkit/railkit-normalizers.js';
export const observationNamespace='railkit:availability:v1';
/** Storage can isolate future quota codes without expanding the GN-only API. */
export type AvailabilityIdentity=Omit<AvailabilityRequest,'quota'>&{quota:string};
export type ObservationResult=Omit<AvailabilityResult,'request'>&{request:AvailabilityIdentity};
export interface AvailabilityObservation {namespace:typeof observationNamespace;identity:AvailabilityIdentity;observedAt:number;result:ObservationResult}
export interface AvailabilityObservationStore {
 getLatest(identity:AvailabilityIdentity):unknown|Promise<unknown>;
 upsertLatest(observation:AvailabilityObservation):void|Promise<void>;
 cleanup(now:number):number|Promise<number>;
 close():void;
}
export interface ObservationMetadata {observedAt:number;freshUntil:number}
const metadata=new WeakMap<object,ObservationMetadata>();
export function attachObservation(value:unknown,observation?:ObservationMetadata){if(value&&typeof value==='object'&&observation)metadata.set(value,{...observation});return value;}
export function observationMetadata(value:unknown){return value&&typeof value==='object'?metadata.get(value):undefined;}
const object=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('Invalid observation object');return v as Record<string,unknown>;};
export function canonicalAvailabilityIdentity(value:AvailabilityIdentity):AvailabilityIdentity {
 const [trainNumber,fromStationCode,toStationCode,journeyDate,travelClass,quota]=JSON.parse(availabilityRequestKey(value as AvailabilityRequest)) as string[];
 if(!/^\d{5}$/.test(trainNumber)||![fromStationCode,toStationCode].every(s=>/^[A-Z0-9]{1,5}$/.test(s))||fromStationCode===toStationCode||!['SL','3A','2A','1A','3E','2S','CC','EC'].includes(travelClass)||! /^[A-Z]{1,4}$/.test(quota))throw Error('Invalid observation identity');
 journeyMidnight(journeyDate);
 return {trainNumber,fromStationCode,toStationCode,journeyDate,travelClass,quota};
}
export function observationKey(value:AvailabilityIdentity){return JSON.stringify([observationNamespace,...JSON.parse(availabilityRequestKey(canonicalAvailabilityIdentity(value) as AvailabilityRequest))]);}
/** Boarding-date midnight in Asia/Kolkata. Date-only inventory has no exact departure time. */
export function journeyMidnight(date:string):number {
 const m=/^(\d{2})-(\d{2})-(\d{4})$/.exec(date);if(!m)throw Error('Invalid observation date');
 const [d,month,y]=m.slice(1).map(Number),utc=Date.UTC(y,month-1,d),check=new Date(utc);
 if(check.getUTCFullYear()!==y||check.getUTCMonth()!==month-1||check.getUTCDate()!==d)throw Error('Invalid observation date');
 return utc-330*60000;
}
/** Reconstruct only fields the adapter actually validated, preserving absent identity. */
export function observationEnvelope(result:ObservationResult):unknown {
 const r=result.request,i=result.identityEvidence!,day=result.days[0],train:Record<string,unknown>={};
 for(const [flag,field,value] of [['providerTrainIdentityPresent','trainNo',r.trainNumber],['providerFromIdentityPresent','from',r.fromStationCode],['providerToIdentityPresent','to',r.toStationCode],['providerClassIdentityPresent','travelClass',r.travelClass],['providerQuotaIdentityPresent','quota',r.quota]] as const)if(i[flag])train[field]=value;
 return {success:true,data:{...(Object.keys(train).length?{train}:{}),...(i.providerJourneyDateIdentityPresent?{journeyDate:r.journeyDate}:{}),...(result.fare?{fare:result.fare}:{}),availability:[{date:day.date,status:day.state,...(day.availabilityText!==undefined?{availabilityText:day.availabilityText}:{}),...(day.rawStatus!==undefined?{rawStatus:day.rawStatus}:{}),...(day.canBook!==undefined?{canBook:day.canBook}:{})}]}};
}
/** Whitelist normalized evidence on BOTH writes and reads; never store arbitrary raw payloads. */
export function makeObservation(value:ObservationResult,observedAt:number):AvailabilityObservation {
 const raw=object(value),identity=canonicalAvailabilityIdentity(raw.request as AvailabilityIdentity);
 if(raw.provider!=='railkit'||raw.providerState!=='SUCCESS'||raw.failureCategory!==undefined||raw.transportEvidence!==undefined||!Number.isSafeInteger(observedAt)||observedAt<0||!Array.isArray(raw.days))throw Error('Invalid observation');
 const days=raw.days.filter(d=>{const item=object(d);return canonicalDate(item.date)===identity.journeyDate;});
 if(days.length!==1)throw Error('Ambiguous observation date');
 const d=object(days[0]);if(!['AVAILABLE','RAC','WAITLIST','NOT_AVAILABLE'].includes(String(d.state)))throw Error('Invalid observation status');
 if(d.canBook!==undefined&&typeof d.canBook!=='boolean')throw Error('Invalid observation bookability');
 if(d.canBook===false&&['AVAILABLE','RAC'].includes(String(d.state)))throw Error('Unbookable inventory is not reusable');
 const presence=object(raw.identityEvidence);
 if(identityPresenceFields.some(k=>typeof presence[k]!=='boolean'))throw Error('Missing identity validation');
 const hasIdentity=identityPresenceFields.some(k=>presence[k]===true);
 if(presence.providerIdentityValidation!==(hasIdentity?'VALIDATED':'NOT_PROVIDED'))throw Error('Invalid identity validation');
 const identityEvidence=Object.fromEntries([...identityPresenceFields.map(k=>[k,presence[k]]),['providerIdentityValidation',presence.providerIdentityValidation]]) as ProviderIdentityEvidence;
 const day:AvailabilityDay={date:identity.journeyDate,state:d.state as AvailabilityDay['state']};
 for(const field of ['availabilityText','rawStatus'] as const){if(d[field]!==undefined){const text=safeAvailabilityText(d[field]);if(text)day[field]=text;}}
 if(typeof d.canBook==='boolean')day.canBook=d.canBook;
 let fare:AvailabilityResult['fare'];
 if(raw.fare!==undefined){const f=object(raw.fare);if(f.currency!=='INR'||typeof f.totalFare!=='number'||!Number.isFinite(f.totalFare)||f.totalFare<0)throw Error('Invalid observation fare');fare={currency:'INR',totalFare:f.totalFare};for(const k of ['baseFare','reservationCharge','superfastCharge','serviceTax'] as const){if(f[k]!==undefined){if(typeof f[k]!=='number'||!Number.isFinite(f[k])||f[k]<0)throw Error('Invalid observation fare');fare[k]=f[k];}}}
 const result:ObservationResult={request:identity,provider:'railkit',providerState:'SUCCESS',identityEvidence,days:[day],...(fare?{fare}:{})};
 // Reuse the real adapter to derive counts/WL numbers; no competing status parser.
 const normalized=normalizeAvailability(observationEnvelope(result),identity as AvailabilityRequest);
 if(normalized.providerState!=='SUCCESS')throw Error('Invalid observation reconstruction');
 for(const field of ['availableCount','waitlistNumber','waitlistType'] as const)if(d[field]!==undefined&&d[field]!==normalized.days[0][field])throw Error('Conflicting normalized observation count');
 return {namespace:observationNamespace,identity,observedAt,result:normalized};
}
function canonicalDate(v:unknown){if(typeof v!=='string')throw Error('Invalid observation date');const [, , , date]=JSON.parse(availabilityRequestKey({trainNumber:'00001',fromStationCode:'A',toStationCode:'B',journeyDate:v,travelClass:'SL',quota:'GN'}));journeyMidnight(date);return date as string;}
export function validateObservation(value:unknown,expected?:AvailabilityIdentity):AvailabilityObservation {
 const raw=object(value);if(raw.namespace!==observationNamespace)throw Error('Invalid observation version');
 const stored=object(raw.result);if(!Array.isArray(stored.days)||stored.days.length!==1)throw Error('Invalid persisted date rows');
 const identity=canonicalAvailabilityIdentity(raw.identity as AvailabilityIdentity),result=makeObservation(raw.result as ObservationResult,raw.observedAt as number);
 if(observationKey(identity)!==observationKey(result.identity)||(expected&&observationKey(identity)!==observationKey(expected)))throw Error('Conflicting observation identity');
 return result;
}
