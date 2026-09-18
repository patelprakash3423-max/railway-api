import {ProviderConfigurationError} from '../../application/errors.js';
import {emptyAvailabilityMetrics} from '../../providers/availability-observation.js';
import {presentJourneys} from '../../journey/presentation/index.js';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {RailwayDatabase} from '../../local-railway/database.js';
import {PlannerV2JourneyRecoveryService,type RecoveredJourney} from '../../journey/availability/journey/orchestrator.js';
import type {AvailabilityProvider} from '../../journey/availability/types.js';
import {travelClasses} from '../../journey/types/journey-segment.js';
import {parseDate} from '../../journey/connection/timing.js';
import {PublicError} from '../../application/errors.js';
import type {JourneyV2Request,JourneyV2Response,JourneyV2Result} from './journey-v2-model.js';

export function openProductionRailwayDatabase(path=process.env.LOCAL_RAILWAY_DB_PATH??'data/local-railway/railway.sqlite'){
 let db:RailwayDatabase|undefined;
 try{
  db=new RailwayDatabase(resolve(path),true);const metadata=db.metadata();
  if(metadata.source!=='RAILPULL_NTES'||!metadata.label||/synthetic|fixture|test/i.test(metadata.label)||!Number.isFinite(Date.parse(metadata.importedAt)))throw Error('Invalid production dataset metadata');
  for(const [table,count]of [['trains',metadata.trainCount],['stations',metadata.stationCount],['train_stops',metadata.stopCount]]as const){
   if(!Number.isSafeInteger(count)||count<1||Number(db.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n)!==count)throw Error('Invalid production dataset counts');
  }
  return db;
 }catch{db?.close();throw new PublicError('DATASET_CONFIGURATION_ERROR','Local railway dataset is missing, invalid, or marked as a test fixture. Configure LOCAL_RAILWAY_DB_PATH with an imported production RailPull dataset.',503);}
}
export function validateJourneyV2Request(value:unknown):JourneyV2Response['search']{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new PublicError('INVALID_REQUEST','A search object is required.');
 const v=value as Record<string,unknown>;
 const station=(s:unknown)=>typeof s==='string'?s.trim().toUpperCase():'';
 const from=station(v.from),to=station(v.to);
 if(!/^[A-Z0-9]{1,5}$/.test(from)||!/^[A-Z0-9]{1,5}$/.test(to)||from===to)throw new PublicError('INVALID_STATION','Choose two different valid station codes.');
 if(typeof v.date!=='string')throw new PublicError('INVALID_DATE','Use DD-MM-YYYY.');
 try{parseDate(v.date);}catch{throw new PublicError('INVALID_DATE','Use a valid DD-MM-YYYY date.');}
 const mode=v.mode??'STANDARD';if(typeof mode!=='string'||!['QUICK','STANDARD','DEEP'].includes(mode))throw new PublicError('INVALID_REQUEST','Invalid search mode.');
 if(v.quota!==undefined&&v.quota!=='GN')throw new PublicError('INVALID_REQUEST','Only GN quota is supported.');
 let classes:JourneyV2Request['classes'];
 if(v.classes==='ALL')classes='ALL';
 else if(Array.isArray(v.classes)&&v.classes.length&&v.classes.every(c=>typeof c==='string')){
  const normalized=[...new Set(v.classes.map(c=>(c as string).trim().toUpperCase()))];
  if(normalized.length===1&&normalized[0]==='ALL')classes='ALL';
  else if(normalized.every(c=>travelClasses.includes(c as typeof travelClasses[number])))classes=normalized;
  else throw new PublicError('INVALID_CLASS','Choose supported travel classes or ALL alone.');
 }else throw new PublicError('INVALID_CLASS','Choose supported travel classes or ALL.');
 return {from,to,date:v.date,classes,mode:mode as JourneyV2Response['search']['mode'],quota:'GN'};
}
export function serializeJourneyV2(j:RecoveredJourney):JourneyV2Result{
 const parts=j.legs.flatMap(l=>l.segments.flatMap(s=>s.type==='RESERVED'?s.reservationParts:[]));
 const known=parts.some(p=>p.fare!==undefined);
 return {id:j.scheduleCandidateId,status:j.journeyStatus,from:j.scheduleCandidate.from,to:j.scheduleCandidate.to,departureDateTime:j.scheduleCandidate.departureDateTime,arrivalDateTime:j.scheduleCandidate.arrivalDateTime,totalDurationMinutes:j.scheduleCandidate.durationMinutes,totalDistanceKm:j.totalDistanceKm,trainChanges:j.trainChanges,classChanges:j.classChanges,reservedCoverageRatio:j.reservedCoverageRatio,unknownDistanceKm:j.unknownDistanceKm,
 totalFare:{status:j.fareComplete?'COMPLETE':known?'PARTIAL':'UNKNOWN',amount:known?j.knownReservedFare:null,currency:'INR'},
 connections:j.scheduleCandidate.connections.map(c=>({station:c.station,waitMinutes:c.minutes,safety:c.safety})),
 legs:j.legs.map((l,i)=>({trainNumber:l.trainNumber,trainName:j.scheduleCandidate.segments[i].trainName,scheduledFrom:l.scheduledFrom,scheduledTo:l.scheduledTo,departureDateTime:j.scheduleCandidate.segments[i].departureDateTime,arrivalDateTime:j.scheduleCandidate.segments[i].arrivalDateTime,distanceKm:l.legDistanceKm,recoveryStatus:l.recoveryStatus,unknownDistanceKm:l.unknownDistanceKm,segments:l.segments.map(s=>s.type==='SELF_MANAGED'?{type:s.type,fromStation:s.fromStation,toStation:s.toStation,distanceKm:s.distanceKm}:{type:s.type,fromStation:s.fromStation,toStation:s.toStation,selectedClass:s.selectedClass,availabilityStatus:s.availabilityStatus,availabilityText:s.availabilityText,distanceKm:s.distanceKm,fare:s.reservationParts.some(p=>p.fare)?s.reservationParts.reduce((n,p)=>n+(p.fare?.totalFare??0),0):null,departureDateTime:s.departureDateTime,arrivalDateTime:s.arrivalDateTime,reservationCount:s.reservationParts.length})}))};
}
export class JourneyV2ApiService {
 constructor(private readonly database:RailwayDatabase,private readonly provider:AvailabilityProvider,private readonly options:{diagnostics?:boolean;logger?:(record:Record<string,unknown>)=>void}={}){}
 async search(input:unknown,requestId:string=randomUUID()):Promise<JourneyV2Response>{
  const start=performance.now();let search:JourneyV2Response['search']|undefined;let inventoryStarted=false;
  const log=(event:string,fields:Record<string,unknown>={})=>{try{this.options.logger?.({event,requestId,...(search?{from:search.from,to:search.to,date:search.date,mode:search.mode}:{}),...fields});}catch{/* Logging cannot fail a search. */}};
  try{
   search=validateJourneyV2Request(input);
   if(!this.database.station(search.from)||!this.database.station(search.to))throw new PublicError('INVALID_STATION','Station code is not present in the local railway dataset.');
   this.provider.assertConfigured?.();
   log('journey_v2_search_started');
   inventoryStarted=true;
   const r=await new PlannerV2JourneyRecoveryService(this.database,{getAvailability:r=>this.provider.getAvailability(r)}).search({source:search.from,destination:search.to,journeyDate:search.date,requestedClasses:search.classes==='ALL'?['ALL']:search.classes,mode:search.mode,quota:'GN'});
   const d=r.diagnostics,{results,presentation}=presentJourneys(r.journeys.map(serializeJourneyV2));
   const metrics={attemptedAvailabilityChecks:d.attemptedAvailabilityChecks,actualSdkInvocations:d.actualSdkInvocations,cacheHits:d.cacheHits,providerSuccesses:d.providerSuccesses,providerErrors:d.providerErrors,localConfigurationFailures:d.localConfigurationFailures,unsupportedClassSkips:d.unsupportedClassSkips};
   log('journey_v2_search_completed',{...metrics,availabilityCallsMeaning:'BUDGETED_CHECKS',plannerCandidates:d.plannerCandidatesReceived,resultCount:results.length,availabilityCalls:d.availabilityRequestsUsed,budgetLimit:d.availabilityBudgetLimit,durationMs:Math.round(performance.now()-start)});
   return {requestId,search,results,presentation,summary:{totalResults:results.length,fullyReserved:d.fullReservedJourneys,fullSplitClass:d.fullSplitClassJourneys,partialRecovery:d.partialRecoveryJourneys,scheduledFallback:d.scheduledFallbackJourneys,inventoryIncomplete:d.inventoryIncompleteJourneys},...(this.options.diagnostics?{diagnostics:{...metrics,plannerCandidates:d.plannerCandidatesReceived,availabilityCalls:d.availabilityRequestsUsed,wholeLegCalls:d.wholeLegRequests,recoveryCalls:d.recoveryIntervalRequests,cacheHits:d.availabilityCacheHits,budgetLimit:d.availabilityBudgetLimit,budgetUsed:d.availabilityRequestsUsed,budgetRemaining:d.budgetRemaining,recoveryReserveInitial:d.recoveryReserveInitial,recoveryReserveUsed:d.recoveryReserveUsed,recoveryReserveReleased:d.recoveryReserveReleased,availableResponses:d.availableResponses,racResponses:d.racResponses,waitlistResponses:d.waitlistResponses,unsupportedClassResponses:d.unsupportedClassResponses,providerErrors:d.providerErrors,discoveryCalls:0 as const,trainInfoCalls:0 as const,truncated:d.truncated||r.plannerDiagnostics?.truncated===true}}:{})};
  }catch(error){log('journey_v2_search_failed',{...(error instanceof ProviderConfigurationError&&!inventoryStarted?{...emptyAvailabilityMetrics(),localConfigurationFailures:1,failureCategory:'LOCAL_CONFIGURATION_FAILURE'}:{}),code:error instanceof PublicError?error.code:'INTERNAL_ERROR',durationMs:Math.round(performance.now()-start)});throw error;}
 }
}
