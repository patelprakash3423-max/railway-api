import type { TrainCandidate } from '../domain/types/train-search.js';
import type { ConnectionSearchRequest } from '../journey/connection/types.js';
import type { ConnectionProviderSession } from '../journey/connection/provider-session.js';
import { candidateClasses, selectTrains, timedRun } from '../journey/connection/candidates.js';
import { connectionSafety, departureDates, type ConnectionTimeConfig, type ScheduledRun } from '../journey/connection/timing.js';
import { multiDiagnostics, type MultiConfig, type PartialJourneyPath, type MultiTrainJourneyCandidate } from '../domain/planner/types.js';
import { bestPossibleScore, pathScore, retainBeam } from '../domain/planner/ranking.js';
import type { ReservedTrainSegment } from '../domain/recovery/types.js';
export async function multiInterchangeSearch(request:ConnectionSearchRequest,seeds:TrainCandidate[],session:ConnectionProviderSession,config:MultiConfig,times:ConnectionTimeConfig) {
 const d=multiDiagnostics();d.multiInterchangeActivated=true;const results:MultiTrainJourneyCandidate[]=[];
 if(Object.entries(config).some(([k,v])=>k!=='deep'&&(typeof v!=='number'||!Number.isFinite(v)||v<=0||v>100)) || ['beamWidth','trainsPerStation','availability','discovery','trainInfo'].some(k=>!Number.isSafeInteger(config[k as keyof MultiConfig]))) throw new Error('Invalid multi limits');
 const caps={availability:Math.min(session.budget.config.maxAvailabilityCalls,session.budget.used.availability+config.availability),discovery:Math.min(session.budget.config.maxTrainDiscoveryCalls,session.budget.used.discovery+config.discovery),info:Math.min(session.budget.config.maxTrainInfoCalls,session.budget.used.info+config.trainInfo)};
 const beforeHits=()=>session.diagnostics.availabilityCacheHits+session.diagnostics.trainDiscoveryCacheHits+session.diagnostics.trainInfoCacheHits;
 const startHits=beforeHits();
 // One observed ordered corridor supplies progress references, never fabricated connectivity.
 let stations:{code:string;progress:number}[]=[];let reference:number|undefined;
 for(const seed of seeds) {
  const info=await session.info(seed.trainNumber,caps.info);if(!info)continue;
  const a=info.route.findIndex(s=>s.stationCode===request.fromStationCode),z=info.route.findIndex(s=>s.stationCode===request.toStationCode);
  if(a<0||z-a<3)continue;
  const route=info.route.slice(a,z+1);if(new Set(route.map(s=>s.stationCode)).size!==route.length)continue;
  const reliable=route.every((s,i)=>Number.isFinite(s.distanceKm)&&s.distanceKm>=0&&(!i||s.distanceKm>route[i-1].distanceKm));
  reference=reliable?route.at(-1)!.distanceKm-route[0].distanceKm:undefined;
  stations=route.map((s,i)=>({code:s.stationCode,progress:reference?(s.distanceKm-route[0].distanceKm)/reference:i/(route.length-1)}));break;
 }
 const finish=()=>{d.multiInterchangeCacheHits=beforeHits()-startHits;return {candidates:results.sort((a,b)=>b.score-a.score||JSON.stringify(a.segments).localeCompare(JSON.stringify(b.segments))),diagnostics:d};};
 if(!stations.length)return finish();
 // A finite corridor shortlist, sampled evenly to retain early and late interchange choices.
 const interior=stations.slice(1,-1);const limit=Math.min(interior.length,config.beamWidth);
 const targets=Array.from({length:limit},(_,i)=>interior[Math.floor(i*(interior.length-1)/Math.max(1,limit-1))]);
 let beam:PartialJourneyPath[]=[{runs:[],visitedStations:new Set([request.fromStationCode]),visitedTrains:new Set(),progress:0,score:0,distance:0}];
 const accepted=new Set<string>();
 for(let depth=1;depth<=3;depth++) {
  const next:PartialJourneyPath[]=[];
  for(const path of beam) {
   if(results.length&&bestPossibleScore(path,times)<Math.max(...results.map(r=>r.score))){d.multiInterchangeUpperBoundPruned++;continue;}
   d.multiInterchangePathsExpanded++;
   const source=path.runs.at(-1)?.train.toStationCode??request.fromStationCode;
   const onward=depth===3?[stations.at(-1)!]:targets.filter(t=>t.progress>path.progress&& (depth!==1||t.progress<targets.at(-1)!.progress));
   for(const target of onward) {
    if(path.visitedStations.has(target.code)||target.code===source){d.multiInterchangeLoopPruned++;continue;}
    const dates=path.runs.length?departureDates(path.runs.at(-1)!.arrival,times):[request.journeyDate];
    let retainedTrains=0;
    for(const date of dates) {
     if(retainedTrains>=config.trainsPerStation)break;
     const query={fromStationCode:source,toStationCode:target.code,journeyDate:date};
     const discovery=await session.discover(query,caps.discovery);
     const timed:ScheduledRun[]=[];
     for(const train of selectTrains(discovery,query,request.classes,config.trainsPerStation)) {
      if(path.visitedTrains.has(`${train.trainNumber}:${date}`)){d.multiInterchangeLoopPruned++;continue;}
      const run=await timedRun(train,date,session,caps.info);
      // The normalized adapter does not document runningDays encoding; dated discovery is authoritative.
      if(!run||(path.runs.length&&!connectionSafety(run.departure-path.runs.at(-1)!.arrival,times))){d.multiInterchangeTimingPruned++;continue;}
      timed.push(run);
     }
     for(const run of timed.slice(0,config.trainsPerStation-retainedTrains)) {
      retainedTrains++;
      const km=run.train.distanceKm;
      const distance=path.distance!==undefined&&km!==undefined&&Number.isFinite(km)&&km>0?path.distance+km:undefined;
      if(reference&&distance!==undefined&&distance/reference>config.detour){d.multiInterchangeDetourPruned++;continue;}
      const p:PartialJourneyPath={runs:[...path.runs,run],visitedStations:new Set([...path.visitedStations,target.code]),visitedTrains:new Set([...path.visitedTrains,`${run.train.trainNumber}:${date}`]),progress:target.progress,distance,score:1000*target.progress-((run.arrival-(path.runs[0]?.departure??run.departure))/1440)*20};
      d.multiInterchangePartialPathsGenerated++;
      if(depth<3){next.push(p);continue;}
      if(results.length&&bestPossibleScore(p,times)<Math.max(...results.map(r=>r.score))){d.multiInterchangeUpperBoundPruned++;continue;}
      const segments:ReservedTrainSegment[]=new Array(3);let viable=true;
      // Check the most class-constrained edge first; later edges win ties. No classes^3 product.
      const order=p.runs.map((r,index)=>({r,index})).sort((a,b)=>candidateClasses(a.r.train,request.classes).length-candidateClasses(b.r.train,request.classes).length||b.index-a.index);
      const pending = order.map(({r})=>({trainNumber:r.train.trainNumber,fromStationCode:r.train.fromStationCode,toStationCode:r.train.toStationCode,journeyDate:r.boardingDate,travelClass:candidateClasses(r.train,request.classes)[0],quota:request.quota}));
      if (session.orchestrator && !session.canValidate('multiInterchange', pending, 0, caps.availability - session.diagnostics.availabilityCalls)) continue;
      const attemptBefore = session.diagnostics.availabilityCalls + session.diagnostics.availabilityCacheHits;
      for(const {r,index} of order) {
       let selected:ReservedTrainSegment|undefined;
       for(const classCode of candidateClasses(r.train,request.classes)) {
        const current = {trainNumber:r.train.trainNumber,fromStationCode:r.train.fromStationCode,toStationCode:r.train.toStationCode,journeyDate:r.boardingDate,travelClass:classCode,quota:request.quota};
        if (session.orchestrator && !session.canValidate('multiInterchange', [current, ...pending.slice(1)], 0, caps.availability - session.diagnostics.availabilityCalls)) break;
        const used=session.diagnostics.availabilityCalls;
        const availability=await session.availability({trainNumber:r.train.trainNumber,fromStationCode:r.train.fromStationCode,toStationCode:r.train.toStationCode,journeyDate:r.boardingDate,travelClass:classCode,quota:request.quota},false,{directLimit:0,stationLimit:0,multiLimit:caps.availability});
        d.multiInterchangeAvailabilityChecks+=session.diagnostics.availabilityCalls-used;
        if(availability?.providerState!=='SUCCESS')continue;
        const days=availability.days.filter(s=>s.date===r.boardingDate);if(days.length!==1)continue;const day=days[0];
        if((day.state!=='AVAILABLE'&&day.state!=='RAC')||day.canBook===false)continue;
        const fare=availability.fare?.totalFare;
        if (selected && day.state === 'RAC') continue;
        selected={type:'RESERVED_TRAIN',trainNumber:r.train.trainNumber,trainName:r.train.trainName,from:{code:r.train.fromStationCode},to:{code:r.train.toStationCode},journeyDate:r.boardingDate,classCode,quota:'GN',availability:day.state,fare:fare!==undefined&&Number.isFinite(fare)&&fare>=0?fare:undefined};
        if(day.state==='AVAILABLE')break;
       }
       pending.shift();
       if(!selected){viable=false;break;}segments[index]=selected;
      }
      if (session.diagnostics.availabilityCalls + session.diagnostics.availabilityCacheHits > attemptBefore) session.orchestrator?.markMeaningfulAttempt('multiInterchange');
      if(!viable)continue;
      const key=JSON.stringify(segments.map(s=>[s.trainNumber,s.from.code,s.to.code,s.journeyDate,s.classCode]));if(accepted.has(key))continue;accepted.add(key);
      const connections=p.runs.slice(1).map((r,i)=>({station:{code:r.train.fromStationCode},minutes:r.departure-p.runs[i].arrival,safety:connectionSafety(r.departure-p.runs[i].arrival,times)!}));
      const allAvailable=segments.every(s=>s.availability==='AVAILABLE'),allGood=connections.every(c=>c.safety==='GOOD');
      const c:MultiTrainJourneyCandidate={type:'MULTI_TRAIN_JOURNEY',requestedFrom:{code:request.fromStationCode},requestedTo:{code:request.toStationCode},segments,reservedCoverage:{ratio:1,percentage:100,method:reference&&distance!==undefined?'DISTANCE':'ROUTE_SPAN'},reservedSegmentCount:3,trainChangeCount:2,classChangeCount:segments.slice(1).filter((s,i)=>s.classCode!==segments[i].classCode).length,totalReservedFare:segments.every(s=>s.fare!==undefined)?segments.reduce((n,s)=>n+s.fare!,0):undefined,totalScheduledDurationMinutes:run.arrival-p.runs[0].departure,connectionCount:2,connections,score:0,quality:allAvailable&&allGood?'EXCELLENT':allAvailable?'STRONG':'USEFUL',warnings:['MULTIPLE_TRAIN_CHANGES',...(!allAvailable?['RAC_NOT_CONFIRMED_BERTH']:[]),...(connections.some(c=>c.safety==='TIGHT')?['TIGHT_CONNECTION']:[]),...(connections.some(c=>c.safety==='LONG')?['LONG_CONNECTION']:[])],explanation:'Fully reserved travel with two train changes. Separate reservations are needed; timetable connections are not guaranteed against delays.'};
      c.score=pathScore(c,request.classes,reference&&distance!==undefined?distance/reference:1);results.push(c);d.multiInterchangeCompletedPaths++;
      if(allAvailable&&allGood){d.multiInterchangeStrongStopCount++;return finish();}
      if(results.length>=config.beamWidth)return finish();
     }
    }
   }
  }
  beam=retainBeam(next,config.beamWidth,d);if(!beam.length)break;
 }
 return finish();
}
