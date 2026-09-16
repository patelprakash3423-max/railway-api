import { connectionTimes, connectionSafety, type ConnectionTimeConfig } from '../../journey/connection/timing.js';
import type { JourneyResult } from '../../journey/types/journey-result.js';
import type { JourneyRecoveryCandidate } from '../recovery/types.js';
import type { MultiTrainJourneyCandidate, PartialJourneyPath, MultiDiagnostics } from './types.js';
export const PATH_WEIGHTS = { coverage:1000, available:200, rac:120, good:80, long:20, tight:-40, twoChanges:180, duration:100, detour:100, class:50, fare:10 };
export function shouldRunMultiInterchangeSearch(results: JourneyResult[], recovery: JourneyRecoveryCandidate[], deep=false):boolean {
 if(deep) return true;
 return !results.some(r=>r.segments.every(s=>s.availabilityState==='AVAILABLE') && (r.type!=='DIFFERENT_TRAIN_CONNECTION'||r.connectionSafety==='GOOD')) &&
   !recovery.some(r=>r.quality==='EXCELLENT');
}
export function pathScore(c:MultiTrainJourneyCandidate,classes:readonly string[],detour=1):number {
 const w=PATH_WEIGHTS;
 return w.coverage*c.reservedCoverage.ratio**2 + c.segments.reduce((n,s)=>n+(s.availability==='AVAILABLE'?w.available:w.rac),0)/c.segments.length
 +c.connections.reduce((n,s)=>n+(s.safety==='GOOD'?w.good:s.safety==='LONG'?w.long:w.tight),0)-w.twoChanges
 -w.duration*c.totalScheduledDurationMinutes/(c.totalScheduledDurationMinutes+1440)-w.detour*Math.min(1,Math.max(0,detour-1))
 +c.segments.reduce((n,s)=>n+w.class/(1+Math.max(0,classes.indexOf(s.classCode))),0)/c.segments.length
 -(c.totalReservedFare===undefined?w.fare:w.fare*c.totalReservedFare/(c.totalReservedFare+1000));
}
export function bestPossibleScore(path:PartialJourneyPath,times:ConnectionTimeConfig=connectionTimes()):number {
 const w=PATH_WEIGHTS; const duration=path.runs.length?path.runs.at(-1)!.arrival-path.runs[0].departure:0;
 const known=path.runs.slice(1).reduce((sum,r,i)=>{const safety=connectionSafety(r.departure-path.runs[i].arrival,times);return sum+(safety==='GOOD'?w.good:safety==='LONG'?w.long:w.tight);},0);
 return w.coverage+w.available+(2-Math.max(0,path.runs.length-1))*w.good+known+w.class-w.twoChanges-w.duration*duration/(duration+1440);
}
export function pathDominates(a:PartialJourneyPath,b:PartialJourneyPath):boolean {
 // Same exact arrival context and visited resources preserve future transfer-window feasibility.
 const last=(p:PartialJourneyPath)=>p.runs.at(-1)!;
 const keys=(s:Set<string>)=>[...s].sort().join('|');
 return a.runs.length===b.runs.length && last(a).train.toStationCode===last(b).train.toStationCode && last(a).arrival===last(b).arrival &&
 keys(a.visitedStations)===keys(b.visitedStations)&&keys(a.visitedTrains)===keys(b.visitedTrains)&&a.progress>=b.progress&&a.score>b.score;
}
export function retainBeam(paths:PartialJourneyPath[],width:number,d:MultiDiagnostics):PartialJourneyPath[] {
 const sorted=paths.filter(p=>!paths.some(o=>o!==p&&pathDominates(o,p))).sort((a,b)=>b.score-a.score||a.runs.map(r=>r.train.trainNumber).join().localeCompare(b.runs.map(r=>r.train.trainNumber).join()));
 d.multiInterchangeDominancePruned+=paths.length-sorted.length;
 const diverse:PartialJourneyPath[]=[];const seen=new Set<string>();
 for(const p of sorted) { const key=p.runs.at(-1)!.train.toStationCode; if(!seen.has(key)&&p.score>=sorted[0].score-150){diverse.push(p);seen.add(key);} }
 const beam=[...diverse,...sorted.filter(p=>!diverse.includes(p))].slice(0,width);
 d.multiInterchangeBeamPruned+=sorted.length-beam.length; d.multiInterchangeMaxFrontier=Math.max(d.multiInterchangeMaxFrontier,beam.length);return beam;
}
