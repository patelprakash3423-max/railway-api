import { RailwayDatabase } from '../../../local-railway/database.js';
import { networkFor,eventMinute } from '../../../local-railway/planner/v2/network.js';
import { runsOnDate } from '../../../local-railway/calendar.js';
import { formatDate,parseDate } from '../../connection/timing.js';
import { travelClasses,type TravelClass } from '../../types/journey-segment.js';
import type { AvailabilityRequest } from '../../../domain/types/availability.js';
import { AvailabilitySession } from '../session.js';
import { requestKey,usable } from '../inventory.js';
import type { InventoryCheck } from '../types.js';
import { intervalPaths,rankRecovery,type IntervalEdge,type Path } from './paths.js';
import { defaultRecoveryLimits,type RecoveryInput,type RecoveryLimits,type RecoveryDiagnostics,type RecoveryResult,type RecoverySolution,type ReservedSegment } from './types.js';
const datetime=(minutes:number)=>new Date(minutes*60000).toISOString().slice(0,16)+':00+05:30';
function wallTime(value:string):number{if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+05:30$/.test(value))throw new Error('Use railway timestamps with +05:30');const m=Date.parse(value)/60000+330;if(!Number.isFinite(m)||datetime(m)!==value)throw new Error('Invalid timestamp');parseDate(formatDate(m));return m;}
const classRounds:TravelClass[][]=[['SL','3A'],['2A','CC','2S'],['1A','EC','3E']];
export interface DeferredRecoveryWork { requests: AvailabilityRequest[][] }
/** Recovery never owns a provider or creates a second budget. Pass the SAME
 * AvailabilitySession used for whole-leg validation. Call sequentially per request. */
export async function recoverSingleTrainLeg(database:RailwayDatabase,session:AvailabilitySession,input:RecoveryInput,options:Partial<RecoveryLimits>={},deferred?:DeferredRecoveryWork,strategy:{progressiveStations?:boolean}={}):Promise<RecoveryResult>{
  const limits={...defaultRecoveryLimits,...options};
  for(const [key,value]of Object.entries(limits))if(!Number.isFinite(value)||(key==='minimumReservedCoverageRatio'?value<=0||value>1:!Number.isSafeInteger(value)||value<1||value>1000))throw new Error(`Invalid recovery limit ${key}`);
  if(input.quota!==undefined&&input.quota!=='GN')throw new Error('Only GN quota supported');
  if(!/^\d{1,5}$/.test(input.trainNumber)||!Number.isFinite(input.distanceKm)||input.distanceKm<=0)throw new Error('Invalid requested train/distance');
  const trainNumber=input.trainNumber.padStart(5,'0'),start=wallTime(input.boardingDateTime),finish=wallTime(input.arrivalDateTime);
  if(finish<=start)throw new Error('Invalid requested chronology');
  const raw=input.requestedClasses.map(c=>c.trim().toUpperCase());if(!raw.length||raw.some(c=>c!=='ALL'&&!travelClasses.includes(c as TravelClass))||(raw.includes('ALL')&&raw.length!==1))throw new Error('Invalid classes');
  const requested=(raw.includes('ALL')?[...travelClasses]:[...new Set(raw)] as TravelClass[]).filter(c=>input.supportedClasses===undefined||input.supportedClasses.map(x=>x.trim().toUpperCase()).includes(c));
  const before=session.statistics();
  // Capture local route/metrics in a short read transaction, never across provider awaits.
  database.db.exec('BEGIN');let net:ReturnType<typeof networkFor>;
  try{net=networkFor(database);database.db.exec('COMMIT');}catch(error){database.db.exec('ROLLBACK');throw error;}
  const route=net.routes.get(trainNumber);if(!route)throw new Error('Train missing from local dataset');
  const matches:{begin:number;end:number;origin:number}[]=[];
  for(let i=0;i<route.length;i++)if(route[i].stationCode===input.fromStation&&route[i].departureTime){const origin=start-eventMinute(route[i],false);if(origin%1440!==0)continue;for(let j=i+1;j<route.length;j++)if(route[j].stationCode===input.toStation&&route[j].arrivalTime&&origin+eventMinute(route[j],true)===finish)matches.push({begin:i,end:j,origin});}
  if(matches.length!==1)throw new Error('Requested leg does not match one unambiguous local schedule');
  const {begin,end,origin}=matches[0],stops=route.slice(begin,end+1),first=stops[0],last=stops.at(-1)!;
  if(first.distanceKm===undefined||last.distanceKm===undefined||Math.abs(last.distanceKm-first.distanceKm-input.distanceKm)>1e-6)throw new Error('Known local endpoint distances must match requested distance');
  if(!runsOnDate(net.trains.get(trainNumber)!,formatDate(origin)))throw new Error('Train does not operate on its origin date');
  const codes=new Set<string>();let previous=start,previousDistance=first.distanceKm;
  for(let i=0;i<stops.length;i++){const s=stops[i];if(codes.has(s.stationCode))throw new Error('Repeated station in requested route');codes.add(s.stationCode);if(i&&s.sequence!==stops[i-1].sequence+1)throw new Error('Noncontiguous route');for(const arrival of [true,false]){if((i===0&&arrival)||(i===stops.length-1&&!arrival))continue;const time=origin+eventMinute(s,arrival);if(!Number.isFinite(time)||time<previous)throw new Error('Invalid local chronology');previous=time;}if(s.distanceKm!==undefined){if(s.distanceKm<previousDistance)throw new Error('Backwards local distance');previousDistance=s.distanceKm;}}
  const d:RecoveryDiagnostics={trainStopsConsidered:stops.length,candidateIntervalsGenerated:0,intervalsPruned:0,splitPointsConsidered:0,splitPointsByTier:{MAJOR:0,MEDIUM:0,SMALL:0},availabilityRequestsUsed:0,availabilityCacheHits:0,budgetRemaining:session.remaining,intervalsAvailable:0,intervalsRac:0,intervalsWaitlist:0,providerErrors:0,fullCoverageSolutions:0,partialCoverageSolutions:0,bestReservedCoverageRatio:0,bestClassChanges:0,selfManagedDistanceKm:input.distanceKm,searchRoundsAttempted:[],truncated:false,truncationReasons:[],atomicIntervalDeferrals:0,missingDistanceStopsSkipped:0,statesPruned:0,minimumReservedCoverageRatio:limits.minimumReservedCoverageRatio};
  const truncate=(reason:string)=>{d.truncated=true;if(!d.truncationReasons.includes(reason))d.truncationReasons.push(reason);};
  const split=stops.slice(1,-1).filter(s=>{if(s.distanceKm===undefined){d.missingDistanceStopsSkipped++;return false;}return s.distanceKm>first.distanceKm!&&s.distanceKm<last.distanceKm!;});
  d.splitPointsConsidered=split.length;
  const score=(s:typeof first)=>{const ratio=(s.distanceKm!-first.distanceKm!)/input.distanceKm;return({MAJOR:40,MEDIUM:20,SMALL:0}[net.metrics.get(s.stationCode)!.tier])+50*(1-Math.abs(.5-ratio)*2)+Math.min(30,eventMinute(s,false)-eventMinute(s,true));};
  split.sort((a,b)=>score(b)-score(a)||a.sequence-b.sequence);
  if(!strategy.progressiveStations&&split.length>limits.maxSplitPoints){truncate('splitPoints');d.intervalsPruned+=split.length-limits.maxSplitPoints;}
  const selected=strategy.progressiveStations?split:split.slice(0,limits.maxSplitPoints);for(const s of selected)d.splitPointsByTier[net.metrics.get(s.stationCode)!.tier]++;
  if(d.missingDistanceStopsSkipped)truncate('missingDistanceSplits');
  const nodes=[first,...selected,last].sort((a,b)=>a.sequence-b.sequence),nodePosition=new Map(nodes.map((s,i)=>[s.sequence,i]));
  interface Interval{a:number;b:number;checks:Map<TravelClass,InventoryCheck>}
  const intervals=new Map<string,Interval>();
  const add=(a:number,b:number)=>{const key=`${a}:${b}`,found=intervals.get(key);if(found)return found;if(!strategy.progressiveStations&&intervals.size>=limits.maxIntervals){d.intervalsPruned++;truncate('intervals');return undefined;}const item={a,b,checks:new Map<TravelClass,InventoryCheck>()};intervals.set(key,item);return item;};
  const full=add(0,nodes.length-1)!;
  const anchored:Interval[][]=[],splits:Interval[][]=[],broader:Interval[][]=[];
  if(!strategy.progressiveStations){
  selected.forEach((s,i)=>{const k=nodePosition.get(s.sequence)!;const pair=[add(0,k),add(k,nodes.length-1)].filter((x):x is Interval=>!!x);if(pair.length)(i<2?anchored:splits).push(pair);});
  // Enumerate pairs only among capped split points, never all raw route stops.
  for(let i=1;i<nodes.length-2;i++){const item=add(i,i+1);if(item)splits.push([item]);}
  const inner:{a:number;b:number}[]=[];for(let a=1;a<nodes.length-1;a++)for(let b=a+2;b<nodes.length-1;b++)inner.push({a,b});inner.sort((x,y)=>(nodes[y.b].distanceKm!-nodes[y.a].distanceKm!)-(nodes[x.b].distanceKm!-nodes[x.a].distanceKm!)||x.a-y.a||x.b-y.b);for(const pair of inner){const item=add(pair.a,pair.b);if(item)broader.push([item]);}
  }
  d.candidateIntervalsGenerated=intervals.size;
  const checks:RecoveryResult['checks']=[];
  const request=(v:Interval,c:TravelClass):AvailabilityRequest=>({trainNumber,fromStationCode:nodes[v.a].stationCode,toStationCode:nodes[v.b].stationCode,journeyDate:formatDate(origin+eventMinute(nodes[v.a],false)),travelClass:c,quota:'GN'});
  const edges=():IntervalEdge[]=>[...intervals.values()].flatMap(v=>[...v.checks.values()].filter(usable).map(check=>{const dep=datetime(origin+eventMinute(nodes[v.a],false)),arr=datetime(origin+eventMinute(nodes[v.b],true)),distance=nodes[v.b].distanceKm!-nodes[v.a].distanceKm!,status=check.status as 'AVAILABLE'|'RAC';const segment:ReservedSegment={type:'RESERVED',trainNumber,fromStation:nodes[v.a].stationCode,toStation:nodes[v.b].stationCode,departureDateTime:dep,arrivalDateTime:arr,selectedClass:check.travelClass,quota:'GN',availabilityStatus:status,availabilityText:check.availabilityText,distanceKm:distance,fare:check.fare,reservationParts:[{fromStation:nodes[v.a].stationCode,toStation:nodes[v.b].stationCode,departureDateTime:dep,arrivalDateTime:arr,boardingDate:request(v,check.travelClass).journeyDate,distanceKm:distance,availabilityStatus:status,availabilityText:check.availabilityText,fare:check.fare}]};return{from:v.a,to:v.b,segment};}));
  const paths=()=>intervalPaths(nodes.map(s=>({code:s.stationCode,distance:s.distanceKm!})),edges(),limits.maxStatesPerNode,n=>{d.statesPruned+=n;truncate('pathStates');});
  const fullFound=()=>paths().some(p=>p.segments.length>0&&p.segments.every(s=>s.type==='RESERVED'));
  // Observe existing exclusions only; interval eligibility/order is unchanged.
  const knownUnsupported=(c:TravelClass)=>{
    const skipped=session.unsupported.get(trainNumber)?.has(c);
    if(skipped)session.recordUnsupportedClassSkip(trainNumber,c);
    return skipped;
  };
  const deferredGroups:{group:Interval[];classes:TravelClass[]}[]=[];
  const evaluate=async(group:Interval[],classes:TravelClass[])=>{
    session.assertActive();
    const pending=group.filter(v=>![...v.checks.values()].some(usable));
    const plan=pending.map(v=>{const cached=requested.filter(c=>{const x=session.peekKey(requestKey(request(v,c)));return x&&usable(x);});return{v,classes:(cached.length?cached:classes).filter(c=>!v.checks.has(c)&&!knownUnsupported(c))};});
    const requests=plan.flatMap(p=>p.classes.map(c=>request(p.v,c)));
    if(!session.canAfford(requests)){deferredGroups.push({group,classes});d.atomicIntervalDeferrals++;truncate('availabilityBudget');return false;}
    // Largest coverage block first; a cache-known poor block wins a length tie.
    plan.sort((x,y)=>(nodes[y.v.b].distanceKm!-nodes[y.v.a].distanceKm!)-(nodes[x.v.b].distanceKm!-nodes[x.v.a].distanceKm!)||x.v.a-y.v.a||x.v.b-y.v.b);
    for(const {v,classes:availableClasses} of plan)for(const c of availableClasses){
      if(knownUnsupported(c))continue;
      const r=request(v,c),check=await session.get(r);v.checks.set(c,check);checks.push({fromStation:r.fromStationCode,toStation:r.toStationCode,boardingDate:r.journeyDate,check});
      if(check.status==='AVAILABLE')d.intervalsAvailable++;else if(check.status==='RAC')d.intervalsRac++;else if(check.status==='WAITLIST')d.intervalsWaitlist++;else if(check.status==='PROVIDER_ERROR')d.providerErrors++;
      if(check.status==='AVAILABLE')break;
    }
    return true;
  };
  const rounds=classRounds.map(r=>r.filter(c=>requested.includes(c))).filter(r=>r.length);
  const stages:[string,Interval[][]][]=[['FULL',[[full]]],['ANCHORED',anchored],['SPLIT_POINTS',splits],['BROADER',broader]];
  if(strategy.progressiveStations){
    const considered=new Set<number>();let stationRounds=0,stopped=false;
    // All route nodes remain eligible. Intervals are generated on demand,
    // bounded by admitted checks plus the first deferred atomic group.
    const focusGaps=async()=>{
      const best=paths().sort((a,b)=>b.reserved-a.reserved||a.changes-b.changes)[0];
      if(!best||best.reserved===0)return true;
      for(const gap of best.segments.filter(s=>s.type==='SELF_MANAGED')){
        const a=nodes.findIndex(n=>n.stationCode===gap.fromStation),b=nodes.findIndex(n=>n.stationCode===gap.toStation);
        const interval=add(a,b)!;
        for(const classes of rounds){
          if(!await evaluate([interval],classes))return false;
          if(fullFound())return true;
        }
        // Sample inside the gap before returning to overlapping endpoint pairs.
        // Two stations per turn rotate the starting class round. Later passes
        // cover every requested round, without permanently excluding stations.
        const inner=selected.filter(s=>{const k=nodePosition.get(s.sequence)!;return k>a&&k<b;});
        for(let pass=0;pass<rounds.length;pass++)for(let offset=0;offset<inner.length;offset+=2){
          const classes=rounds[(offset/2+pass)%rounds.length];
          for(const stop of inner.slice(offset,offset+2)){
            const k=nodePosition.get(stop.sequence)!;
            // Anchor at the uncovered journey endpoint; internal gaps use
            // their left boundary. Generate only one interval on demand.
            const part=b===nodes.length-1?add(k,b)!:add(a,k)!;
            // A subinterval is independently useful: admit one class at a
            // time instead of requiring budget for an entire class round.
            // Endpoint pairs elsewhere retain their atomic admission rule.
            for(const travelClass of classes){
              if(!await evaluate([part],[travelClass]))return false;
              considered.add(k);
            }
            if(fullFound())return true;
          }
        }
      }
      return true;
    };
    for(const classes of rounds){if(!await evaluate([full],classes)){stopped=true;break;}if(fullFound())break;}
    if(!fullFound()&&!stopped)stationLoop:for(let offset=0;offset<selected.length;offset+=limits.maxSplitPoints){
      const batch=selected.slice(offset,offset+limits.maxSplitPoints);let entered=false;
      for(const classes of rounds)for(const stop of batch){
        session.assertActive();
        const k=nodePosition.get(stop.sequence)!;
        const pair=[add(0,k)!,add(k,nodes.length-1)!];
        if(!await evaluate(pair,classes)){stopped=true;break stationLoop;}
        considered.add(k);if(!entered){entered=true;stationRounds++;}
        if(fullFound())break stationLoop;
        if(!await focusGaps()){stopped=true;break stationLoop;}
        if(fullFound())break stationLoop;
      }
    }
    d.candidateIntervalsGenerated=intervals.size;
    d.progressive={stationsEligible:selected.length,stationsConsidered:considered.size,stationsRemaining:selected.length-considered.size,stationRoundsAttempted:stationRounds,complete:!stopped&&!d.providerErrors&&!d.truncationReasons.some(r=>r==='pathStates'||r==='missingDistanceSplits')};
  }else{
  outer:for(let round=0;round<rounds.length;round++)for(const [name,groups]of stages){
    if(!groups.length)continue;d.searchRoundsAttempted.push(`${name}:${rounds[round].join('+')}`);
    for(const group of groups){await evaluate(group,rounds[round]);if(fullFound())break outer;}
  }
  }
  // Keep only unresolved atomic work; later groups may have supplied evidence.
  if(deferred)deferred.requests=fullFound()?[]:deferredGroups.map(({group,classes})=>
    group.filter(v=>![...v.checks.values()].some(usable)).flatMap(v=>
      classes.filter(c=>!v.checks.has(c)&&!knownUnsupported(c)).map(c=>request(v,c))
    )).filter(requests=>requests.length>0);
  const after=session.statistics();d.availabilityRequestsUsed=after.availabilityRequestsUsed-before.availabilityRequestsUsed;d.availabilityCacheHits=after.availabilityCacheHits-before.availabilityCacheHits;d.budgetRemaining=session.remaining;
  const toSolution=(p:Path):RecoverySolution=>{
    const ratio=p.reserved/input.distanceKm,full=p.segments.length>0&&p.segments.every(s=>s.type==='RESERVED'),reserved=p.segments.filter((s):s is ReservedSegment=>s.type==='RESERVED');
    const status=full?(p.changes?'FULL_RESERVED_SPLIT_CLASS':'FULL_RESERVED_SINGLE_CLASS'):p.reserved+1e-9>=limits.minimumReservedCoverageRatio*input.distanceKm&&reserved.length?'PARTIAL_RESERVED_RECOVERY':d.truncated||d.providerErrors?'INVENTORY_CHECK_INCOMPLETE':'NO_USABLE_RECOVERY';
    return{trainNumber,requestedFrom:input.fromStation,requestedTo:input.toStation,requestedDistanceKm:input.distanceKm,recoveryStatus:status,segments:p.segments,reservedDistanceKm:p.reserved,selfManagedDistanceKm:input.distanceKm-p.reserved,reservedCoverageRatio:ratio,reservedSegmentCount:reserved.length,classChanges:p.changes,trainChanges:0,availableSegmentCount:reserved.filter(s=>s.availabilityStatus==='AVAILABLE').length,racSegmentCount:reserved.filter(s=>s.availabilityStatus==='RAC').length,waitlistChecks:d.intervalsWaitlist,totalKnownFare:p.knownFare,fareComplete:full&&reserved.length>0&&p.missingFares===0,availabilityRequestsUsed:d.availabilityRequestsUsed,cacheHits:d.availabilityCacheHits};
  };
  const ranked=paths().map(toSolution).sort(rankRecovery),eligible=ranked.filter(p=>['FULL_RESERVED_SINGLE_CLASS','FULL_RESERVED_SPLIT_CLASS','PARTIAL_RESERVED_RECOVERY'].includes(p.recoveryStatus));
  d.fullCoverageSolutions=eligible.filter(p=>p.recoveryStatus==='FULL_RESERVED_SINGLE_CLASS'||p.recoveryStatus==='FULL_RESERVED_SPLIT_CLASS').length;d.partialCoverageSolutions=eligible.length-d.fullCoverageSolutions;
  if(eligible.length>limits.maxResults)truncate('results');const best=ranked[0];d.bestReservedCoverageRatio=best.reservedCoverageRatio;d.bestClassChanges=best.classChanges;d.selfManagedDistanceKm=best.selfManagedDistanceKm;
  return{best,solutions:eligible.slice(0,limits.maxResults),diagnostics:d,checks};
}
