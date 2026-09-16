import type { RecoverySegment, RecoverySolution, ReservedSegment } from './types.js';
export interface IntervalEdge { from:number; to:number; segment:ReservedSegment }
export interface Path { segments:RecoverySegment[]; reserved:number; racDistance:number; changes:number; lastClass:string; fragments:number; knownFare:number; missingFares:number }
const comfort=['1A','EC','2A','3A','3E','CC','SL','2S'];
const comfortCost=(segments:RecoverySegment[])=>segments.reduce((n,s)=>n+(s.type==='RESERVED'?comfort.indexOf(s.selectedClass):0),0);
const identity=(p:Path)=>JSON.stringify(p.segments.map(s=>[s.type,s.fromStation,s.toStation,s.type==='RESERVED'?s.selectedClass:'']));
export function rankPath(a:Path,b:Path):number {return b.reserved-a.reserved||Number(a.segments.some(s=>s.type==='SELF_MANAGED'))-Number(b.segments.some(s=>s.type==='SELF_MANAGED'))||a.racDistance-b.racDistance||a.changes-b.changes||a.fragments-b.fragments||a.missingFares-b.missingFares||a.knownFare-b.knownFare||comfortCost(a.segments)-comfortCost(b.segments)||identity(a).localeCompare(identity(b));}
export function append(path:Path,segment:RecoverySegment):Path {
  const segments=[...path.segments],previous=segments.at(-1);
  let fragments=path.fragments;
  if(segment.type==='SELF_MANAGED'&&previous?.type==='SELF_MANAGED')segments[segments.length-1]={...previous,toStation:segment.toStation,distanceKm:previous.distanceKm+segment.distanceKm};
  else if(segment.type==='RESERVED'&&previous?.type==='RESERVED'&&previous.toStation===segment.fromStation&&previous.selectedClass===segment.selectedClass&&previous.availabilityStatus===segment.availabilityStatus){
    // Display coalescing only. Exact reservation evidence and fares remain separate;
    // we never claim a combined interval was checked as a through reservation.
    const parts=[...previous.reservationParts,...segment.reservationParts];
    segments[segments.length-1]={...previous,toStation:segment.toStation,arrivalDateTime:segment.arrivalDateTime,distanceKm:previous.distanceKm+segment.distanceKm,reservationParts:parts,availabilityText:'Separate interval reservations; see reservationParts',fare:parts.every(p=>p.fare)?{currency:'INR',totalFare:parts.reduce((n,p)=>n+p.fare!.totalFare,0)}:undefined};
  }else{segments.push(segment);if(segment.type==='RESERVED')fragments++;}
  const reserved=segment.type==='RESERVED';
  return{segments,reserved:path.reserved+(reserved?segment.distanceKm:0),racDistance:path.racDistance+(reserved&&segment.availabilityStatus==='RAC'?segment.distanceKm:0),changes:path.changes+Number(reserved&&!!path.lastClass&&path.lastClass!==segment.selectedClass),lastClass:reserved?segment.selectedClass:path.lastClass,fragments,knownFare:path.knownFare+(reserved?segment.reservationParts.reduce((n,p)=>n+(p.fare?.totalFare??0),0):0),missingFares:path.missingFares+(reserved?segment.reservationParts.filter(p=>!p.fare).length:0)};
}
/** Forward DAG DP. Each retained prefix is expanded once; no class Cartesian product. */
export function intervalPaths(nodes:{code:string;distance:number}[],edges:IntervalEdge[],cap:number,onPrune:(n:number)=>void):Path[]{
  const states:Path[][]=nodes.map(()=>[]);states[0]=[{segments:[],reserved:0,racDistance:0,changes:0,lastClass:'',fragments:0,knownFare:0,missingFares:0}];
  for(let i=0;i<nodes.length;i++){
    const unique=new Map<string,Path>();for(const p of states[i]){const key=identity(p),old=unique.get(key);if(!old||rankPath(p,old)<0)unique.set(key,p);}
    const ordered=[...unique.values()].sort(rankPath);if(ordered.length>cap)onPrune(ordered.length-cap);states[i]=ordered.slice(0,cap);
    if(i===nodes.length-1)break;
    const outgoing=edges.filter(e=>e.from===i);
    for(const p of states[i]){
      states[i+1].push(append(p,{type:'SELF_MANAGED',fromStation:nodes[i].code,toStation:nodes[i+1].code,distanceKm:nodes[i+1].distance-nodes[i].distance,notice:'No reserved coverage or transportation is confirmed for this range.'}));
      for(const edge of outgoing)states[edge.to].push(append(p,edge.segment));
    }
  }
  return states.at(-1)!;
}
export function rankRecovery(a:RecoverySolution,b:RecoverySolution):number{
  const rac=(s:RecoverySolution)=>s.segments.reduce((n,p)=>n+(p.type==='RESERVED'&&p.availabilityStatus==='RAC'?p.distanceKm:0),0);
  const missing=(s:RecoverySolution)=>s.segments.reduce((n,p)=>n+(p.type==='RESERVED'?p.reservationParts.filter(part=>!part.fare).length:0),0);
  const full=(s:RecoverySolution)=>s.recoveryStatus==='FULL_RESERVED_SINGLE_CLASS'||s.recoveryStatus==='FULL_RESERVED_SPLIT_CLASS';
  return Number(full(b))-Number(full(a))||b.reservedCoverageRatio-a.reservedCoverageRatio||rac(a)-rac(b)||a.selfManagedDistanceKm-b.selfManagedDistanceKm||a.classChanges-b.classChanges||a.reservedSegmentCount-b.reservedSegmentCount||missing(a)-missing(b)||a.totalKnownFare-b.totalKnownFare||comfortCost(a.segments)-comfortCost(b.segments)||JSON.stringify(a.segments).localeCompare(JSON.stringify(b.segments));
}
