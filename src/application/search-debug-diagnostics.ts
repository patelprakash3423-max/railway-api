import { providerFailureCategory } from '../domain/types/provider-failure.js';
import type { AvailabilityRequest, AvailabilityResult } from '../domain/types/availability.js';
import type { TrainSearchRequest, TrainSearchResult } from '../domain/types/train-search.js';
import type { TrainDetails } from '../domain/types/train.js';
import type { ConnectionSearchResponse } from '../journey/connection/types.js';
import type { ConnectionSearchOptions } from '../journey/connection/connection-search-engine.js';
import { classifySearchCompletion } from './search-completion.js';
export type SearchFailureReason = 'PROVIDER_LIMITED'|'NO_TRAINS_DISCOVERED'|'SEARCH_BUDGET_EXHAUSTED'|'NO_FEASIBLE_CONNECTIONS'|'NO_USABLE_DIRECT_INVENTORY'|'NO_USABLE_CONNECTION_INVENTORY'|'CORRIDOR_EXHAUSTED'|'NO_RESULT_WITHIN_SEARCH_BOUNDS';
export type SearchCompletionReason = 'COMPLETED_NORMAL'|'RESULT_TARGET_REACHED'|'GLOBAL_AVAILABILITY_BUDGET'|'DISCOVERY_BUDGET'|'TRAIN_INFO_BUDGET'|'PROVIDER_INTERRUPTION'|'INSUFFICIENT_REMAINING_BUDGET'|'SEARCH_STAGE_INTERRUPTED';
/** Observes actual calls only. Cache reads never pass through this collector. */
export class SearchDiagnosticObserver {
 readonly outcomes = { available:0,rac:0,waitlist:0,notAvailable:0,providerUnavailable:0,providerError:0,unclassified:0 };
 readonly providerFailures = { RATE_LIMITED:0,BOOKING_UNSUPPORTED:0,INVALID_PROVIDER_RESPONSE:0,UNKNOWN_PROVIDER_ERROR:0 };
 observeFailure(value:unknown){this.providerFailures[providerFailureCategory(value)]++;}
 readonly discovery = { discoveryCalls:0,trainsReturned:0,exactEndpointTrains:0 };
 private trains=new Set<string>();private stations=new Set<string>();
 private station(code:string){if(/^[A-Z]{1,5}$/.test(code))this.stations.add(code);}
 private train(code:string){if(/^\d{5}$/.test(code))this.trains.add(code);}
 discoveryStarted(){this.discovery.discoveryCalls++;}
 observeDiscovery(r:TrainSearchRequest,result:TrainSearchResult){
  if(result.providerState!=='SUCCESS'){this.observeFailure(result);return;}
  this.discovery.trainsReturned+=result.trains.length;
  for(const t of result.trains){this.train(t.trainNumber);this.station(t.fromStationCode);this.station(t.toStationCode);if(t.fromStationCode===r.fromStationCode&&t.toStationCode===r.toStationCode)this.discovery.exactEndpointTrains++;}
 }
 observeInfo(info:TrainDetails){this.train(info.trainNumber);for(const s of info.route)this.station(s.stationCode);}
 observeAvailability(r:AvailabilityRequest,result:AvailabilityResult){
  if(result.providerState!=='SUCCESS')this.observeFailure(result);
  if(result.providerState==='PROVIDER_UNAVAILABLE'){this.outcomes.providerUnavailable++;return;}
  if(result.providerState!=='SUCCESS'){this.outcomes.providerError++;return;}
  const days=result.days.filter(d=>d.date===r.journeyDate);
  if(days.length!==1){this.outcomes.unclassified++;return;}
  switch(days[0].state){case 'AVAILABLE':this.outcomes.available++;break;case 'RAC':this.outcomes.rac++;break;case 'WAITLIST':this.outcomes.waitlist++;break;case 'NOT_AVAILABLE':this.outcomes.notAvailable++;break;default:this.outcomes.unclassified++;}
 }
 observeAvailabilityError(e:unknown){this.observeFailure(e);if(e&&typeof e==='object'&&'providerState' in e&&e.providerState==='PROVIDER_UNAVAILABLE')this.outcomes.providerUnavailable++;else this.outcomes.providerError++;}
 snapshot(){return {providerFailureCategories:{...this.providerFailures},availabilityOutcomes:{...this.outcomes},discovery:{...this.discovery,uniqueTrainsObserved:this.trains.size,uniqueStationsObserved:this.stations.size},observedTrainNumbers:[...this.trains].sort().slice(0,10)};}
}
export function buildSearchDebug(response:ConnectionSearchResponse,observer:SearchDiagnosticObserver,options:ConnectionSearchOptions,resultCount:number,used:{availability:number;discovery:number;trainInfo:number}) {
 const d=response.diagnostics,r=response.recovery?.diagnostics,m=response.multi?.diagnostics;
 const snapshot=observer.snapshot();
 const budget=(limit:number,used:number)=>({limit,used,remaining:Math.max(0,limit-used),exhausted:used>=limit});
 const budgets={availability:budget(options.budget!.maxAvailabilityCalls!,used.availability),discovery:budget(options.budget!.maxTrainDiscoveryCalls!,used.discovery),trainInfo:budget(options.budget!.maxTrainInfoCalls!,used.trainInfo)};
 const complete=classifySearchCompletion(d);
 const target=d.earlyStopReason==='MAX_RESULTS_REACHED'||d.earlyStopReason==='ENOUGH_STRONG_DIRECT_RESULTS';
 const completionReason:SearchCompletionReason=complete.searchCompleted?(target?'RESULT_TARGET_REACHED':'COMPLETED_NORMAL'):
 d.earlyStopReason==='DIRECT_DISCOVERY_FAILED_NO_CONNECTION_SEEDS'?'PROVIDER_INTERRUPTION':d.availabilityBudgetExhausted?'GLOBAL_AVAILABILITY_BUDGET':d.trainDiscoveryBudgetExhausted?'DISCOVERY_BUDGET':d.trainInfoBudgetExhausted?'TRAIN_INFO_BUDGET':d.insufficientRemainingBudgetForNextExpansion?'INSUFFICIENT_REMAINING_BUDGET':'SEARCH_STAGE_INTERRUPTED';
 const directResults=response.results.filter(r=>r.type==='DIRECT').length,connectionResults=response.results.filter(r=>r.type==='DIFFERENT_TRAIN_CONNECTION').length;
 const failureReasons:SearchFailureReason[]=[];
 if(!resultCount||complete.partialResults){
  if(snapshot.providerFailureCategories.RATE_LIMITED>0)failureReasons.push('PROVIDER_LIMITED');
  if(snapshot.discovery.discoveryCalls>0&&snapshot.discovery.trainsReturned===0&&!d.providerUnavailableCount&&!d.providerErrorCount)failureReasons.push('NO_TRAINS_DISCOVERED');
  if(!complete.searchCompleted&&(d.availabilityBudgetExhausted||d.trainDiscoveryBudgetExhausted||d.trainInfoBudgetExhausted||d.insufficientRemainingBudgetForNextExpansion))failureReasons.push('SEARCH_BUDGET_EXHAUSTED');
  if((d.trainPairsRejectedByTiming>0||(m?.multiInterchangeTimingPruned??0)>0)&&d.trainPairsCheckedForAvailability===0&&!(m?.multiInterchangeCompletedPaths)&&!(m?.multiInterchangeAvailabilityChecks))failureReasons.push('NO_FEASIBLE_CONNECTIONS');
  if(d.directAvailabilityChecks>0&&!directResults)failureReasons.push('NO_USABLE_DIRECT_INVENTORY');
  if((d.availabilityCallsByPhase.connection+(d.availabilityCallsByPhase.multi??0))>0&&!connectionResults&&!response.multi?.candidates.length)failureReasons.push('NO_USABLE_CONNECTION_INVENTORY');
  // Only an explicit completed bounded corridor traversal supports this label.
  if(!resultCount&&complete.searchCompleted&&d.earlyStopReason==='CANDIDATES_EXHAUSTED')failureReasons.push('CORRIDOR_EXHAUSTED');
  if(!resultCount)failureReasons.push('NO_RESULT_WITHIN_SEARCH_BOUNDS');
 }
 const observedInterchangeStations=[...new Set(d.connectionStationCandidates.map(s=>s.stationCode).filter(s=>/^[A-Z]{1,5}$/.test(s)))].sort();
 return {budgetOrchestration:d.budgetOrchestration,insufficientRemainingBudgetForNextExpansion:d.insufficientRemainingBudgetForNextExpansion,stages:{direct:{candidates:d.directTrainsDiscovered,availabilityChecks:d.directAvailabilityChecks,usableResults:directResults},
 sameTrainRecovery:r?{generated:r.recoveryCandidatesGenerated,coveragePruned:r.recoveryCandidatesCoveragePruned,availabilityChecks:r.recoveryAvailabilityChecks,usableResults:r.recoveryUsableCandidates}:undefined,
 oneChange:{connectionStationsConsidered:d.connectionStationsConsidered,pairsGenerated:d.trainPairsGenerated,timingPruned:d.trainPairsRejectedByTiming,availabilityChecks:d.availabilityCallsByPhase.connection,usableResults:connectionResults},
 multiInterchange:m?{activated:m.multiInterchangeActivated,partialPathsGenerated:m.multiInterchangePartialPathsGenerated,pathsExpanded:m.multiInterchangePathsExpanded,beamPruned:m.multiInterchangeBeamPruned,dominancePruned:m.multiInterchangeDominancePruned,upperBoundPruned:m.multiInterchangeUpperBoundPruned,timingPruned:m.multiInterchangeTimingPruned,loopPruned:m.multiInterchangeLoopPruned,detourPruned:m.multiInterchangeDetourPruned,availabilityChecks:m.multiInterchangeAvailabilityChecks,completedPaths:m.multiInterchangeCompletedPaths}:undefined},
 ...snapshot,discovery:{...snapshot.discovery,candidateInterchangeStationsObserved:observedInterchangeStations.length},observedInterchangeStations:observedInterchangeStations.slice(0,10),budgets,failureReasons,primaryFailureReason:failureReasons[0],completionReason};
}
export type SearchDebugDiagnostics=ReturnType<typeof buildSearchDebug>;
