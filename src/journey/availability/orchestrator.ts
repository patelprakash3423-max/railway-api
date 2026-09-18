import {emptyAvailabilityMetrics} from '../../providers/availability-observation.js';
import { createHash } from 'node:crypto';
import type { AvailabilityRequest } from '../../domain/types/availability.js';
import { searchModeConfig } from '../../application/search-mode.js';
import { parseDate } from '../connection/timing.js';
import { AvailabilitySession } from './session.js';
import { travelClasses, type TravelClass } from '../types/journey-segment.js';
import { journeyIdentity } from '../../local-railway/planner/ranking.js';
import { requestKey, usable } from './inventory.js';
import { chooseClasses, classChanges, rankValidated } from './ranking.js';
import type { AllocationDiagnostics, AvailabilityProvider, AvailabilityDiagnostics, InventoryCheck, ValidatedJourney, ValidationInput, ValidationOptions, ValidationResult } from './types.js';
const defaultRounds: TravelClass[][] = [['SL','3A'],['2A','CC','2S'],['1A','EC','3E']];
const normalizeClass = (value: string): TravelClass => { const c=value.trim().toUpperCase();if(!travelClasses.includes(c as TravelClass))throw new Error(`Unsupported class ${value}`);return c as TravelClass; };
export class AvailabilityOrchestrator {
  constructor(private readonly provider: AvailabilityProvider, private readonly options: ValidationOptions = {}) {}
  async validate(input: ValidationInput, sharedSession?: AvailabilitySession): Promise<ValidationResult> {
    const complete=this.options.completeFailedCandidates??false;
    const mode=input.mode??'STANDARD';if(!['QUICK','STANDARD','DEEP'].includes(mode))throw new Error('Invalid mode');
    parseDate(input.journeyDate);if(input.quota!==undefined&&input.quota!=='GN')throw new Error('Only GN quota is supported');
    if(!input.requestedClasses.length)throw new Error('At least one class required');
    const all=input.requestedClasses.some(c=>c.trim().toUpperCase()==='ALL');
    if(all&&input.requestedClasses.length!==1)throw new Error('Use ALL alone');
    const requested=all?[...travelClasses]:[...new Set(input.requestedClasses.map(normalizeClass))];
    const configured=this.options.classRounds??defaultRounds;
    const flat=configured.flat();if(!configured.length||configured.some(r=>!r.length)||flat.some(c=>!travelClasses.includes(c))||new Set(flat).size!==flat.length||travelClasses.some(c=>!flat.includes(c)))throw new Error('Class rounds must cover supported classes exactly once');
    const rounds=configured.map(r=>r.filter(c=>requested.includes(c))).filter(r=>r.length);
    const batches=this.options.batchSizes??[5,5,10];const target=this.options.usableTarget??5;
    if(!batches.length||batches.some(n=>!Number.isSafeInteger(n)||n<1)||!Number.isSafeInteger(target)||target<1)throw new Error('Invalid availability limits');
    const session=sharedSession??new AvailabilitySession(this.provider,this.options.budgetLimit??searchModeConfig(mode).budget!.maxAvailabilityCalls!);
    const limit=session.budget.callsUsed+session.remaining,budget=session.budget;
    const d:AvailabilityDiagnostics={...emptyAvailabilityMetrics(),plannerCandidatesReceived:input.plannerCandidates.length,candidatesValidationStarted:0,candidatesFullyValidated:0,candidatesRejectedByInventory:0,candidatesDeferredByBudget:0,availabilityBudgetLimit:limit,availabilityRequestsUsed:0,availabilityCacheHits:0,budgetRemaining:limit,classRoundsAttempted:[],classChecksByClass:{},availableResponses:0,racResponses:0,waitlistResponses:0,unavailableResponses:0,unsupportedClassResponses:0,providerErrors:0,providerErrorCategories:{},bottleneckEarlyExits:0,atomicBudgetDeferrals:0,usableJourneysFound:0,fallbackJourneysReturned:0,batchesAttempted:0};
    const unsupported=session.unsupported;
    const cache={get:(key:string)=>session.peekKey(key),has:(key:string)=>session.hasKey(key)};
    const states=input.plannerCandidates.map((candidate,rank)=>{
      if(candidate.from!==input.source.trim().toUpperCase()||candidate.to!==input.destination.trim().toUpperCase()||!candidate.segments.length||candidate.segments[0].boardingDate!==input.journeyDate)throw new Error('Candidate does not match search');
      let station=candidate.from;
      for(const leg of candidate.segments){parseDate(leg.boardingDate);if(leg.fromStation!==station||leg.from!==leg.fromStation||leg.to!==leg.toStation||leg.departureDateTime.slice(0,10)!==new Date(parseDate(leg.boardingDate)*60000).toISOString().slice(0,10))throw new Error('Invalid candidate leg');station=leg.toStation;}
      if(station!==candidate.to)throw new Error('Candidate does not reach destination');
      const allowed=candidate.segments.map(leg=>{const known=input.supportedClassesByTrain?.[leg.trainNumber];return known===undefined?requested:requested.filter(c=>{const allowed=known.map(normalizeClass).includes(c);if(!allowed)session.recordUnsupportedClassSkip(leg.trainNumber,c);return allowed;});});
      return {candidate,rank,allowed,checks:candidate.segments.map(()=>new Map<TravelClass,InventoryCheck>()),started:false,deferred:false};
    });
    type State=typeof states[number];
    const request=(s:State,i:number,c:TravelClass):AvailabilityRequest=>{const leg=s.candidate.segments[i];return{trainNumber:leg.trainNumber,fromStationCode:leg.fromStation,toStationCode:leg.toStation,journeyDate:leg.boardingDate,travelClass:c,quota:'GN'};};
    const hasUsable=(s:State,i:number)=>[...s.checks[i].values()].some(usable);
    const definitiveFailure=(s:State,i:number)=>!hasUsable(s,i)&&s.allowed[i].every(c=>{if(unsupported.get(s.candidate.segments[i].trainNumber)?.has(c))return true;const x=s.checks[i].get(c);return x&&(x.status==='WAITLIST'||x.status==='UNAVAILABLE'||x.errorCategory==='UNSUPPORTED_CLASS');});
    const isUsable=(s:State)=>s.checks.every((_,i)=>hasUsable(s,i));
    const knownUnsupported=(s:State,i:number,c:TravelClass)=>{
      const skipped=unsupported.get(s.candidate.segments[i].trainNumber)?.has(c);
      if(skipped)session.recordUnsupportedClassSkip(s.candidate.segments[i].trainNumber,c);
      return skipped;
    };
    const get=(r:AvailabilityRequest)=>session.get(r);
    const allocation: AllocationDiagnostics = {breadthCandidatesConsidered:0,breadthCandidatesChecked:0,breadthRequests:0,completionCandidatesConsidered:0,completionCandidatesChecked:0,completionRequests:0,deepWideningCandidates:0,deepWideningRequests:0,candidatesDeferredByAtomicCost:0,candidatesDeferredByBreadthLimit:0};
    if (this.options.progressiveAllocation) {
      // Rehydrate exact cached evidence on reserve release, without spending calls.
      for (const s of states) for (const [i, allowed] of s.allowed.entries()) for (const c of configured.flat().filter(c=>allowed.includes(c))) {
        const hit=cache.get(requestKey(request(s,i,c)));
        if(hit)s.checks[i].set(c,hit);
        if(hit&&usable(hit))break;
      }
      const done=(s:State)=>s.checks.every((_,i)=>hasUsable(s,i)||definitiveFailure(s,i));
      const atomicDeferred=new Set<State>();
      const attempt=async(s:State,c:TravelClass)=>{
        const pending=s.checks.map((_,i)=>i).filter(i=>!hasUsable(s,i)&&s.allowed[i].includes(c)&&!knownUnsupported(s,i,c)&&!s.checks[i].has(c));
        const requests=pending.map(i=>request(s,i,c));
        // Atomic unit: one class across ALL pending eligible legs. No partial
        // candidate/class spending when the uncached group cannot fit.
        if(!session.canAfford(requests)){s.deferred=true;atomicDeferred.add(s);d.atomicBudgetDeferrals++;return;}
        if(pending.length&&!s.started){s.started=true;d.candidatesValidationStarted++;}
        for(const i of pending)s.checks[i].set(c,await get(request(s,i,c)));
      };
      const start=budget.callsUsed;
      const breadthChecked=new Set<State>(),completionChecked=new Set<State>(),deepChecked=new Set<State>();
      const maxBreadth={QUICK:3,STANDARD:5,DEEP:7}[mode];
      const firstClass=rounds[0]?.[0];
      const missing=(s:State,classes:TravelClass[])=>session.missingRequests(s.checks.flatMap((_,i)=>hasUsable(s,i)?[]:classes.filter(c=>s.allowed[i].includes(c)&&!knownUnsupported(s,i,c)).map(c=>request(s,i,c))));
      const leader=states.find(s=>!done(s));
      const fullCost=leader?missing(leader,rounds.flat()):0;
      const firstCost=leader&&firstClass?missing(leader,[firstClass]):0;
      // If feasible, retain enough to make the leading candidate definitive.
      // This adapts breadth to multi-leg cost rather than assuming direct trains.
      const completionHold=rounds.length===1?0:fullCost<=session.remaining?fullCost-firstCost:Math.floor(session.remaining/3);
      const breadthAllowance=rounds.length===1?session.remaining:Math.min(Math.ceil(session.remaining*2/3),session.remaining-completionHold);
      const pool:State[]=[];
      let admissionCost=0;
      for(const s of states){
        if(pool.length>=maxBreadth)break;
        allocation.breadthCandidatesConsidered++;
        const cost=firstClass?missing(s,[firstClass]):0;
        if(admissionCost+cost>breadthAllowance)continue;
        pool.push(s);admissionCost+=cost;
      }
      allocation.candidatesDeferredByBreadthLimit=states.length-pool.length;
      await session.withAllowance(breadthAllowance,async()=>{
        for(const c of rounds[0]??[]) for(const s of pool){
          if(states.filter(isUsable).length>=target)break;
          const before=s.checks.reduce((n,x)=>n+x.size,0);
          await attempt(s,c);
          if(s.checks.reduce((n,x)=>n+x.size,0)>before)breadthChecked.add(s);
        }
      });
      allocation.breadthRequests=budget.callsUsed-start;
      const usableLegs=(s:State)=>s.checks.filter((_,i)=>hasUsable(s,i)).length;
      const unresolved=(s:State)=>s.checks.length-usableLegs(s);
      const ordered=[...states].sort((a,b)=>Number(usableLegs(b)>0)-Number(usableLegs(a)>0)||unresolved(a)-unresolved(b)||a.rank-b.rank);
      // A bounded completion lane follows evidence priority, then schedule rank.
      // Finish canonical pending classes for one candidate before moving on.
      for(const s of ordered){
        if(states.filter(isUsable).length>=target)break;
        if(done(s))continue;
        allocation.completionCandidatesConsidered++;
        for(const round of rounds)for(const c of round){
          if(done(s))break;
          const before=budget.callsUsed,checks=s.checks.reduce((n,x)=>n+x.size,0);
          await attempt(s,c);
          const spent=budget.callsUsed-before;
          allocation.completionRequests+=spent;
          if(s.checks.reduce((n,x)=>n+x.size,0)>checks)completionChecked.add(s);
          if(configured[2]?.includes(c)){
            allocation.deepWideningRequests+=spent;
            if(spent)deepChecked.add(s);
          }
        }
      }
      allocation.breadthCandidatesChecked=breadthChecked.size;
      allocation.completionCandidatesChecked=completionChecked.size;
      allocation.deepWideningCandidates=deepChecked.size;
      allocation.candidatesDeferredByAtomicCost=atomicDeferred.size;
    } else {
    let offset=0,batchIndex=0;
    while(offset<states.length&&states.filter(isUsable).length<target){
      const batch=states.slice(offset,offset+batches[Math.min(batchIndex,batches.length-1)]);offset+=batch.length;batchIndex++;d.batchesAttempted++;
      const cumulative:TravelClass[]=[];
      for(const [roundIndex,round] of rounds.entries()){
        if(states.filter(isUsable).length>=target||batch.every(s=>isUsable(s)||(complete?s.checks.every((_,i)=>hasUsable(s,i)||definitiveFailure(s,i)):s.checks.some((_,i)=>definitiveFailure(s,i)))))break;
        cumulative.push(...round);if(!d.classRoundsAttempted.some(r=>r.join()===round.join()))d.classRoundsAttempted.push([...round]);
        for(const s of batch){
          if(states.filter(isUsable).length>=target)break;
          if(isUsable(s)||(complete?s.checks.every((_,i)=>hasUsable(s,i)||definitiveFailure(s,i)):s.checks.some((_,i)=>definitiveFailure(s,i))))continue;
          const pending=s.checks.map((_,i)=>i).filter(i=>!hasUsable(s,i)&&!definitiveFailure(s,i));
          const classes=(i:number)=>{
            const permitted=cumulative.filter(c=>s.allowed[i].includes(c)&&!knownUnsupported(s,i,c));
            // A cached usable class is sufficient; do not reserve fresh calls
            // merely to rediscover a usable shared leg in another class.
            const cached=permitted.filter(c=>{const x=s.checks[i].get(c)??cache.get(requestKey(request(s,i,c)));return x&&usable(x);});
            return cached.length?cached:permitted;
          };
          if(pending.some(i=>!classes(i).length))continue; // This train needs a later round.
          const needed=new Set<string>();
          for(const i of pending)for(const c of classes(i))if(!s.checks[i].has(c)&&!cache.has(requestKey(request(s,i,c))))needed.add(requestKey(request(s,i,c)));
          // Conservative reservation covers every uncached check in this round,
          // not just its minimum one-per-leg. Early exits release unused capacity.
          if(needed.size>limit-budget.callsUsed||(roundIndex>0&&offset<states.length&&budget.callsUsed+needed.size>Math.ceil(limit/2))){s.deferred=true;d.atomicBudgetDeferrals++;continue;}
          if(!s.started){s.started=true;d.candidatesValidationStarted++;}
          // Known poor inventory first, then fewer class alternatives, then longer
          // reserved distance. Original index is the deterministic final tie-break.
          const poor=(i:number)=>classes(i).some(c=>{const x=s.checks[i].get(c)??cache.get(requestKey(request(s,i,c)));return x&&!usable(x);})?1:0;
          pending.sort((a,b)=>poor(b)-poor(a)||s.allowed[a].length-s.allowed[b].length||s.candidate.segments[b].distanceKm-s.candidate.segments[a].distanceKm||a-b);
          for(let position=0;position<pending.length;position++){
            const i=pending[position];
            for(const c of classes(i)){
              if(!s.checks[i].has(c))s.checks[i].set(c,await get(request(s,i,c)));
              if(s.checks[i].get(c)!.status==='AVAILABLE'||(complete&&usable(s.checks[i].get(c)!)))break;
            }
            if(!hasUsable(s,i)){if(!complete){if(position<pending.length-1)d.bottleneckEarlyExits++;break;}}
          }
        }
      }
    }
    }
    const journeys:ValidatedJourney[]=states.map(s=>{
      const chosen=chooseClasses(s.checks.map(c=>[...c.values()]));
      const blocked=s.checks.some((_,i)=>definitiveFailure(s,i));
      const status=chosen?'FULLY_RESERVED_USABLE':blocked?'SCHEDULED_BUT_NOT_FULLY_AVAILABLE':'INVENTORY_CHECK_INCOMPLETE';
      if(s.checks.every((_,i)=>hasUsable(s,i)||definitiveFailure(s,i)))d.candidatesFullyValidated++;
      if(blocked&&!chosen)d.candidatesRejectedByInventory++;
      if(s.deferred&&!chosen)d.candidatesDeferredByBudget++;
      const priority={AVAILABLE:0,RAC:1,WAITLIST:2,UNAVAILABLE:3,UNSUPPORTED_CLASS:4,PROVIDER_ERROR:5};
      const legs=s.candidate.segments.map((leg,i)=>{
        const check=chosen?.[i]??[...s.checks[i].values()].sort((a,b)=>priority[a.status]-priority[b.status]||requested.indexOf(a.travelClass)-requested.indexOf(b.travelClass))[0];
        return{trainNumber:leg.trainNumber,fromStation:leg.fromStation,toStation:leg.toStation,boardingDate:leg.boardingDate,departureDateTime:leg.departureDateTime,arrivalDateTime:leg.arrivalDateTime,distanceKm:leg.distanceKm,selectedClass:check?.travelClass??null,quota:'GN' as const,availabilityStatus:check?.status??null,availabilityText:check?.availabilityText,fare:check?.fare,checks:[...s.checks[i].values()]};
      });
      const known=legs.filter(l=>l.fare),subtotal=known.reduce((n,l)=>n+l.fare!.totalFare,0);
      return{scheduleCandidateId:createHash('sha256').update(journeyIdentity(s.candidate)).digest('hex'),status,scheduleCandidate:s.candidate,legs,availableLegCount:legs.filter(l=>l.availabilityStatus==='AVAILABLE').length,racLegCount:legs.filter(l=>l.availabilityStatus==='RAC').length,waitlistedLegCount:legs.filter(l=>l.availabilityStatus==='WAITLIST').length,classChanges:chosen?classChanges(chosen):legs.reduce((n,l,i)=>n+Number(i>0&&l.selectedClass!==null&&legs[i-1].selectedClass!==null&&l.selectedClass!==legs[i-1].selectedClass),0),trainChanges:s.candidate.changes,totalDurationMinutes:s.candidate.durationMinutes,totalDistanceKm:s.candidate.totalDistanceKm,detourPercent:s.candidate.distanceDetourPercent,totalFare:{status:known.length===legs.length?'COMPLETE':known.length?'PARTIAL':'UNKNOWN',amount:known.length===legs.length?subtotal:null,knownSubtotal:subtotal,knownLegCount:known.length,currency:'INR'},scheduleRank:s.rank+1,finalRank:0} satisfies ValidatedJourney;
    });
    journeys.sort(rankValidated);journeys.forEach((j,i)=>j.finalRank=i+1);
    d.usableJourneysFound=journeys.filter(j=>j.status==='FULLY_RESERVED_USABLE').length;d.fallbackJourneysReturned=journeys.length-d.usableJourneysFound;Object.assign(d,session.statistics());
    return{journeys,diagnostics:d,allocationDiagnostics:allocation,plannerDiagnostics:input.plannerDiagnostics,message:d.usableJourneysFound?'Inventory validation completed; results do not guarantee booking.':journeys.length?'Scheduled routes retained. Live reserved inventory could not be confirmed.':'No local schedule candidates were generated; no inventory requests were made.'};
  }
}
