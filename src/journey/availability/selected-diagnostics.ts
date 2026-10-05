import {AsyncLocalStorage} from 'node:async_hooks';
import {safeProviderErrorDetails,type ProviderErrorDetails} from '../../domain/types/provider-error-details.js';
import type {AvailabilityEvidence} from '../../providers/availability-evidence.js';
import type {AvailabilityRequest} from '../../domain/types/availability.js';
import type {BoundedGapLifecycle,BoundedGapRejection,BoundedProbeProgress} from './recovery/evidence-search.js';
import type {InventoryCheck} from './types.js';
export type SelectedStopReason='FULL_COVERAGE_FOUND'|'SELECTED_ROUTE_BUDGET_EXHAUSTED'|'GLOBAL_PROVIDER_LIMIT_REACHED'|'NO_USEFUL_PROBES_REMAINING'|'PROVIDER_FAILURE'|'SEARCH_EXHAUSTED';
export interface GapShrinkEvent {
 trainNumber:string;beforeFrom:string;beforeTo:string;afterFrom:string|null;afterTo:string|null;distanceBeforeKm:number;distanceAfterKm:number;
}
export interface SelectedProbe extends ProviderErrorDetails {
 trainNumber:string;from:string;to:string;travelClass:string;quota:string;
 source?:'CACHE'|'PERSISTED'|'PROVIDER';evidenceSource?:string;observedAt?:number;freshUntil?:number;status?:string;failureCategory?:string;
 action:'EXECUTED'|'SKIPPED'|'EXPANSION'|'PRIORITIZED';reason?:string;causedFurtherExpansion:boolean;
}
export interface BoundedGapProbeResult extends BoundedProbeProgress,ProviderErrorDetails {
 trainNumber:string;from:string;to:string;travelClass:string;requestedDate:string;quota:string;
 source:'CACHE'|'PERSISTED'|'PROVIDER';evidenceSource:string;status:InventoryCheck['status'];failureCategory?:string;
 exactEvidenceKnownBeforeCheck:boolean;exactEvidenceAlreadyExisted:boolean;
}
export interface BoundedBreadthDiagnostics {
 boundedUniquePairsFreshlyCovered:number;boundedAdjacentPairsTotal:number;boundedAdjacentPairsFreshlyCovered:number;
 boundedAdjacentPriorityProbes:number;boundedClassDepthProbes:number;
}
export class SelectedAvailabilityTrace {
 readonly fallback={normalScopeExhaustions:0,complementaryFallbackAttempts:0,negativeRefreshAttempts:0,negativeRefreshTooRecent:0,fallbackProviderCandidates:0,fullCoverageAfterFallback:0};
 // Coverage at search stop over unique pairs in gaps encountered by each leg;
 // probe counters exclude session-known reuse and include gateway cache hits.
 readonly boundedBreadth:BoundedBreadthDiagnostics={boundedUniquePairsFreshlyCovered:0,boundedAdjacentPairsTotal:0,boundedAdjacentPairsFreshlyCovered:0,boundedAdjacentPriorityProbes:0,boundedClassDepthProbes:0};
 readonly trace:SelectedProbe[]=[];readonly traceLimit=120;traceEntriesDropped=0;
 totalProbesConsidered=0;totalProbesExecuted=0;duplicateProbesAvoided=0;cacheHits=0;persistedObservationHits=0;freshObservationHits=0;
 readonly probesSkipped:Record<string,number>={};readonly searchStopReasons:string[]=[];
 frontierPriorityProbes=0;positiveClassEvidenceProbes=0;frontierEntriesDropped=0;
 readonly frontierAdvancements:{trainNumber:string;before:string;after:string}[]=[];
 boundedGapsDetected=0;boundedGapPriorityProbes=0;gapShrinkEventsDropped=0;
 // Candidate counts include repeated queue entries; rejection excludes known
 // exact evidence from new exploration but its free reuse still reaches solve.
 // Executed follows boundedGapPriorityProbes, not paid-call accounting.
 boundedGapCandidatesGenerated=0;boundedGapCandidatesRejected=0;boundedGapCandidatesExecuted=0;boundedGapReseedCount=0;
 readonly boundedGapRejectionReasons:Partial<Record<BoundedGapRejection,number>>={};
 readonly boundedGapProbeResults:BoundedGapProbeResult[]=[];
 readonly boundedGapProbeResultsLimit=64;boundedGapProbeResultsDropped=0;
 boundedGapAvailableResults=0;boundedGapWaitlistResults=0;boundedGapUnknownResults=0;boundedGapUnsupportedResults=0;boundedGapUnavailableResults=0;boundedGapRefinementRounds=0;
 boundedResult(request:AvailabilityRequest,check:InventoryCheck):BoundedGapProbeResult|undefined {
  if(check.status==='AVAILABLE'||check.status==='RAC')this.boundedGapAvailableResults++;
  else if(check.status==='WAITLIST')this.boundedGapWaitlistResults++;
  else if(check.status==='UNSUPPORTED_CLASS')this.boundedGapUnsupportedResults++;
  else if(check.status==='UNAVAILABLE')this.boundedGapUnavailableResults++;
  else this.boundedGapUnknownResults++;
  if(this.boundedGapProbeResults.length>=this.boundedGapProbeResultsLimit){this.boundedGapProbeResultsDropped++;return;}
  const evidenceSource=check.evidence?.evidenceSource??'NOT_OBSERVED';
  const source=evidenceSource==='PERSISTENT_CACHE'?'PERSISTED':evidenceSource==='FRESH_PROVIDER'||evidenceSource==='NOT_OBSERVED'?'PROVIDER':'CACHE';
  const result:BoundedGapProbeResult={trainNumber:request.trainNumber,from:request.fromStationCode,to:request.toStationCode,travelClass:request.travelClass,requestedDate:request.journeyDate,quota:request.quota,
   source,evidenceSource,status:check.status,failureCategory:check.errorCategory,...((check.errorCategory==='INVALID_REQUEST'||check.errorCategory==='SECTION_NOT_BOOKABLE')?safeProviderErrorDetails(check.evidence??check.rawDetails):{}),
   // This list corresponds exactly to boundedGapPriorityProbes: known session
   // evidence is excluded, but the executing gateway can still find a cache hit.
   exactEvidenceKnownBeforeCheck:false,exactEvidenceAlreadyExisted:source!=='PROVIDER'&&evidenceSource!=='SHARED_INFLIGHT',
   causedGapShrink:false,createdNewUnresolvedSubrange:false,scheduledFurtherRefinement:false,refinementSkipReason:null};
  this.boundedGapProbeResults.push(result);return result;
 }
 boundedCandidate(event:BoundedGapLifecycle,reason?:BoundedGapRejection){
  if(event==='GENERATED')this.boundedGapCandidatesGenerated++;
  else if(event==='EXECUTED')this.boundedGapCandidatesExecuted++;
  else if(event==='RESEEDED')this.boundedGapReseedCount++;
  else {this.boundedGapCandidatesRejected++;if(reason)this.boundedGapRejectionReasons[reason]=(this.boundedGapRejectionReasons[reason]??0)+1;}
 }
 readonly gapShrinkEvents:GapShrinkEvent[]=[];
 private push(probe:SelectedProbe){if(this.trace.length<this.traceLimit)this.trace.push(probe);else this.traceEntriesDropped++;}
 evidence(e:AvailabilityEvidence){
  this.totalProbesConsidered++;
  const denied=e.failureCategory==='PROVIDER_BUDGET_EXHAUSTED';
  if(denied)this.probesSkipped.PROVIDER_BUDGET_EXHAUSTED=(this.probesSkipped.PROVIDER_BUDGET_EXHAUSTED??0)+1;else this.totalProbesExecuted++;
  const source=e.evidenceSource==='PERSISTENT_CACHE'?'PERSISTED':e.evidenceSource==='FRESH_PROVIDER'||e.evidenceSource==='NOT_OBSERVED'?'PROVIDER':'CACHE';
  if(source!=='PROVIDER'&&e.observedAt!==undefined)this.freshObservationHits++;
  if(source==='CACHE')this.cacheHits++;if(source==='PERSISTED')this.persistedObservationHits++;
  this.push({trainNumber:e.trainNumber,from:e.from,to:e.to,travelClass:e.travelClass,quota:e.quota,source:denied?undefined:source,evidenceSource:e.evidenceSource,observedAt:e.observedAt,freshUntil:e.freshUntil,status:e.resultStatus,failureCategory:e.failureCategory,...((e.failureCategory==='INVALID_REQUEST'||e.failureCategory==='SECTION_NOT_BOOKABLE')?safeProviderErrorDetails(e):{}),action:denied?'SKIPPED':'EXECUTED',reason:denied?e.failureCategory:undefined,causedFurtherExpansion:false});
 }
 event(request:AvailabilityRequest,reason:string,expansion=false){
  if(!expansion){this.totalProbesConsidered++;this.probesSkipped[reason]=(this.probesSkipped[reason]??0)+1;if(reason==='DUPLICATE')this.duplicateProbesAvoided++;}
  this.push({trainNumber:request.trainNumber,from:request.fromStationCode,to:request.toStationCode,travelClass:request.travelClass,quota:request.quota,action:expansion?'EXPANSION':'SKIPPED',reason,causedFurtherExpansion:expansion});
  if(expansion){const prior=[...this.trace].reverse().find(p=>p.action==='EXECUTED'&&p.trainNumber===request.trainNumber&&p.from===request.fromStationCode&&p.to===request.toStationCode&&p.travelClass===request.travelClass);if(prior)prior.causedFurtherExpansion=true;}
 }
 priority(request:AvailabilityRequest,positiveClassEvidence:boolean){
  this.frontierPriorityProbes++;if(positiveClassEvidence)this.positiveClassEvidenceProbes++;
  this.push({trainNumber:request.trainNumber,from:request.fromStationCode,to:request.toStationCode,travelClass:request.travelClass,quota:request.quota,action:'PRIORITIZED',reason:positiveClassEvidence?'FRONTIER_WITH_POSITIVE_CLASS_EVIDENCE':'FRONTIER_EXTENSION',causedFurtherExpansion:false});
 }
 frontier(trainNumber:string,before:string,after:string){
  if(this.frontierAdvancements.length<32)this.frontierAdvancements.push({trainNumber,before,after});else this.frontierEntriesDropped++;
 }
 gapShrink(event:GapShrinkEvent){
  if(this.gapShrinkEvents.length<32)this.gapShrinkEvents.push(event);else this.gapShrinkEventsDropped++;
 }
}
const current=new AsyncLocalStorage<SelectedAvailabilityTrace>();
export const withSelectedAvailabilityTrace=<T>(trace:SelectedAvailabilityTrace,work:()=>Promise<T>)=>current.run(trace,work);
export const selectedProbeEvent=(request:AvailabilityRequest,reason:string,expansion=false)=>current.getStore()?.event(request,reason,expansion);
export const selectedSearchStopped=(reason:string)=>{const trace=current.getStore();if(trace&&trace.searchStopReasons.length<32)trace.searchStopReasons.push(reason);};
export const selectedFallbackEvent=(event:keyof SelectedAvailabilityTrace['fallback'])=>{const trace=current.getStore();if(trace)trace.fallback[event]++;};
export const selectedProbePriority=(request:AvailabilityRequest,positiveClassEvidence:boolean)=>current.getStore()?.priority(request,positiveClassEvidence);
export const selectedFrontierAdvanced=(trainNumber:string,before:string,after:string)=>current.getStore()?.frontier(trainNumber,before,after);
export const selectedBoundedGapDetected=()=>{const trace=current.getStore();if(trace)trace.boundedGapsDetected++;};
export const selectedBoundedGapPriority=()=>{const trace=current.getStore();if(trace)trace.boundedGapPriorityProbes++;};
export const selectedBoundedCandidate=(event:BoundedGapLifecycle,reason?:BoundedGapRejection)=>current.getStore()?.boundedCandidate(event,reason);
export const selectedBoundedResult=(request:AvailabilityRequest,check:InventoryCheck)=>current.getStore()?.boundedResult(request,check);
export const selectedBoundedRefinement=()=>{const trace=current.getStore();if(trace)trace.boundedGapRefinementRounds++;};
export const selectedBoundedBreadth=(counts:BoundedBreadthDiagnostics)=>{const trace=current.getStore();if(trace)for(const key of Object.keys(counts) as (keyof BoundedBreadthDiagnostics)[])trace.boundedBreadth[key]+=counts[key];};
export const selectedGapShrunk=(event:GapShrinkEvent)=>current.getStore()?.gapShrink(event);

/** Interpret existing stop boundaries; this does not control search admission. */
export function finishSelectedDiagnostics(trace:SelectedAvailabilityTrace,selectedLimit:number,globalLimit:number,d:{providerAvailabilityCalls:number;providerCallBudgetRemaining:number;providerRateLimited:number;providerErrors:number;stopReason?:string},results:import('../../api/services/journey-v2-model.js').JourneyV2Result[]){
 const full=results.some(r=>r.reservedCoverageRatio>=1);
 const stops=trace.searchStopReasons;
 const budgetBlocked=stops.includes('PROVIDER_BUDGET_EXHAUSTED')||!!trace.probesSkipped.PROVIDER_BUDGET_EXHAUSTED||(!full&&d.providerCallBudgetRemaining===0);
 const globalProviderQuotaBlocked=d.providerRateLimited>0||budgetBlocked&&globalLimit<selectedLimit;
 const selectedRouteBudgetBlocked=budgetBlocked&&selectedLimit<=globalLimit;
 const finalSearchStopReason:SelectedStopReason=full?'FULL_COVERAGE_FOUND':globalProviderQuotaBlocked?'GLOBAL_PROVIDER_LIMIT_REACHED':selectedRouteBudgetBlocked?'SELECTED_ROUTE_BUDGET_EXHAUSTED':d.providerErrors>0?'PROVIDER_FAILURE':stops.length>0&&stops.every(s=>s==='SCOPE_EXHAUSTED'||s==='MARGINAL_VALUE_LOW')?'NO_USEFUL_PROBES_REMAINING':'SEARCH_EXHAUSTED';
 const uncoveredRanges=results.flatMap(r=>r.legs.flatMap(l=>{
  const ranges:{trainNumber:string;fromStation:string;toStation:string;distanceKm:number;status:'UNKNOWN'|'UNCOVERED'}[]=[];
  let from=l.scheduledFrom;
  const reserved=l.segments.filter(s=>s.type==='RESERVED');
  // Temporal order is already the selected path order. No alternative inventory is inferred.
  for(const s of reserved){if(from!==s.fromStation)ranges.push({trainNumber:l.trainNumber,fromStation:from,toStation:s.fromStation,distanceKm:0,status:l.unknownDistanceKm>0?'UNKNOWN':'UNCOVERED'});from=s.toStation;}
  if(from!==l.scheduledTo)ranges.push({trainNumber:l.trainNumber,fromStation:from,toStation:l.scheduledTo,distanceKm:0,status:l.unknownDistanceKm>0?'UNKNOWN':'UNCOVERED'});
  // Distance is precise for a single gap; avoid inventing a distribution for multiple gaps.
  const missing=l.distanceKm-reserved.reduce((n,s)=>n+s.distanceKm,0);
  return ranges.map(g=>({...g,distanceKm:ranges.length===1?missing:undefined}));
 }));
 return {configuredSelectedRouteProviderCallLimit:selectedLimit,configuredGlobalProviderCallLimit:globalLimit,effectiveProviderCallLimit:Math.min(selectedLimit,globalLimit),newProviderCallsUsed:d.providerAvailabilityCalls,
  ...trace.fallback,
  cacheHits:trace.cacheHits,persistedObservationHits:trace.persistedObservationHits,freshObservationHits:trace.freshObservationHits,duplicateProbesAvoided:trace.duplicateProbesAvoided,totalProbesConsidered:trace.totalProbesConsidered,totalProbesExecuted:trace.totalProbesExecuted,probesSkipped:trace.probesSkipped,
  budgetRemaining:d.providerCallBudgetRemaining,selectedRouteBudgetRemaining:Math.max(0,selectedLimit-d.providerAvailabilityCalls),globalProviderQuotaBlocked,selectedRouteBudgetBlocked,finalSearchStopReason,underlyingStopReasons:stops,orchestratorStopReason:d.stopReason,
  unsupportedClassProbesAvoided:trace.probesSkipped.UNSUPPORTED_TRAIN_CLASS??0,frontierPriorityProbes:trace.frontierPriorityProbes,positiveClassEvidenceProbes:trace.positiveClassEvidenceProbes,frontierAdvancements:trace.frontierAdvancements,frontierEntriesDropped:trace.frontierEntriesDropped,
  ...trace.boundedBreadth,boundedGapsDetected:trace.boundedGapsDetected,boundedGapPriorityProbes:trace.boundedGapPriorityProbes,gapShrinkEvents:trace.gapShrinkEvents,gapShrinkEventsDropped:trace.gapShrinkEventsDropped,
  boundedGapCandidatesGenerated:trace.boundedGapCandidatesGenerated,boundedGapCandidatesRejected:trace.boundedGapCandidatesRejected,boundedGapCandidatesExecuted:trace.boundedGapCandidatesExecuted,boundedGapReseedCount:trace.boundedGapReseedCount,boundedGapRejectionReasons:trace.boundedGapRejectionReasons,
  boundedGapProbeResults:trace.boundedGapProbeResults,boundedGapProbeResultsLimit:trace.boundedGapProbeResultsLimit,boundedGapProbeResultsDropped:trace.boundedGapProbeResultsDropped,
  boundedGapAvailableResults:trace.boundedGapAvailableResults,boundedGapWaitlistResults:trace.boundedGapWaitlistResults,boundedGapUnknownResults:trace.boundedGapUnknownResults,boundedGapUnsupportedResults:trace.boundedGapUnsupportedResults,boundedGapUnavailableResults:trace.boundedGapUnavailableResults,boundedGapRefinementRounds:trace.boundedGapRefinementRounds,
  uncoveredRanges,trace:trace.trace,traceLimit:trace.traceLimit,traceEntriesDropped:trace.traceEntriesDropped,
  probeCounting:'Executed includes cache/persisted evidence reuse; considered = executed + skipped. Cache-only misses are not executed probes.'};
}
export type SelectedAvailabilityDiagnostics=ReturnType<typeof finishSelectedDiagnostics>;

export const selectedProbeEvidence=(evidence:AvailabilityEvidence)=>current.getStore()?.evidence(evidence);
