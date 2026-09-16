import type { RailwayDatabase } from '../../../local-railway/database.js';
import { LocalJourneyPlannerV2 } from '../../../local-railway/planner/v2/planner.js';
import { searchModeConfig } from '../../../application/search-mode.js';
import { travelClasses } from '../../types/journey-segment.js';
import { AvailabilityOrchestrator } from '../orchestrator.js';
import { AvailabilitySession } from '../session.js';
import { recoverSingleTrainLeg } from '../recovery/recover.js';
import type { RecoverySegment, ReservedSegment, RecoveryLimits } from '../recovery/types.js';
import type { AvailabilityProvider, ValidationInput, ValidationOptions, ValidatedJourney } from '../types.js';

export type JourneyStatus = 'FULLY_RESERVED_USABLE' | 'FULLY_RESERVED_WITH_SPLIT_CLASS' | 'PARTIAL_RESERVED_RECOVERY' | 'SCHEDULED_BUT_NOT_FULLY_AVAILABLE' | 'INVENTORY_CHECK_INCOMPLETE';
export interface JourneyLeg {
  trainNumber: string; scheduledFrom: string; scheduledTo: string;
  recoveryStatus: string; segments: RecoverySegment[]; legDistanceKm: number;
  reservedDistanceKm: number; reservedCoverageRatio: number; unknownDistanceKm: number;
}
export interface RecoveredJourney {
  scheduleCandidateId: string; scheduleCandidate: ValidatedJourney['scheduleCandidate'];
  wholeLegValidation: ValidatedJourney; journeyStatus: JourneyStatus;
  legs: JourneyLeg[]; trainChanges: number; classChanges: number; journeyClassTransitions: number;
  totalDistanceKm: number; reservedDistanceKm: number; selfManagedDistanceKm: number;
  unknownDistanceKm: number; reservedCoverageRatio: number;
  availableSegmentCount: number; racSegmentCount: number; racDistanceKm: number;
  recoveryFragments: number; knownReservedFare: number; fareComplete: boolean;
  scheduleRank: number; finalRank: number;
}
export interface JourneyOptions extends ValidationOptions {
  minimumJourneyReservedCoverageRatio?: number;
  maxRecoveryRequestsPerCandidate?: number;
  recoveryLimits?: Partial<RecoveryLimits>;
  recoveryReserve?: number;
}
const reserves = { QUICK: 3, STANDARD: 8, DEEP: 10 };
const caps = { QUICK: 3, STANDARD: 8, DEEP: 12 };
const isReserved = (s: RecoverySegment): s is ReservedSegment => s.type === 'RESERVED';
export function rankJourneys(a: RecoveredJourney, b: RecoveredJourney): number {
  const priority: Record<JourneyStatus, number> = {FULLY_RESERVED_USABLE:0,FULLY_RESERVED_WITH_SPLIT_CLASS:1,PARTIAL_RESERVED_RECOVERY:2,SCHEDULED_BUT_NOT_FULLY_AVAILABLE:3,INVENTORY_CHECK_INCOMPLETE:4};
  const safety = (j: RecoveredJourney) => Math.min(...j.scheduleCandidate.connections.map(c=>c.minutes), Infinity);
  return priority[a.journeyStatus]-priority[b.journeyStatus] || b.reservedCoverageRatio-a.reservedCoverageRatio || a.racDistanceKm-b.racDistanceKm || a.selfManagedDistanceKm-b.selfManagedDistanceKm || a.trainChanges-b.trainChanges || a.classChanges-b.classChanges || a.recoveryFragments-b.recoveryFragments || a.scheduleCandidate.durationMinutes-b.scheduleCandidate.durationMinutes || a.scheduleCandidate.distanceDetourPercent-b.scheduleCandidate.distanceDetourPercent || safety(b)-safety(a) || Number(b.fareComplete)-Number(a.fareComplete) || a.knownReservedFare-b.knownReservedFare || a.scheduleRank-b.scheduleRank || a.scheduleCandidateId.localeCompare(b.scheduleCandidateId);
}
function assemble(whole: ValidatedJourney, legs: JourneyLeg[], threshold: number): RecoveredJourney {
  const reserved = legs.flatMap(l=>l.segments.filter(isReserved));
  const total = legs.reduce((n,l)=>n+l.legDistanceKm,0);
  const distance = reserved.reduce((n,s)=>n+s.distanceKm,0);
  const unknown = legs.reduce((n,l)=>n+l.unknownDistanceKm,0);
  const self = legs.flatMap(l=>l.segments).reduce((n,s)=>n+(s.type==='SELF_MANAGED'?s.distanceKm:0),0);
  const full = Math.abs(total-distance)<1e-6;
  const split = reserved.some(s=>s.reservationParts.length>1) || legs.some(l=>l.segments.filter(isReserved).length>1);
  const changes = (segments: ReservedSegment[])=>segments.reduce((n,s,i)=>n+Number(i>0&&s.selectedClass!==segments[i-1].selectedClass),0);
  const parts = reserved.flatMap(s=>s.reservationParts);
  const journeyStatus: JourneyStatus = unknown>1e-6?'INVENTORY_CHECK_INCOMPLETE':full?split?'FULLY_RESERVED_WITH_SPLIT_CLASS':'FULLY_RESERVED_USABLE':distance+1e-9>=threshold*total?'PARTIAL_RESERVED_RECOVERY':'SCHEDULED_BUT_NOT_FULLY_AVAILABLE';
  return {scheduleCandidateId:whole.scheduleCandidateId,scheduleCandidate:whole.scheduleCandidate,wholeLegValidation:whole,journeyStatus,legs,trainChanges:whole.trainChanges,classChanges:legs.reduce((n,l)=>n+changes(l.segments.filter(isReserved)),0),journeyClassTransitions:changes(reserved),totalDistanceKm:total,reservedDistanceKm:distance,selfManagedDistanceKm:self,unknownDistanceKm:unknown,reservedCoverageRatio:total?distance/total:0,availableSegmentCount:reserved.filter(s=>s.availabilityStatus==='AVAILABLE').length,racSegmentCount:reserved.filter(s=>s.availabilityStatus==='RAC').length,racDistanceKm:reserved.reduce((n,s)=>n+(s.availabilityStatus==='RAC'?s.distanceKm:0),0),recoveryFragments:parts.length,knownReservedFare:parts.reduce((n,p)=>n+(p.fare?.totalFare??0),0),fareComplete:full&&parts.length>0&&parts.every(p=>p.fare!==undefined),scheduleRank:whole.scheduleRank,finalRank:0};
}
export class JourneyRecoveryOrchestrator {
  constructor(private readonly database: RailwayDatabase, private readonly provider: AvailabilityProvider, private readonly options: JourneyOptions = {}) {}
  async validate(input: ValidationInput) {
    const mode=input.mode??'STANDARD';
    if(!['QUICK','STANDARD','DEEP'].includes(mode))throw new Error('Invalid mode');
    const threshold=this.options.minimumJourneyReservedCoverageRatio??.5;
    const cap=this.options.maxRecoveryRequestsPerCandidate??caps[mode];
    const batches=this.options.batchSizes??[3,3,5];
    const target=this.options.usableTarget??3;
    const reserve=this.options.recoveryReserve??reserves[mode];
    if(!Number.isSafeInteger(reserve)||reserve<0||!Number.isFinite(threshold)||threshold<=0||threshold>1||!Number.isSafeInteger(cap)||cap<0||!Number.isSafeInteger(target)||target<1||!batches.length||batches.some(n=>!Number.isSafeInteger(n)||n<1))throw new Error('Invalid journey recovery limits');
    const session=new AvailabilitySession(this.provider,this.options.budgetLimit??searchModeConfig(mode).budget!.maxAvailabilityCalls!);
    const initialReserve=Math.min(reserve,session.limit);
    const d={recoveryReserveInitial:initialReserve,recoveryReserveUsed:0,recoveryReserveReleased:0,releasedReserveCalls:0,candidatesCheckedWholeLeg:0,plannerCandidatesReceived:input.plannerCandidates.length,wholeLegCandidatesValidated:0,wholeLegUsableJourneys:0,candidatesSentToRecovery:0,legsEligibleForRecovery:0,legsRecoveryAttempted:0,legsRecoverySucceeded:0,coverageFeasibilityPruned:0,candidateRecoveryBudgetPruned:0,fullReservedJourneys:0,fullSplitClassJourneys:0,partialRecoveryJourneys:0,scheduledFallbackJourneys:0,inventoryIncompleteJourneys:0,totalReservedDistanceEvaluated:0,totalSelfManagedDistanceReturned:0,wholeLegRequests:0,recoveryIntervalRequests:0,bottleneckLegsEvaluated:0,recoveryEarlyStops:0,candidatesDeferredByBudget:0,candidatesDeferredByTarget:0,truncated:false,breadthCandidatesConsidered:0,breadthCandidatesChecked:0,breadthRequests:0,completionCandidatesConsidered:0,completionCandidatesChecked:0,completionRequests:0,deepWideningCandidates:0,deepWideningRequests:0,candidatesDeferredByAtomicCost:0,candidatesDeferredByBreadthLimit:0};
    const journeys: RecoveredJourney[]=[];
    const validator=new AvailabilityOrchestrator(this.provider,{...this.options,progressiveAllocation:true,completeFailedCandidates:true,usableTarget:target});
    const recoveryAttempted=new Set<number>();
    const budgetDeferred=new Set<number>(),targetDeferred=new Set<number>();
    const checked=new Set<number>(),fullyChecked=new Set<number>(),wholeUsable=new Set<number>();
    let protectedRemaining=initialReserve;
    // Global breadth and completion with protected recovery capacity.
    // Phase C: revisit deferred whole-leg candidates after releasing unused reserve.
    for(const phase of ['PROTECTED','RELEASED'] as const){
    if(phase==='RELEASED'){
      d.recoveryReserveReleased=Math.min(protectedRemaining,session.remaining);
      protectedRemaining=0;
    }
    let offset=0;
    // Retain unvisited schedule candidates explicitly, without spending inventory calls.
    while(offset<input.plannerCandidates.length){
      const stop=journeys.filter(j=>j.journeyStatus.startsWith('FULLY_RESERVED')).length>=target;
      const scheduledBatch=input.plannerCandidates.slice(offset);
      const indexed=scheduledBatch.map((candidate,i)=>({candidate,rank:offset+i+1})).filter(x=>phase==='PROTECTED'||(!fullyChecked.has(x.rank)&&!recoveryAttempted.has(x.rank)));
      const batch=indexed.map(x=>x.candidate);
      const before=session.budget.callsUsed;
      const validated=await session.withAllowance(stop?0:Math.max(0,session.remaining-protectedRemaining),()=>validator.validate({...input,plannerCandidates:batch},session));
      const wholeCalls=session.budget.callsUsed-before;
      if(validated.allocationDiagnostics)for(const key of Object.keys(validated.allocationDiagnostics) as (keyof typeof validated.allocationDiagnostics)[])d[key]+=validated.allocationDiagnostics[key];
      d.wholeLegRequests+=wholeCalls;
      if(phase==='RELEASED')d.releasedReserveCalls+=Math.min(wholeCalls,Math.max(0,d.recoveryReserveReleased-d.releasedReserveCalls));
      for(const whole of validated.journeys){
        whole.scheduleRank=indexed[whole.scheduleRank-1].rank;
        if(whole.legs.some(l=>l.checks.length))checked.add(whole.scheduleRank);
        if(whole.status==='FULLY_RESERVED_USABLE')wholeUsable.add(whole.scheduleRank);
      }
      const enough=stop||new Set([...journeys.filter(j=>j.journeyStatus.startsWith('FULLY_RESERVED')).map(j=>j.scheduleRank),...validated.journeys.filter(j=>j.status==='FULLY_RESERVED_USABLE').map(j=>j.scheduleRank)]).size>=target;
      // Rank recovery opportunities without changing Planner V2's schedule ordering.
      const reservedKm=(j:ValidatedJourney)=>j.legs.reduce((n,l)=>n+(['AVAILABLE','RAC'].includes(l.availabilityStatus??'')?l.distanceKm:0),0);
      const failedCount=(j:ValidatedJourney)=>j.legs.filter(l=>!['AVAILABLE','RAC'].includes(l.availabilityStatus??'')).length;
      const ordered=validated.journeys.sort((a,b)=>Number(reservedKm(b)>0)-Number(reservedKm(a)>0)||failedCount(a)-failedCount(b)||a.scheduleRank-b.scheduleRank||a.trainChanges-b.trainChanges||a.detourPercent-b.detourPercent||Math.min(...b.scheduleCandidate.connections.map(c=>c.minutes),Infinity)-Math.min(...a.scheduleCandidate.connections.map(c=>c.minutes),Infinity));
      const potential=ordered.filter(j=>j.status==='SCHEDULED_BUT_NOT_FULLY_AVAILABLE');
      let recoveryCandidatesRemaining=potential.length;
      for(const whole of ordered){

        const eligible: number[]=[];
        let unverified=false;
        const legs: JourneyLeg[]=whole.legs.map((l,i)=>{
          const allowed=(input.requestedClasses.some(c=>c.trim().toUpperCase()==='ALL')?[...travelClasses]:input.requestedClasses.map(c=>c.trim().toUpperCase())).filter(c=>input.supportedClassesByTrain?.[l.trainNumber]===undefined||input.supportedClassesByTrain[l.trainNumber].map(c=>c.trim().toUpperCase()).includes(c));
          unverified ||= allowed.some(c=>!session.unsupported.get(l.trainNumber)?.has(c as typeof travelClasses[number])&&!l.checks.some(x=>x.travelClass===c))&&!['AVAILABLE','RAC'].includes(l.availabilityStatus??'');
          const usable=l.availabilityStatus==='AVAILABLE'||l.availabilityStatus==='RAC';
          const failed=!usable&&allowed.every(c=>session.unsupported.get(l.trainNumber)?.has(c as typeof travelClasses[number])||l.checks.some(x=>x.travelClass===c&&(x.status==='WAITLIST'||x.status==='UNAVAILABLE'||x.errorCategory==='UNSUPPORTED_CLASS')));
          if(failed&&allowed.some(c=>!session.unsupported.get(l.trainNumber)?.has(c as typeof travelClasses[number])))eligible.push(i);
          const segments: RecoverySegment[]=usable?[{type:'RESERVED',trainNumber:l.trainNumber,fromStation:l.fromStation,toStation:l.toStation,departureDateTime:l.departureDateTime,arrivalDateTime:l.arrivalDateTime,selectedClass:l.selectedClass!,quota:'GN',availabilityStatus:l.availabilityStatus as 'AVAILABLE'|'RAC',availabilityText:l.availabilityText,distanceKm:l.distanceKm,fare:l.fare,reservationParts:[{fromStation:l.fromStation,toStation:l.toStation,departureDateTime:l.departureDateTime,arrivalDateTime:l.arrivalDateTime,boardingDate:l.boardingDate,distanceKm:l.distanceKm,availabilityStatus:l.availabilityStatus as 'AVAILABLE'|'RAC',fare:l.fare}]}]:failed?[{type:'SELF_MANAGED',fromStation:l.fromStation,toStation:l.toStation,distanceKm:l.distanceKm,notice:'No reserved coverage or transportation is confirmed for this range.'}]:[];
          return {trainNumber:l.trainNumber,scheduledFrom:l.fromStation,scheduledTo:l.toStation,recoveryStatus:usable?'WHOLE_LEG_USABLE':failed?'CONFIRMED_INVENTORY_FAILURE':'INVENTORY_CHECK_INCOMPLETE',segments,legDistanceKm:l.distanceKm,reservedDistanceKm:usable?l.distanceKm:0,reservedCoverageRatio:usable?1:0,unknownDistanceKm:usable||failed?0:l.distanceKm};
        });
        budgetDeferred.delete(whole.scheduleRank);targetDeferred.delete(whole.scheduleRank);
        if(unverified)(stop?targetDeferred:budgetDeferred).add(whole.scheduleRank);
        if(legs.every(l=>l.unknownDistanceKm===0))fullyChecked.add(whole.scheduleRank);
        d.legsEligibleForRecovery+=eligible.length;
        const budgetIncomplete = new Set<number>();
        let candidateCapPruned=false;
        const recoverCandidate=!enough&&journeys.filter(j=>j.journeyStatus.startsWith('FULLY_RESERVED')).length<target;
        let result=assemble(whole,legs,threshold);
        // Unknown whole-leg inventory is never relabelled as a self-managed gap.
        const optimistic=result.reservedDistanceKm+eligible.reduce((n,i)=>n+legs[i].legDistanceKm,0);
        if(recoverCandidate&&eligible.length&&optimistic+1e-9<threshold*result.totalDistanceKm)d.coverageFeasibilityPruned++;
        else if(recoverCandidate&&eligible.length&&result.unknownDistanceKm===0){
          d.candidatesSentToRecovery++;
          recoveryAttempted.add(whole.scheduleRank);
          eligible.sort((a,b)=>legs[b].legDistanceKm-legs[a].legDistanceKm||legs[a].reservedCoverageRatio-legs[b].reservedCoverageRatio||(input.supportedClassesByTrain?.[legs[a].trainNumber]?.length??8)-(input.supportedClassesByTrain?.[legs[b].trainNumber]?.length??8)||a-b);
          // Leave at least one request for another candidate; allowance is never a new budget.
          const fairShare=Math.floor(Math.max(0,session.remaining-1)/Math.max(1,recoveryCandidatesRemaining));
          const allowance=Math.min(cap,fairShare);
          recoveryCandidatesRemaining=Math.max(0,recoveryCandidatesRemaining-1);
          const recoveryBefore=session.budget.callsUsed;
          await session.withAllowance(allowance,async()=>{
            for(const i of eligible){
              d.legsRecoveryAttempted++;d.bottleneckLegsEvaluated++;
              const l=whole.scheduleCandidate.segments[i];
              const recovered=await recoverSingleTrainLeg(this.database,session,{trainNumber:l.trainNumber,fromStation:l.fromStation,toStation:l.toStation,boardingDateTime:l.departureDateTime,arrivalDateTime:l.arrivalDateTime,distanceKm:l.distanceKm,requestedClasses:input.requestedClasses,supportedClasses:input.supportedClassesByTrain?.[l.trainNumber]},this.options.recoveryLimits);
              const best=recovered.best;
              // Consume the best evidence even below the standalone leg threshold:
              // eligibility belongs to the complete journey, not individual legs.
              legs[i]={...legs[i],recoveryStatus:best.recoveryStatus,segments:best.segments,reservedDistanceKm:best.reservedDistanceKm,reservedCoverageRatio:best.reservedCoverageRatio,unknownDistanceKm:recovered.diagnostics.providerErrors&&best.reservedCoverageRatio<1?best.selfManagedDistanceKm:0};
              if(legs[i].unknownDistanceKm)legs[i].segments=best.segments.filter(isReserved);
              if(best.reservedDistanceKm>0)d.legsRecoverySucceeded++;
              d.truncated ||= recovered.diagnostics.truncated;
              if(recovered.diagnostics.truncationReasons.includes('availabilityBudget')){candidateCapPruned=true;budgetIncomplete.add(i);}
              result=assemble(whole,legs,threshold);
              if(result.reservedCoverageRatio>=1){d.recoveryEarlyStops++;break;}
              const remaining=eligible.slice(eligible.indexOf(i)+1);
              const maximum=result.reservedDistanceKm+remaining.reduce((n,k)=>n+legs[k].legDistanceKm,0);
              if(remaining.length&&maximum+1e-9<threshold*result.totalDistanceKm){d.coverageFeasibilityPruned++;break;}
            }
          });
          const recoveryCalls=session.budget.callsUsed-recoveryBefore;
          d.recoveryIntervalRequests+=recoveryCalls;
          if(phase==='PROTECTED'){
            const used=Math.min(protectedRemaining,recoveryCalls);
            protectedRemaining-=used;d.recoveryReserveUsed+=used;
          }
        }
        if(result.reservedCoverageRatio+1e-9<threshold&&budgetIncomplete.size){
          for(const i of budgetIncomplete){legs[i].unknownDistanceKm=legs[i].legDistanceKm-legs[i].reservedDistanceKm;legs[i].segments=legs[i].segments.filter(isReserved);}
          result=assemble(whole,legs,threshold);
        }
        if(candidateCapPruned)d.candidateRecoveryBudgetPruned++;
        const previous=journeys.findIndex(j=>j.scheduleRank===whole.scheduleRank);
        if(previous<0)journeys.push(result);else journeys[previous]=result;
      }
      offset+=scheduledBatch.length;
    }
    }
    d.candidatesDeferredByBudget=budgetDeferred.size;
    d.candidatesDeferredByTarget=targetDeferred.size;
    d.candidatesCheckedWholeLeg=checked.size;
    d.wholeLegCandidatesValidated=fullyChecked.size;
    d.wholeLegUsableJourneys=wholeUsable.size;
    journeys.sort(rankJourneys);journeys.forEach((j,i)=>{j.finalRank=i+1;d.totalReservedDistanceEvaluated+=j.reservedDistanceKm;d.totalSelfManagedDistanceReturned+=j.selfManagedDistanceKm;const fields={FULLY_RESERVED_USABLE:'fullReservedJourneys',FULLY_RESERVED_WITH_SPLIT_CLASS:'fullSplitClassJourneys',PARTIAL_RESERVED_RECOVERY:'partialRecoveryJourneys',SCHEDULED_BUT_NOT_FULLY_AVAILABLE:'scheduledFallbackJourneys',INVENTORY_CHECK_INCOMPLETE:'inventoryIncompleteJourneys'} as const;d[fields[j.journeyStatus]]++;});
    d.truncated ||= d.candidatesDeferredByBudget>0;
    const evidence=journeys.flatMap(j=>j.wholeLegValidation.legs.filter(l=>l.checks.length));
    return {journeys,diagnostics:{...d,distinctCandidatesWithAnyWholeLegEvidence:new Set(journeys.filter(j=>j.wholeLegValidation.legs.some(l=>l.checks.length)).map(j=>j.scheduleCandidateId)).size,distinctTrainsChecked:new Set(evidence.map(l=>l.trainNumber)).size,distinctTrainClassPairsChecked:new Set(evidence.flatMap(l=>l.checks.map(c=>`${l.trainNumber}:${c.travelClass}`))).size,...session.statistics()},plannerDiagnostics:input.plannerDiagnostics};
  }
}
export class PlannerV2JourneyRecoveryService {
  constructor(private readonly database: RailwayDatabase,private readonly provider: AvailabilityProvider,private readonly options: JourneyOptions={}){}
  async search(input: Omit<ValidationInput,'plannerCandidates'|'plannerDiagnostics'>){
    const planner=new LocalJourneyPlannerV2(this.database).search({from:input.source,to:input.destination,date:input.journeyDate});
    return {kind:'OFFLINE_CAPABLE_JOURNEY_RECOVERY' as const,dataset:planner.dataset,...await new JourneyRecoveryOrchestrator(this.database,this.provider,this.options).validate({...input,plannerCandidates:planner.journeys,plannerDiagnostics:planner.diagnostics})};
  }
}
