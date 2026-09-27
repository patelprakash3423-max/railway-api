import type {TravelClass} from '../../types/journey-segment.js';
import type {InventoryCheck} from '../types.js';

export type EvidenceSearchMode='EXACT_MATRIX'|'ADAPTIVE_GRAPH';
export type EvidenceStopReason='EXACT_MATRIX_COMPLETE'|'SUFFICIENT_HIGH_QUALITY_RESULTS'|'MARGINAL_VALUE_LOW'|'PROVIDER_BUDGET_EXHAUSTED'|'LOGICAL_SAFETY_LIMIT'|'DEADLINE'|'PROVIDER_RATE_LIMIT'|'PROVIDER_UNAVAILABLE'|'FAIRNESS_RESERVE'|'SCOPE_EXHAUSTED';
export interface EvidenceSearchDiagnostics {
 searchMode:EvidenceSearchMode;possibleMatrixEdges:number;checkedMatrixEdges:number;matrixCoverage:number;
 stationsExplored:number;classesExplored:number;fullPathsFound:number;partialPathsFound:number;stopReason:EvidenceStopReason;
}
export const evidenceSearchPolicy=Object.freeze({batchSize:8,frontierSize:512,estimatedAttemptMs:150});
export interface EvidenceEdge {a:number;b:number;c:TravelClass}
export interface EvidenceSearchContext {
 nodes:number;scopeNodes?:number;classes:TravelClass[];providerAllowance:number;logicalAllowance:number;enough:boolean;
 providerUsed:()=>number;providerRemaining:()=>number;remainingTime:()=>number;active:()=>void;
 known:(edge:EvidenceEdge)=>InventoryCheck|undefined;
 check:(edge:EvidenceEdge)=>Promise<InventoryCheck|undefined>;
 solve:()=>{full:number;partial:number;reserved:number;gaps:{a:number;b:number}[]};
}
export const matrixCost=(nodes:number,classes:number)=>classes*nodes*(nodes-1)/2;
const truth=(check:InventoryCheck|undefined)=>!!check&&['AVAILABLE','RAC','WAITLIST','UNAVAILABLE'].includes(check.status);
const key=(e:EvidenceEdge)=>`${e.a}:${e.b}:${e.c}`;
/** Alternating ends gives the tail an opportunity in the very first batch. */
export function* routeWideNodes(first:number,last:number):Generator<number>{
 while(first<=last){yield first++;if(first<=last)yield last--;}
}
export async function searchEvidenceGraph(ctx:EvidenceSearchContext):Promise<EvidenceSearchDiagnostics>{
 const possibleMatrixEdges=matrixCost(ctx.scopeNodes??ctx.nodes,ctx.classes.length),last=ctx.nodes-1;
 const visited=new Map<string,EvidenceEdge>(),valid=new Set<string>(),stations=new Set<number>(),classes=new Set<string>();
 const started=ctx.providerUsed();let freshChecks=0,reason:EvidenceStopReason|undefined,providerFailure=false;
 // Only session-known fresh evidence is discounted. No speculative Redis/SQLite probes.
 let knownCount=0;
 if(possibleMatrixEdges<=ctx.logicalAllowance+ctx.classes.length){
  for(let a=0;a<last;a++)for(let b=a+1;b<=last;b++)for(const c of ctx.classes)if(truth(ctx.known({a,b,c})))knownCount++;
 }
 const missing=possibleMatrixEdges-knownCount;
 const searchMode:EvidenceSearchMode=!ctx.enough&&missing<=ctx.providerAllowance&&missing<=ctx.logicalAllowance&&missing*evidenceSearchPolicy.estimatedAttemptMs<=ctx.remainingTime()?'EXACT_MATRIX':'ADAPTIVE_GRAPH';
 const observe=async(e:EvidenceEdge):Promise<boolean>=>{
  if(visited.has(key(e)))return true;
  ctx.active();
  if(ctx.remainingTime()<=0){reason='DEADLINE';return false;}
  const cached=ctx.known(e);
  if(!cached&&freshChecks>=ctx.logicalAllowance){reason='LOGICAL_SAFETY_LIMIT';return false;}
  // This is a scheduling reservation, not provider admission. The global gate
  // still owns admission, retries, quotas, and cache-before-budget behavior.
  if(!cached&&ctx.providerRemaining()>0&&ctx.providerUsed()-started>=ctx.providerAllowance){reason='FAIRNESS_RESERVE';return false;}
  const check=await ctx.check(e);
  if(!check){reason=ctx.providerRemaining()===0?'PROVIDER_BUDGET_EXHAUSTED':'LOGICAL_SAFETY_LIMIT';return false;}
  if(!cached)freshChecks++;
  visited.set(key(e),e);stations.add(e.a);stations.add(e.b);classes.add(e.c);
  if(truth(check))valid.add(key(e));
  else if(check.errorCategory==='PROVIDER_BUDGET_EXHAUSTED'){reason='PROVIDER_BUDGET_EXHAUSTED';return false;}
  else if(check.errorCategory==='RATE_LIMITED'){reason='PROVIDER_RATE_LIMIT';return false;}
  else if(check.status==='PROVIDER_ERROR'){providerFailure=true;}
  if(check.status==='AVAILABLE'||check.status==='RAC')usableVersion++;
  return true;
 };
 function* matrix():Generator<EvidenceEdge>{for(let span=last;span>=1;span--)for(let a=0;a+span<=last;a++)for(const c of ctx.classes)yield {a,b:a+span,c};}
 let quality=ctx.solve(),batch=0,flatPaidBatches=0,lastPaid=ctx.providerUsed();
 let usableVersion=0,solvedVersion=-1;
 const solveBatch=()=>{
  const next=solvedVersion===usableVersion?quality:ctx.solve(),paid=ctx.providerUsed()>lastPaid;
  solvedVersion=usableVersion;
  flatPaidBatches=next.reserved>quality.reserved?0:paid?flatPaidBatches+1:flatPaidBatches;
  lastPaid=ctx.providerUsed();quality=next;batch=0;
  if(quality.full){reason='SUFFICIENT_HIGH_QUALITY_RESULTS';return false;}
  return true;
 };
 // Whole-leg evidence is always first, including when the parent preloaded it.
 for(const c of ctx.classes)if(!await observe({a:0,b:last,c}))break;
 quality=ctx.solve();
 solvedVersion=usableVersion;
 if(!reason&&searchMode==='ADAPTIVE_GRAPH'&&(ctx.enough||quality.full))reason='SUFFICIENT_HIGH_QUALITY_RESULTS';
 if(!reason&&searchMode==='EXACT_MATRIX'){
  for(const e of matrix())if(!await observe(e))break;
 }else if(!reason){
  // One station/class pair per turn. Rotate classes across stations and passes;
  // never exhaust all classes at an early station before reaching the tail.
  spine:for(let pass=0;pass<ctx.classes.length;pass++){
   let index=0;
   for(const k of routeWideNodes(1,last-1)){
    const c=ctx.classes[(index+pass)%ctx.classes.length];index++;
    for(const e of [{a:0,b:k,c},{a:k,b:last,c}]){
     if(!await observe(e))break spine;
     if(++batch>=evidenceSearchPolicy.batchSize&&!solveBatch())break spine;
    }
    if(batch&&ctx.providerRemaining()<=evidenceSearchPolicy.batchSize&&!solveBatch())break spine;
   }
   if(!solveBatch())break;
   // Every station has had an opportunity in this pass. Give an established
   // partial path a small bridge/refinement turn before another class pass.
   if(quality.reserved>0){
    function* bridges():Generator<EvidenceEdge>{
     for(const gap of quality.gaps){
      for(const c of ctx.classes)yield {...gap,c};
      let index=0;
      for(const k of routeWideNodes(gap.a+1,gap.b-1)){
       const c=ctx.classes[(index+pass)%ctx.classes.length];index++;
       yield {a:gap.a,b:k,c};yield {a:k,b:gap.b,c};
      }
     }
    }
    let count=0;
    for(const e of bridges()){
     if(visited.has(key(e)))continue;
     if(!await observe(e))break spine;
     if(++count>=evidenceSearchPolicy.batchSize)break;
    }
    if(count&&!solveBatch())break;
   }
  }
  if(!reason)solveBatch();
  // Bounded, regenerated gap frontier. Status comes only from check(), never
  // from this priority. Direct bridges precede route-wide subinterval pairs.
  const fallback=matrix();let exhausted=false;
  while(!reason&&!exhausted){
   const frontier=new Map<string,EvidenceEdge>();
   const add=(e:EvidenceEdge)=>{if(!visited.has(key(e))&&frontier.size<evidenceSearchPolicy.frontierSize)frontier.set(key(e),e);};
   for(const gap of quality.gaps){
    for(const c of ctx.classes)add({...gap,c});
    let index=0;
    for(const k of routeWideNodes(gap.a+1,gap.b-1)){
     for(let pass=0;pass<ctx.classes.length;pass++){
      const c=ctx.classes[(index+pass)%ctx.classes.length];add({a:gap.a,b:k,c});add({a:k,b:gap.b,c});
     }
     index++;if(frontier.size>=evidenceSearchPolicy.frontierSize)break;
    }
   }
   while(frontier.size<evidenceSearchPolicy.batchSize&&!exhausted){const item=fallback.next();if(item.done)exhausted=true;else add(item.value);}
   let count=0;
   for(const e of frontier.values()){if(!await observe(e))break;if(++count>=evidenceSearchPolicy.batchSize)break;}
   if(!count)break;
   if(!reason)solveBatch();
   if(!reason&&flatPaidBatches>=2)reason='MARGINAL_VALUE_LOW';
   // Exhausting fallback does not discard an already generated gap frontier.
   if(frontier.size>count)exhausted=false;
  }
 }
 quality=ctx.solve();
 // Revalidate session freshness before claiming coverage at completion.
 for(const [k,e]of visited)if(!truth(ctx.known(e)))valid.delete(k);
 const complete=valid.size===possibleMatrixEdges;
 if(reason==='SUFFICIENT_HIGH_QUALITY_RESULTS'&&!ctx.enough&&!quality.full)reason='MARGINAL_VALUE_LOW';
 reason??=providerFailure?'PROVIDER_UNAVAILABLE':complete?(searchMode==='EXACT_MATRIX'?'EXACT_MATRIX_COMPLETE':'SCOPE_EXHAUSTED'):'MARGINAL_VALUE_LOW';
 return {searchMode,possibleMatrixEdges,checkedMatrixEdges:valid.size,matrixCoverage:possibleMatrixEdges?100*valid.size/possibleMatrixEdges:100,stationsExplored:stations.size,classesExplored:classes.size,fullPathsFound:quality.full,partialPathsFound:quality.partial,stopReason:reason};
}
