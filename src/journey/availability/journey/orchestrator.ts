import {AvailabilityProviderBudget} from '../../../providers/availability-provider-budget.js';
import {hardeningConfig} from '../../../config/hardening.js';
import { deepJourneySearchPolicy } from './search-policy.js';
import {candidateRevisitPolicy,type CandidateRevisitDiagnostics,type EvidenceSearchDiagnostics,type EvidenceStopReason} from '../recovery/evidence-search.js';
import {requestKey,usable} from '../inventory.js';
import {recoveryClassPreference} from '../recovery/paths.js';
import type { RailwayDatabase } from '../../../local-railway/database.js';
import { LocalJourneyPlannerV2 } from '../../../local-railway/planner/v2/planner.js';
import { searchModeConfig } from '../../../application/search-mode.js';
import { travelClasses } from '../../types/journey-segment.js';
import { AvailabilityOrchestrator } from '../orchestrator.js';
import { AvailabilitySession } from '../session.js';
import { recoverSingleTrainLeg, type DeferredRecoveryWork } from '../recovery/recover.js';
import type { RecoverySegment, ReservedSegment, RecoveryLimits, RecoveryDiagnostics, RecoveryResult } from '../recovery/types.js';
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
  /** Internal historical-evaluation switch. Product AUTO enables bounded revisit. */
  candidateRevisit?:boolean;
  /** Internal historical-evaluation switch. Product AUTO balances stations/classes. */
  balancedFairness?:boolean;
  /** Internal historical-evaluation switch. AUTO stops redundant whole-leg widening. */
  sufficientDirectResults?:boolean;
  providerCallBudgetLimit?:number;
  /** AUTO is the product policy. Explicit older policies support regression/CLI comparison. */
  directSearch?: 'AUTO' | 'MATRIX' | 'PROGRESSIVE';
  minimumJourneyReservedCoverageRatio?: number;
  maxRecoveryRequestsPerCandidate?: number;
  recoveryLimits?: Partial<RecoveryLimits>;
  recoveryReserve?: number;
}
const reserves = { QUICK: 3, STANDARD: 8, DEEP: 10 };
const caps = { QUICK: 3, STANDARD: 8, DEEP: 12 };
const isReserved = (s: RecoverySegment): s is ReservedSegment => s.type === 'RESERVED';
export function rankJourneys(a: RecoveredJourney, b: RecoveredJourney): number {
  const safety=(j:RecoveredJourney)=>j.scheduleCandidate.connections.reduce((n,c)=>n+({GOOD:0,TIGHT:1,LONG:2}[c.safety]),0);
  const quality=(j:RecoveredJourney)=>j.totalDistanceKm?(j.reservedDistanceKm-.2*j.racDistanceKm)/j.totalDistanceKm:0;
  return b.reservedCoverageRatio-a.reservedCoverageRatio || quality(b)-quality(a) || a.trainChanges-b.trainChanges || a.classChanges-b.classChanges || safety(a)-safety(b) || a.scheduleCandidate.durationMinutes-b.scheduleCandidate.durationMinutes || a.totalDistanceKm-b.totalDistanceKm || Number(b.fareComplete)-Number(a.fareComplete) || (a.fareComplete&&b.fareComplete?a.knownReservedFare-b.knownReservedFare:0) || a.unknownDistanceKm-b.unknownDistanceKm || a.scheduleRank-b.scheduleRank || a.scheduleCandidateId.localeCompare(b.scheduleCandidateId);
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
    if(this.options.directSearch!==undefined&&!['AUTO','MATRIX','PROGRESSIVE'].includes(this.options.directSearch))throw new Error('Invalid direct search policy');
    const auto=(this.options.directSearch??'AUTO')==='AUTO';
    const matrix=this.options.directSearch!=='PROGRESSIVE';
    if(!['QUICK','STANDARD','DEEP'].includes(mode))throw new Error('Invalid mode');
    const threshold=this.options.minimumJourneyReservedCoverageRatio??.5;
    const cap=this.options.maxRecoveryRequestsPerCandidate??caps[mode];
    const batches=this.options.batchSizes??[3,3,5];
    const target=this.options.usableTarget??(matrix?deepJourneySearchPolicy.initialVisibleJourneys:3);
    const reserve=matrix?0:this.options.recoveryReserve??reserves[mode];
    if(!Number.isSafeInteger(reserve)||reserve<0||!Number.isFinite(threshold)||threshold<=0||threshold>1||!Number.isSafeInteger(cap)||cap<0||!Number.isSafeInteger(target)||target<1||!batches.length||batches.some(n=>!Number.isSafeInteger(n)||n<1))throw new Error('Invalid journey recovery limits');
    const requestedBudget=this.options.budgetLimit??(matrix?deepJourneySearchPolicy.maxAvailabilityChecks:searchModeConfig(mode).budget!.maxAvailabilityCalls!);
    if(!Number.isSafeInteger(requestedBudget)||requestedBudget<0)throw new Error('Invalid availability budget');
    const session=new AvailabilitySession(this.provider,matrix?Math.min(requestedBudget,deepJourneySearchPolicy.maxAvailabilityChecks):requestedBudget,new AvailabilityProviderBudget(this.options.providerCallBudgetLimit??hardeningConfig().providerCallBudgetLimit),this.provider.currentTimeMs??Date.now);
    const initialReserve=Math.min(reserve,session.limit);
    const d={directCandidates:0,directWholeLegChecks:0,directWholeLegUsable:0,sameTrainRecoveryCandidates:0,sameTrainStationsEligible:0,sameTrainStationsConsidered:0,sameTrainStationsRemaining:0,sameTrainFullRecoveries:0,directLaneBudgetUsed:0,indirectLaneStarted:false,indirectLaneBudgetUsed:0,recoveryReserveInitial:initialReserve,recoveryReserveUsed:0,recoveryReserveReleased:0,releasedReserveCalls:0,candidatesCheckedWholeLeg:0,plannerCandidatesReceived:input.plannerCandidates.length,wholeLegCandidatesValidated:0,wholeLegUsableJourneys:0,candidatesSentToRecovery:0,legsEligibleForRecovery:0,legsRecoveryAttempted:0,legsRecoverySucceeded:0,coverageFeasibilityPruned:0,candidateRecoveryBudgetPruned:0,fullReservedJourneys:0,fullSplitClassJourneys:0,partialRecoveryJourneys:0,scheduledFallbackJourneys:0,inventoryIncompleteJourneys:0,totalReservedDistanceEvaluated:0,totalSelfManagedDistanceReturned:0,wholeLegRequests:0,recoveryIntervalRequests:0,bottleneckLegsEvaluated:0,recoveryEarlyStops:0,candidatesDeferredByBudget:0,candidatesDeferredByTarget:0,truncated:false,breadthCandidatesConsidered:0,breadthCandidatesChecked:0,breadthRequests:0,completionCandidatesConsidered:0,completionCandidatesChecked:0,completionRequests:0,deepWideningCandidates:0,deepWideningRequests:0,candidatesDeferredByAtomicCost:0,candidatesDeferredByBreadthLimit:0};
    const journeys: RecoveredJourney[]=[];
    const candidateRevisit:CandidateRevisitDiagnostics={candidates:0,rounds:0,providerCalls:0,logicalChecks:0,fullRecoveries:0,turns:[]};
    const directProgress=new Map<number,RecoveryDiagnostics>();
    const evidenceProgress=new Map<number,EvidenceSearchDiagnostics>();
    const recoveryAttempted=new Set<number>();
    const recoverySpent=new Map<number,number>();
    const recoveryCandidates=new Set<number>(),attemptedLegs=new Set<string>(),successfulLegs=new Set<string>();
    const deferredRecovery:{rank:number;minimumCost:()=>number;run:(allowance:number)=>Promise<void>;remainingCap:()=>number}[]=[];
    const budgetDeferred=new Set<number>(),targetDeferred=new Set<number>();
    const checked=new Set<number>(),fullyChecked=new Set<number>(),wholeUsable=new Set<number>();
    let protectedRemaining=initialReserve;
    const scheduled=input.plannerCandidates.map((candidate,i)=>({candidate,rank:i+1}));
    const isDirect=(x:typeof scheduled[number])=>x.candidate.segments.length===1&&x.candidate.changes===0;
    const direct=scheduled.filter(isDirect),indirect=scheduled.filter(x=>!isDirect(x));
    d.directCandidates=direct.length;
    for(const lane of [direct,indirect]){
    if(!lane.length)continue;
    const directLane=lane===direct,laneBefore=session.budget.callsUsed,wholeBefore=d.wholeLegRequests;
    if(directLane&&auto){
      // Validate request/candidate scope before any provider work. Zero allowance
      // uses the existing validator without its old sequential allocation policy.
      const validator=new AvailabilityOrchestrator(this.provider,{...this.options,progressiveAllocation:true,completeFailedCandidates:true});
      await session.withAllowance(0,()=>validator.validate({...input,plannerCandidates:lane.map(x=>x.candidate)},session));
      const all=input.requestedClasses.some(c=>c.trim().toUpperCase()==='ALL');
      const requested=all?[...travelClasses]:input.requestedClasses.map(c=>c.trim().toUpperCase());
      const classes=(this.options.classRounds??[['SL','3A'],['2A','CC','2S'],['1A','EC','3E']]).flat().filter(c=>requested.includes(c));
      const allowed=(train:string,c:string)=>input.supportedClassesByTrain?.[train]===undefined||input.supportedClassesByTrain[train].some(x=>x.trim().toUpperCase()===c);
      const wholeRequest=(candidate:typeof lane[number]['candidate'],travelClass:string)=>{const l=candidate.segments[0];return {trainNumber:l.trainNumber,fromStationCode:l.fromStation,toStationCode:l.toStation,journeyDate:l.boardingDate,travelClass,quota:'GN' as const};};
      const strongWhole=(candidate:typeof lane[number]['candidate'])=>classes.some(c=>session.peekKey(requestKey(wholeRequest(candidate,c)))?.status==='AVAILABLE');
      const redundantClass=(candidate:typeof lane[number]['candidate'],travelClass:string)=>!classes.some(c=>session.peekKey(requestKey(wholeRequest(candidate,c)))?.fare)&&classes.some(c=>{
        const hit=session.peekKey(requestKey(wholeRequest(candidate,c)));
        return hit?.status==='AVAILABLE'&&!hit.fare&&recoveryClassPreference(c)<recoveryClassPreference(travelClass);
      });
      const sufficientWhole=()=>new Set(lane.filter(x=>strongWhole(x.candidate)).map(x=>x.candidate.segments[0].trainNumber)).size>=Math.max(5,target);
      // AVAILABLE, whole-leg, zero-change evidence is already maximal on the
      // ranking dimensions preceding duration/distance. Only strictly slower/
      // longer schedules can be dominated; ties retain recovery opportunities.
      const competitiveSchedule=(candidate:typeof lane[number]['candidate'])=>{
        const distinct=new Map(lane.filter(x=>strongWhole(x.candidate)).map(x=>[x.candidate.segments[0].trainNumber,x.candidate]));
        const fifth=[...distinct.values()].sort((a,b)=>a.durationMinutes-b.durationMinutes||a.segments[0].distanceKm-b.segments[0].distanceKm)[Math.max(5,target)-1];
        return !fifth||candidate.durationMinutes<fifth.durationMinutes||candidate.durationMinutes===fifth.durationMinutes&&candidate.segments[0].distanceKm<=fifth.segments[0].distanceKm;
      };
      const initialOpportunity=new Set<number>();
      // Class-major whole-leg breadth across ALL direct trains before recovery.
      // No inferred class support and no per-train provider budget is created.
      for(const c of classes)for(const {candidate,rank}of lane){
        session.assertActive();const r=wholeRequest(candidate,c);
        if(session.remainingTimeMs()<=0||!allowed(r.trainNumber,c)||!session.canAfford([r]))continue;
        // Only ALL's lower-preference variants on already strong trains are deferred.
        // Every eligible train keeps its first opportunity; RAC/unknown trains
        // keep all classes. Recheck fresh session evidence at every decision.
        if(this.options.sufficientDirectResults!==false&&all&&initialOpportunity.has(rank)&&sufficientWhole()&&redundantClass(candidate,c))continue;
        const before=session.budget.callsUsed;await session.get(r);
        initialOpportunity.add(rank);
        d.wholeLegRequests+=session.budget.callsUsed-before;checked.add(rank);
      }
      const validated=await session.withAllowance(0,()=>validator.validate({...input,plannerCandidates:lane.map(x=>x.candidate)},session));
      const wholes=new Map(validated.journeys.map(whole=>{const index=whole.scheduleRank-1;whole.scheduleRank=lane[index].rank;return [whole.scheduleRank,whole];}));
      const wholeGood=(candidate:typeof lane[number]['candidate'])=>classes.some(c=>{const hit=session.peekKey(requestKey(wholeRequest(candidate,c)));return hit&&usable(hit);});
      const revisitWork=new Map<number,{result:RecoveryResult;remainingLogical:number;noGain:number}>();
      // Solved trains release their reservation. Each unsolved train leaves at
      // least half of remaining attempts (or eight per later train) for successors.
      // Reservations are conservative scheduler estimates; SDK retries still use
      // the unchanged atomic global admission gate.
      for(const [index,{candidate,rank}]of lane.entries()){
        session.assertActive();const whole=wholes.get(rank)!,l=whole.legs[0];
        if(wholeGood(candidate))wholeUsable.add(rank);
        if(whole.status!=='INVENTORY_CHECK_INCOMPLETE')fullyChecked.add(rank);
        const enough=this.options.sufficientDirectResults!==false&&all&&sufficientWhole()
          ?!competitiveSchedule(candidate)
          :lane.filter(x=>wholeGood(x.candidate)).length+journeys.filter(j=>!wholeUsable.has(j.scheduleRank)&&j.reservedCoverageRatio===1).length>=target;
        const later=lane.slice(index+1).filter(x=>!wholeGood(x.candidate)).length;
        const remaining=session.providerBudget.statistics().providerCallBudgetRemaining;
        const hold=later?Math.min(remaining,Math.max(Math.ceil(remaining/2),later*8)):0;
        const before=session.budget.callsUsed;
        const wholeSpent=classes.filter(c=>session.hasKey(requestKey(wholeRequest(candidate,c)))).length;
        const allowance=Math.min(session.remaining,Math.max(0,deepJourneySearchPolicy.maxChecksPerDirectCandidate-wholeSpent),this.options.maxRecoveryRequestsPerCandidate??Infinity);
        const recovered=await session.withAllowance(allowance,()=>recoverSingleTrainLeg(this.database,session,{trainNumber:l.trainNumber,fromStation:l.fromStation,toStation:l.toStation,boardingDateTime:l.departureDateTime,arrivalDateTime:l.arrivalDateTime,distanceKm:l.distanceKm,requestedClasses:input.requestedClasses,supportedClasses:input.supportedClassesByTrain?.[l.trainNumber]},this.options.recoveryLimits,undefined,{evidenceSearch:{deferWholeLegWidening:this.options.sufficientDirectResults!==false&&all&&sufficientWhole()&&strongWhole(candidate),balancedFairness:this.options.balancedFairness,providerAllowance:Math.max(0,remaining-hold),enough:enough||wholeGood(candidate)}}));
        d.recoveryIntervalRequests+=session.budget.callsUsed-before;
        directProgress.set(rank,recovered.diagnostics);evidenceProgress.set(rank,recovered.diagnostics.evidenceSearch!);
        if(recovered.diagnostics.candidateIntervalsGenerated>1){d.candidatesSentToRecovery++;d.legsEligibleForRecovery++;d.legsRecoveryAttempted++;}
        const best=recovered.best,incomplete=best.reservedCoverageRatio<1&&(!recovered.diagnostics.progressive?.complete||recovered.diagnostics.providerErrors>0);
        const leg:JourneyLeg={trainNumber:l.trainNumber,scheduledFrom:l.fromStation,scheduledTo:l.toStation,recoveryStatus:incomplete?'INVENTORY_CHECK_INCOMPLETE':best.recoveryStatus,segments:incomplete?best.segments.filter(isReserved):best.segments,legDistanceKm:l.distanceKm,reservedDistanceKm:best.reservedDistanceKm,reservedCoverageRatio:best.reservedCoverageRatio,unknownDistanceKm:incomplete?l.distanceKm-best.reservedDistanceKm:0};
        if(best.reservedDistanceKm>0&&!wholeUsable.has(rank))d.legsRecoverySucceeded++;
        if(recovered.diagnostics.evidenceSearch!.stopReason==='PROVIDER_BUDGET_EXHAUSTED'||recovered.diagnostics.evidenceSearch!.stopReason==='LOGICAL_SAFETY_LIMIT')budgetDeferred.add(rank);
        if(recovered.diagnostics.evidenceSearch!.stopReason==='SUFFICIENT_HIGH_QUALITY_RESULTS'&&best.reservedCoverageRatio<1)targetDeferred.add(rank);
        d.truncated ||= recovered.diagnostics.truncated;
        journeys.push(assemble(whole,[leg],threshold));
        if(recovered.revisit&&this.options.candidateRevisit!==false)revisitWork.set(rank,{result:recovered,remainingLogical:Math.max(0,allowance-(session.budget.callsUsed-before)),noGain:0});
      }
      const visitedCandidates=new Set<number>();
      for(let round=1;round<=candidateRevisitPolicy.maxRounds;round++){
        if(session.providerBudget.stopped||session.remaining<=0||session.remainingTimeMs()<=0||journeys.filter(j=>j.reservedCoverageRatio===1).length>=target)break;
        const active=[...revisitWork].filter(([,w])=>w.remainingLogical>0&&w.noGain<candidateRevisitPolicy.noGainRounds&&w.result.best.reservedCoverageRatio>0&&w.result.best.reservedCoverageRatio<1&&['FAIRNESS_RESERVE','MARGINAL_VALUE_LOW'].includes(w.result.diagnostics.evidenceSearch!.stopReason))
          .sort((a,b)=>b[1].result.best.reservedCoverageRatio-a[1].result.best.reservedCoverageRatio||a[1].result.best.selfManagedDistanceKm-b[1].result.best.selfManagedDistanceKm||a[0]-b[0]);
        if(!active.length)break;
        for(const [index,[rank,work]]of active.entries()){
          session.assertActive();
          if(session.providerBudget.stopped||session.remaining<=0||session.remainingTimeMs()<=0||journeys.filter(j=>j.reservedCoverageRatio===1).length>=target)break;
          const remaining=session.providerBudget.statistics().providerCallBudgetRemaining;
          const share=Math.min(candidateRevisitPolicy.checksPerTurn,Math.ceil(remaining/(active.length-index)));
          const allowance=Math.min(candidateRevisitPolicy.checksPerTurn,work.remainingLogical,session.remaining);
          const before=session.statistics(),prior=work.result.best.reservedDistanceKm;
          const recovered=await session.withAllowance(allowance,()=>work.result.revisit!(share,allowance));
          const after=session.statistics(),calls=after.providerAvailabilityCalls-before.providerAvailabilityCalls,checksUsed=after.logicalAvailabilityChecks-before.logicalAvailabilityChecks;
          work.remainingLogical-=after.availabilityRequestsUsed-before.availabilityRequestsUsed;
          work.noGain=recovered.best.reservedDistanceKm>prior?0:work.noGain+1;work.result=recovered;
          visitedCandidates.add(rank);candidateRevisit.rounds=round;candidateRevisit.providerCalls+=calls;candidateRevisit.logicalChecks+=checksUsed;
          candidateRevisit.turns.push({round,trainNumber:recovered.best.trainNumber,providerCalls:calls,logicalChecks:checksUsed,stopReason:recovered.diagnostics.evidenceSearch!.stopReason});
          d.recoveryIntervalRequests+=after.availabilityRequestsUsed-before.availabilityRequestsUsed;
          directProgress.set(rank,recovered.diagnostics);evidenceProgress.set(rank,recovered.diagnostics.evidenceSearch!);
          const best=recovered.best,whole=wholes.get(rank)!,l=whole.legs[0],incomplete=best.reservedCoverageRatio<1&&(!recovered.diagnostics.progressive?.complete||recovered.diagnostics.providerErrors>0);
          const leg:JourneyLeg={trainNumber:l.trainNumber,scheduledFrom:l.fromStation,scheduledTo:l.toStation,recoveryStatus:incomplete?'INVENTORY_CHECK_INCOMPLETE':best.recoveryStatus,segments:incomplete?best.segments.filter(isReserved):best.segments,legDistanceKm:l.distanceKm,reservedDistanceKm:best.reservedDistanceKm,reservedCoverageRatio:best.reservedCoverageRatio,unknownDistanceKm:incomplete?l.distanceKm-best.reservedDistanceKm:0};
          journeys[journeys.findIndex(j=>j.scheduleRank===rank)]=assemble(whole,[leg],threshold);
          if(best.reservedCoverageRatio===1){candidateRevisit.fullRecoveries++;budgetDeferred.delete(rank);targetDeferred.delete(rank);}
          d.truncated ||= recovered.diagnostics.truncated;
        }
      }
      candidateRevisit.candidates=visitedCandidates.size;
      d.directLaneBudgetUsed=session.budget.callsUsed-laneBefore;d.directWholeLegChecks=d.wholeLegRequests-wholeBefore;
      continue;
    }
    if(directLane&&matrix){
      // The display target never stops direct evidence collection.
      for(const {candidate,rank} of lane){
        session.assertActive();
        const before=session.budget.callsUsed;
        await session.withAllowance(Math.min(session.remaining,deepJourneySearchPolicy.maxChecksPerDirectCandidate),async()=>{
          const validator=new AvailabilityOrchestrator(this.provider,{...this.options,progressiveAllocation:true,completeFailedCandidates:true,usableTarget:1});
          const validation=await validator.validate({...input,plannerCandidates:[candidate]},session);
          const whole=validation.journeys[0];whole.scheduleRank=rank;
          d.wholeLegRequests+=session.budget.callsUsed-before;
          if(whole.legs[0].checks.length)checked.add(rank);
          const l=whole.legs[0];
          if(whole.status!=='INVENTORY_CHECK_INCOMPLETE')fullyChecked.add(rank);
          let leg:JourneyLeg;
          if(whole.status==='FULLY_RESERVED_USABLE'&&l.availabilityStatus==='AVAILABLE'){
            wholeUsable.add(rank);
            const segment:ReservedSegment={type:'RESERVED',trainNumber:l.trainNumber,fromStation:l.fromStation,toStation:l.toStation,departureDateTime:l.departureDateTime,arrivalDateTime:l.arrivalDateTime,selectedClass:l.selectedClass!,quota:'GN',availabilityStatus:l.availabilityStatus as 'AVAILABLE'|'RAC',availabilityText:l.availabilityText,distanceKm:l.distanceKm,fare:l.fare,reservationParts:[{fromStation:l.fromStation,toStation:l.toStation,departureDateTime:l.departureDateTime,arrivalDateTime:l.arrivalDateTime,boardingDate:l.boardingDate,distanceKm:l.distanceKm,availabilityStatus:l.availabilityStatus as 'AVAILABLE'|'RAC',availabilityText:l.availabilityText,fare:l.fare}]};
            leg={trainNumber:l.trainNumber,scheduledFrom:l.fromStation,scheduledTo:l.toStation,recoveryStatus:'WHOLE_LEG_USABLE',segments:[segment],legDistanceKm:l.distanceKm,reservedDistanceKm:l.distanceKm,reservedCoverageRatio:1,unknownDistanceKm:0};
          }else{
            d.candidatesSentToRecovery++;d.legsEligibleForRecovery++;d.legsRecoveryAttempted++;
            const recoveryBefore=session.budget.callsUsed;
            const allowance=Math.min(session.remaining,this.options.maxRecoveryRequestsPerCandidate??Infinity);
            const recovered=await session.withAllowance(allowance,()=>recoverSingleTrainLeg(this.database,session,{trainNumber:l.trainNumber,fromStation:l.fromStation,toStation:l.toStation,boardingDateTime:l.departureDateTime,arrivalDateTime:l.arrivalDateTime,distanceKm:l.distanceKm,requestedClasses:input.requestedClasses,supportedClasses:input.supportedClassesByTrain?.[l.trainNumber]},this.options.recoveryLimits,undefined,{completeMatrix:true}));
            d.recoveryIntervalRequests+=session.budget.callsUsed-recoveryBefore;
            directProgress.set(rank,recovered.diagnostics);
            const best=recovered.best,incomplete=best.reservedCoverageRatio<1&&(recovered.diagnostics.truncationReasons.some(r=>r==='availabilityBudget'||r==='missingDistanceSplits')||recovered.diagnostics.providerErrors>0);
            leg={trainNumber:l.trainNumber,scheduledFrom:l.fromStation,scheduledTo:l.toStation,recoveryStatus:incomplete?'INVENTORY_CHECK_INCOMPLETE':best.recoveryStatus,segments:incomplete?best.segments.filter(isReserved):best.segments,legDistanceKm:l.distanceKm,reservedDistanceKm:best.reservedDistanceKm,reservedCoverageRatio:best.reservedCoverageRatio,unknownDistanceKm:incomplete?l.distanceKm-best.reservedDistanceKm:0};
            if(best.reservedDistanceKm>0)d.legsRecoverySucceeded++;
            d.truncated ||= recovered.diagnostics.truncated;
            if(recovered.diagnostics.truncationReasons.includes('availabilityBudget')){budgetDeferred.add(rank);d.candidateRecoveryBudgetPruned++;}
          }
          journeys.push(assemble(whole,[leg],threshold));
        });
      }
      d.directLaneBudgetUsed=session.budget.callsUsed-laneBefore;
      d.directWholeLegChecks=d.wholeLegRequests-wholeBefore;
      continue;
    }
    // Explicit selections are a hard scope; only ALL expands canonical classes.
    // Early probing requires a complete fair preferred-class pass inside the
    // existing bounded direct pool and protected whole-leg allowance.
    const earlyRound=directLane&&lane.length>1&&lane.length<={QUICK:3,STANDARD:5,DEEP:7}[mode]
      &&lane.length<=session.remaining-protectedRemaining&&input.requestedClasses.some(c=>c.trim().toUpperCase()==='ALL')
      ? [(this.options.classRounds??[['SL','3A'],['2A','CC','2S'],['1A','EC','3E']])[0][0]] : undefined;

    deferredRecovery.length=0;
    const revisitRecovery=async()=>{
    // Within this phase, rotate deferred candidates so
    // each gets a fair turn before another turn goes to the same candidate.
    // Atomic groups can borrow only enough to make progress. A finite sweep
    // bound and no-progress stop also bound cache-only work.
    for(let pass=0;pass<=session.limit&&deferredRecovery.length;pass++){
      session.assertActive();
      const active=deferredRecovery.filter(w=>journeys.find(j=>j.scheduleRank===w.rank)!.reservedCoverageRatio<1&&w.minimumCost()<=Math.min(session.remaining,w.remainingCap()));
      if(!active.length)break;
      const before=session.budget.callsUsed;
      for(const [index,work] of active.entries()){
        session.assertActive();
        if(journeys.filter(j=>j.journeyStatus.startsWith('FULLY_RESERVED')).length>=target)break;
        const cost=work.minimumCost();
        if(cost>Math.min(session.remaining,work.remainingCap()))continue;
        const share=Math.floor(session.remaining/(active.length-index));
        await work.run(Math.min(session.remaining,work.remainingCap(),Math.max(cost,Math.min(cap,share))));
      }
      if(session.budget.callsUsed===before||journeys.filter(j=>j.journeyStatus.startsWith('FULLY_RESERVED')).length>=target)break;
    }
    };
    // Complete direct exact/recovery/revisit work before the indirect lane.
    // Phase C: revisit deferred whole-leg candidates after releasing unused reserve.
    for(const phase of (earlyRound?['EARLY','PROMISING','PROTECTED','RELEASED']:['PROTECTED','RELEASED'])){
    // A bounded first-round recovery turn precedes later ALL exact rounds.
    // The complete request scope is restored before returning any fallback.
    const laneInput=phase==='EARLY'?{...input,requestedClasses:earlyRound!}:input;
    const validator=new AvailabilityOrchestrator(this.provider,{...this.options,directFirst:directLane,directRoundOnly:phase==='EARLY',progressiveAllocation:true,completeFailedCandidates:true,usableTarget:target});
    if(phase==='PROMISING'){for(const rank of fullyChecked)if(!wholeUsable.has(rank))fullyChecked.delete(rank);recoveryAttempted.clear();deferredRecovery.length=0;}

    if(phase==='RELEASED'){
      d.recoveryReserveReleased=Math.min(protectedRemaining,session.remaining);
      protectedRemaining=0;
    }
    let offset=0;
    // Retain unvisited schedule candidates explicitly, without spending inventory calls.
    while(offset<lane.length){
      const stop=journeys.filter(j=>j.journeyStatus.startsWith('FULLY_RESERVED')).length>=target;
      const scheduledBatch=lane.slice(offset);
      const indexed=scheduledBatch.filter(x=>!journeys.some(j=>j.scheduleRank===x.rank&&j.journeyStatus.startsWith('FULLY_RESERVED'))
        &&(phase!=='PROMISING'||journeys.some(j=>j.scheduleRank===x.rank&&j.reservedDistanceKm>0))
        &&(phase!=='PROTECTED'||!earlyRound||!recoveryAttempted.has(x.rank))
        &&(phase!=='RELEASED'||(!fullyChecked.has(x.rank)&&!recoveryAttempted.has(x.rank))));
      const batch=indexed.map(x=>x.candidate);
      const before=session.budget.callsUsed;
      const validated=await session.withAllowance(stop?0:Math.max(0,session.remaining-protectedRemaining),()=>validator.validate({...laneInput,plannerCandidates:batch},session));
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
          const allowed=(laneInput.requestedClasses.some(c=>c.trim().toUpperCase()==='ALL')?[...travelClasses]:laneInput.requestedClasses.map(c=>c.trim().toUpperCase())).filter(c=>input.supportedClassesByTrain?.[l.trainNumber]===undefined||input.supportedClassesByTrain[l.trainNumber].map(c=>c.trim().toUpperCase()).includes(c));
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
        const recoverCandidate=!enough&&journeys.filter(j=>j.journeyStatus.startsWith('FULLY_RESERVED')).length<target
          &&!(phase==='EARLY'&&journeys.some(j=>j.reservedDistanceKm>0)
            &&session.remaining<session.missingRequests(lane.flatMap(({candidate})=>candidate.segments.flatMap(l=>travelClasses
              .filter(c=>input.supportedClassesByTrain?.[l.trainNumber]===undefined||input.supportedClassesByTrain[l.trainNumber].map(x=>x.trim().toUpperCase()).includes(c))
              .map(travelClass=>({trainNumber:l.trainNumber,fromStationCode:l.fromStation,toStationCode:l.toStation,journeyDate:l.boardingDate,travelClass,quota:'GN' as const})))))+reserve);
        let result=assemble(whole,legs,threshold);
        // Unknown whole-leg inventory is never relabelled as a self-managed gap.
        const optimistic=result.reservedDistanceKm+eligible.reduce((n,i)=>n+legs[i].legDistanceKm,0);
        if(recoverCandidate&&eligible.length&&optimistic+1e-9<threshold*result.totalDistanceKm)d.coverageFeasibilityPruned++;
        else if(recoverCandidate&&eligible.length&&result.unknownDistanceKm===0){
          if(!recoveryCandidates.has(whole.scheduleRank)){recoveryCandidates.add(whole.scheduleRank);d.candidatesSentToRecovery++;}
          recoveryAttempted.add(whole.scheduleRank);
          eligible.sort((a,b)=>legs[b].legDistanceKm-legs[a].legDistanceKm||legs[a].reservedCoverageRatio-legs[b].reservedCoverageRatio||(input.supportedClassesByTrain?.[legs[a].trainNumber]?.length??8)-(input.supportedClassesByTrain?.[legs[b].trainNumber]?.length??8)||a-b);
          // Leave at least one request for another candidate; allowance is never a new budget.
          const fairShare=Math.floor(Math.max(0,session.remaining-1)/Math.max(1,recoveryCandidatesRemaining));
          const allowance=Math.min(cap,fairShare,phase==='EARLY'?Math.min(protectedRemaining,2*earlyRound!.length):Infinity,
            this.options.maxRecoveryRequestsPerCandidate===undefined?Infinity:Math.max(0,cap-(recoverySpent.get(whole.scheduleRank)??0)));
          recoveryCandidatesRemaining=Math.max(0,recoveryCandidatesRemaining-1);
          const workByLeg=new Map<number,DeferredRecoveryWork>();
          let candidateSpent=recoverySpent.get(whole.scheduleRank)??0;
          const runRecovery=async(allowance:number)=>{
            const recoveryBefore=session.budget.callsUsed;
            await session.withAllowance(allowance,async()=>{
              for(const i of eligible){
                if(legs[i].reservedCoverageRatio>=1||(workByLeg.has(i)&&!workByLeg.get(i)!.requests.length))continue;
                const legKey=`${whole.scheduleRank}:${i}`;
                const firstAttempt=!attemptedLegs.has(legKey);attemptedLegs.add(legKey);
                const deferred:DeferredRecoveryWork={requests:[]};
                workByLeg.set(i,deferred);
                if(firstAttempt){d.legsRecoveryAttempted++;d.bottleneckLegsEvaluated++;}
                const l=whole.scheduleCandidate.segments[i];
                const recovered=await recoverSingleTrainLeg(this.database,session,{trainNumber:l.trainNumber,fromStation:l.fromStation,toStation:l.toStation,boardingDateTime:l.departureDateTime,arrivalDateTime:l.arrivalDateTime,distanceKm:l.distanceKm,requestedClasses:laneInput.requestedClasses,supportedClasses:input.supportedClassesByTrain?.[l.trainNumber]},this.options.recoveryLimits,deferred,{progressiveStations:directLane,singleClassPaths:auto});
                if(phase==='EARLY'&&recovered.diagnostics.progressive)recovered.diagnostics.progressive.complete=false;
                if(directLane)directProgress.set(whole.scheduleRank,recovered.diagnostics);
                const best=recovered.best;
                // Consume the best evidence even below the standalone leg threshold:
                // eligibility belongs to the complete journey, not individual legs.
                if(best.reservedDistanceKm>0&&!successfulLegs.has(legKey)){successfulLegs.add(legKey);d.legsRecoverySucceeded++;}
                legs[i]={...legs[i],recoveryStatus:best.recoveryStatus,segments:best.segments,reservedDistanceKm:best.reservedDistanceKm,reservedCoverageRatio:best.reservedCoverageRatio,unknownDistanceKm:recovered.diagnostics.providerErrors&&best.reservedCoverageRatio<1?best.selfManagedDistanceKm:0};
                if(legs[i].unknownDistanceKm)legs[i].segments=best.segments.filter(isReserved);
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
            candidateSpent+=recoveryCalls;recoverySpent.set(whole.scheduleRank,candidateSpent);
            d.recoveryIntervalRequests+=recoveryCalls;
            if(phase!=='RELEASED'){
              const used=Math.min(protectedRemaining,recoveryCalls);
              protectedRemaining-=used;d.recoveryReserveUsed+=used;
            }
          };
          await runRecovery(allowance);
          // Defaults throttle each fair turn. Explicit caller caps remain hard
          // totals across the initial attempt and every revisit turn.
          const remainingCap=()=>this.options.maxRecoveryRequestsPerCandidate===undefined?Infinity:Math.max(0,cap-candidateSpent);
          const minimumCost=()=>Math.min(...[...workByLeg.values()].flatMap(w=>w.requests).map(r=>session.missingRequests(r)));
          if(result.reservedCoverageRatio<1&&Number.isFinite(minimumCost())&&remainingCap()>0){
            deferredRecovery.push({rank:whole.scheduleRank,minimumCost,remainingCap,run:async allowance=>{
              budgetIncomplete.clear();
              await runRecovery(allowance);
              if(result.reservedCoverageRatio+1e-9<threshold&&budgetIncomplete.size){
                for(const i of budgetIncomplete){legs[i].unknownDistanceKm=legs[i].legDistanceKm-legs[i].reservedDistanceKm;legs[i].segments=legs[i].segments.filter(isReserved);}
                result=assemble(whole,legs,threshold);
              }
              journeys[journeys.findIndex(j=>j.scheduleRank===whole.scheduleRank)]=result;
            }});
          }
        }
        if(result.reservedCoverageRatio+1e-9<threshold&&budgetIncomplete.size){
          for(const i of budgetIncomplete){legs[i].unknownDistanceKm=legs[i].legDistanceKm-legs[i].reservedDistanceKm;legs[i].segments=legs[i].segments.filter(isReserved);}
          result=assemble(whole,legs,threshold);
        }
        if(candidateCapPruned)d.candidateRecoveryBudgetPruned++;
        const previous=journeys.findIndex(j=>j.scheduleRank===whole.scheduleRank);
        // Keep early reserved evidence if later exact rounds run out of budget.
        // Unchecked ALL classes remain unknown, never a confirmed failure.
        if(previous>=0&&journeys[previous].reservedDistanceKm>result.reservedDistanceKm){
          const prior=journeys[previous];
          const retained=prior.legs.map((leg,i)=>({...leg,unknownDistanceKm:legs[i].unknownDistanceKm>0?leg.legDistanceKm-leg.reservedDistanceKm:leg.unknownDistanceKm,
            segments:legs[i].unknownDistanceKm>0?leg.segments.filter(isReserved):leg.segments}));
          result=assemble(whole,retained,threshold);
        }
        if(previous<0)journeys.push(result);else journeys[previous]=result;
      }
      offset+=scheduledBatch.length;
    }
    if(phase==='PROMISING')await revisitRecovery();
    }
    await revisitRecovery();
    const laneUsed=session.budget.callsUsed-laneBefore;
    if(directLane){d.directLaneBudgetUsed=laneUsed;d.directWholeLegChecks=d.wholeLegRequests-wholeBefore;}
    else {d.indirectLaneBudgetUsed=laneUsed;d.indirectLaneStarted=lane.some(x=>journeys.find(j=>j.scheduleRank===x.rank)?.wholeLegValidation.legs.some(l=>l.checks.length));}
    }
    if(protectedRemaining){d.recoveryReserveReleased+=Math.min(protectedRemaining,session.remaining);protectedRemaining=0;}
    const directExploration=direct.map(({candidate,rank})=>{
      const result=journeys.find(j=>j.scheduleRank===rank)!,progress=directProgress.get(rank);
      const state=wholeUsable.has(rank)?'EXACT_DIRECT':result.reservedCoverageRatio>=1?'FULL_SAME_TRAIN':
        progress?.progressive?.complete||input.supportedClassesByTrain?.[candidate.segments[0].trainNumber]?.length===0?'EXHAUSTED_SCOPE':progress?.providerErrors||result.wholeLegValidation.legs.some(l=>l.checks.some(c=>c.status==='PROVIDER_ERROR'))?'INCOMPLETE_PROVIDER':
        !matrix&&(targetDeferred.has(rank)||journeys.filter(j=>j.journeyStatus.startsWith('FULLY_RESERVED')).length>=target)?'STOPPED_TARGET':
        progress?.truncationReasons.some(r=>r!=='availabilityBudget')?'INCOMPLETE_LIMIT':'INCOMPLETE_BUDGET';
      return {scheduleRank:rank,trainNumber:candidate.segments[0].trainNumber,state,intervalsGenerated:progress?.candidateIntervalsGenerated??0,...progress?.progressive,...evidenceProgress.get(rank)};
    });
    d.directWholeLegUsable=directExploration.filter(x=>x.state==='EXACT_DIRECT').length;
    d.sameTrainFullRecoveries=directExploration.filter(x=>x.state==='FULL_SAME_TRAIN').length;
    d.sameTrainRecoveryCandidates=auto?[...directProgress.values()].filter(p=>p.candidateIntervalsGenerated>1).length:directProgress.size;
    for(const progress of directProgress.values()){
      d.sameTrainStationsEligible+=progress.progressive?.stationsEligible??0;
      d.sameTrainStationsConsidered+=progress.progressive?.stationsConsidered??0;
      d.sameTrainStationsRemaining+=progress.progressive?.stationsRemaining??0;
    }
    d.candidatesDeferredByBudget=budgetDeferred.size;
    d.candidatesDeferredByTarget=targetDeferred.size;
    d.candidatesCheckedWholeLeg=checked.size;
    d.wholeLegCandidatesValidated=fullyChecked.size;
    d.wholeLegUsableJourneys=wholeUsable.size;
    journeys.sort(rankJourneys);journeys.forEach((j,i)=>{j.finalRank=i+1;d.totalReservedDistanceEvaluated+=j.reservedDistanceKm;d.totalSelfManagedDistanceReturned+=j.selfManagedDistanceKm;const fields={FULLY_RESERVED_USABLE:'fullReservedJourneys',FULLY_RESERVED_WITH_SPLIT_CLASS:'fullSplitClassJourneys',PARTIAL_RESERVED_RECOVERY:'partialRecoveryJourneys',SCHEDULED_BUT_NOT_FULLY_AVAILABLE:'scheduledFallbackJourneys',INVENTORY_CHECK_INCOMPLETE:'inventoryIncompleteJourneys'} as const;d[fields[j.journeyStatus]]++;});
    d.truncated ||= d.candidatesDeferredByBudget>0;
    const evidence=journeys.flatMap(j=>j.wholeLegValidation.legs.filter(l=>l.checks.length));
    const progress=[...evidenceProgress.values()],modes=new Set(progress.map(p=>p.searchMode));
    const possibleMatrixEdges=progress.reduce((n,p)=>n+p.possibleMatrixEdges,0),checkedMatrixEdges=progress.reduce((n,p)=>n+p.checkedMatrixEdges,0);
    const stops:EvidenceStopReason[]=['DEADLINE','PROVIDER_RATE_LIMIT','PROVIDER_BUDGET_EXHAUSTED','LOGICAL_SAFETY_LIMIT','PROVIDER_UNAVAILABLE','FAIRNESS_RESERVE','MARGINAL_VALUE_LOW','SUFFICIENT_HIGH_QUALITY_RESULTS','SCOPE_EXHAUSTED','EXACT_MATRIX_COMPLETE'];
    const statistics=session.statistics();
    const stopReason=session.providerBudget.stopped?'PROVIDER_BUDGET_EXHAUSTED':statistics.providerRateLimited>0?'PROVIDER_RATE_LIMIT':stops.find(s=>progress.some(p=>p.stopReason===s))??(statistics.providerErrors?'PROVIDER_UNAVAILABLE':'SCOPE_EXHAUSTED');
    const searchDiagnostics={candidateRevisit,searchMode:modes.size>1?'MIXED':progress[0]?.searchMode??'NONE',possibleMatrixEdges,checkedMatrixEdges,matrixCoverage:possibleMatrixEdges?100*checkedMatrixEdges/possibleMatrixEdges:0,directTrainsConsidered:direct.length,stationsExplored:progress.reduce((n,p)=>n+p.stationsExplored,0),classesExplored:Object.keys(statistics.classChecksByClass).length,fullPathsFound:progress.reduce((n,p)=>n+p.fullPathsFound,0),partialPathsFound:progress.reduce((n,p)=>n+p.partialPathsFound,0),stopReason};
    return {journeys,diagnostics:{...d,...searchDiagnostics,searchPolicy:auto?'EVIDENCE_GRAPH':matrix?'DIRECT_MATRIX':'PROGRESSIVE',directCandidateCheckLimit:matrix?deepJourneySearchPolicy.maxChecksPerDirectCandidate:cap,directExploration,distinctCandidatesWithAnyWholeLegEvidence:new Set(journeys.filter(j=>j.wholeLegValidation.legs.some(l=>l.checks.length)).map(j=>j.scheduleCandidateId)).size,distinctTrainsChecked:new Set(evidence.map(l=>l.trainNumber)).size,distinctTrainClassPairsChecked:new Set(evidence.flatMap(l=>l.checks.map(c=>`${l.trainNumber}:${c.travelClass}`))).size,...session.statistics()},plannerDiagnostics:input.plannerDiagnostics};
  }
}
export class PlannerV2JourneyRecoveryService {
  constructor(private readonly database: RailwayDatabase,private readonly provider: AvailabilityProvider,private readonly options: JourneyOptions={}){}
  async search(input: Omit<ValidationInput,'plannerCandidates'|'plannerDiagnostics'>){
    const planner=new LocalJourneyPlannerV2(this.database,{},this.options.directSearch!=='PROGRESSIVE').search({from:input.source,to:input.destination,date:input.journeyDate});
    return {kind:'OFFLINE_CAPABLE_JOURNEY_RECOVERY' as const,dataset:planner.dataset,...await new JourneyRecoveryOrchestrator(this.database,this.provider,this.options).validate({...input,plannerCandidates:planner.journeys,plannerDiagnostics:planner.diagnostics})};
  }
}
