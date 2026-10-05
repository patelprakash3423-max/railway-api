import {searchSelectedEvidence} from './selected-evidence.js';
import type {TravelClass} from '../../types/journey-segment.js';
import type {InventoryCheck} from '../types.js';
import {recoveryClassPreference} from './paths.js';

export type EvidenceSearchMode='EXACT_MATRIX'|'ADAPTIVE_GRAPH';
export type EvidenceStopReason='EXACT_MATRIX_COMPLETE'|'SUFFICIENT_HIGH_QUALITY_RESULTS'|'MARGINAL_VALUE_LOW'|'PROVIDER_BUDGET_EXHAUSTED'|'LOGICAL_SAFETY_LIMIT'|'DEADLINE'|'PROVIDER_RATE_LIMIT'|'PROVIDER_UNAVAILABLE'|'FAIRNESS_RESERVE'|'SCOPE_EXHAUSTED'|'BOUNDED_FALLBACK_COMPLETE';
export interface EvidenceSearchDiagnostics {
 searchMode:EvidenceSearchMode;possibleMatrixEdges:number;checkedMatrixEdges:number;matrixCoverage:number;
 stationsExplored:number;classesExplored:number;fullPathsFound:number;partialPathsFound:number;stopReason:EvidenceStopReason;
}
export const evidenceSearchPolicy=Object.freeze({batchSize:8,frontierSize:512,estimatedAttemptMs:150});
export const selectedFallbackPolicy=Object.freeze({minimumNegativeAgeMs:60000,maxStops:4,maxClassesPerStop:2,maxProviderCandidates:8});
export interface EvidenceEdge {a:number;b:number;c:TravelClass}
export interface EvidenceGap {a:number;b:number}
export type BoundedGapRejection='DUPLICATE'|'EXACT_EVIDENCE_ALREADY_EXISTS'|'UNSUPPORTED_CLASS'|'OUTSIDE_GAP'|'INVALID_STATION_ORDER';
export type BoundedGapLifecycle='GENERATED'|'REJECTED'|'EXECUTED'|'RESEEDED';
export interface BoundedProbeProgress {
 causedGapShrink:boolean;createdNewUnresolvedSubrange:boolean;scheduledFurtherRefinement:boolean;
 refinementSkipReason:EvidenceStopReason|'NO_INTERNAL_STATIONS'|'UNSUPPORTED_CLASS'|'NO_UNEXPLORED_SMALLER_STRATEGIC_CANDIDATES'|null;
}
export type EvidenceRevisit=(providerAllowance:number,logicalAllowance:number)=>Promise<EvidenceSearchDiagnostics>;
export const candidateRevisitPolicy=Object.freeze({checksPerTurn:8,maxRounds:4,noGainRounds:2});
export interface CandidateRevisitDiagnostics {
 candidates:number;rounds:number;providerCalls:number;logicalChecks:number;fullRecoveries:number;
 turns:{round:number;trainNumber:string;providerCalls:number;logicalChecks:number;stopReason:EvidenceStopReason}[];
}
export interface EvidenceSearchContext {
 currentTimeMs?:()=>number;
 claimFallback?:()=>boolean;
 refreshNegative?:(edge:EvidenceEdge,minimumAgeMs:number)=>Promise<InventoryCheck|undefined>;
 diagnosticProbe?:(edge:EvidenceEdge,reason:string,expansion?:boolean)=>void;
 diagnosticPriority?:(edge:EvidenceEdge,positiveClassEvidence:boolean)=>void;
 diagnosticFrontier?:(before:number,after:number)=>void;
 diagnosticBoundedGap?:(gap:EvidenceGap)=>void;
 diagnosticBoundedPriority?:()=>void;
 diagnosticBoundedCandidate?:(event:BoundedGapLifecycle,reason?:BoundedGapRejection)=>void;
 /** Returns a capped diagnostic record; mutations only annotate the trace. */
 diagnosticBoundedResult?:(edge:EvidenceEdge,check:InventoryCheck)=>BoundedProbeProgress|undefined;
 diagnosticBoundedRefinement?:()=>void;
 diagnosticGapShrink?:(before:EvidenceGap,after:EvidenceGap|null)=>void;
 unsupportedClass?:(c:TravelClass)=>boolean;
 nodeDistances?:readonly number[];
 strategicProbesFirst?:boolean;
 preferredNodes?:readonly number[];
 cached?:(edge:EvidenceEdge)=>Promise<InventoryCheck|undefined>;
 deferWholeLegWidening?:boolean;
 balancedFairness?:boolean;
 nodes:number;scopeNodes?:number;classes:TravelClass[];providerAllowance:number;logicalAllowance:number;enough:boolean;
 providerUsed:()=>number;providerRemaining:()=>number;remainingTime:()=>number;active:()=>void;
 known:(edge:EvidenceEdge)=>InventoryCheck|undefined;
 check:(edge:EvidenceEdge)=>Promise<InventoryCheck|undefined>;
 solve:()=>{full:number;partial:number;reserved:number;gaps:{a:number;b:number}[];reservationParts?:EvidenceEdge[]};
 defer?:(resume:EvidenceRevisit)=>void;
}
export const matrixCost=(nodes:number,classes:number)=>classes*nodes*(nodes-1)/2;
const truth=(check:InventoryCheck|undefined)=>!!check&&['AVAILABLE','RAC','WAITLIST','UNAVAILABLE'].includes(check.status);
const key=(e:EvidenceEdge)=>`${e.a}:${e.b}:${e.c}`;
/** Alternating ends gives the tail an opportunity in the very first batch. */
export function* routeWideNodes(first:number,last:number):Generator<number>{
 while(first<=last){yield first++;if(first<=last)yield last--;}
}
/** Keep the established early/tail opportunities, then bisect unvisited regions. */
export function* balancedRouteNodes(first:number,last:number):Generator<number>{
 const middle=Math.ceil((first+last)/2),seen=new Set<number>();
 for(const node of [first,last,middle,last-1])if(node>=first&&node<=last&&!seen.has(node)){seen.add(node);yield node;}
 const anchors=[...seen].sort((a,b)=>a-b),ranges=anchors.slice(1).map((b,i)=>({a:anchors[i],b}));
 for(let index=0;index<ranges.length;index++){
  const {a,b}=ranges[index];if(b-a<=1)continue;
  const node=b<=middle?Math.floor((a+b)/2):Math.ceil((a+b)/2);
  if(!seen.has(node)){seen.add(node);yield node;}
  ranges.push({a,b:node},{a:node,b});
 }
}
/** Give all classes an early regional opportunity, then widen across the route. */
export function* balancedSpine(nodes:number,classes:TravelClass[]):Generator<{k:number;c:TravelClass}>{
 const stations=[...balancedRouteNodes(1,nodes-2)];
 const representatives=stations.slice(0,3),remaining=stations.slice(3);
 for(const c of classes)for(const k of representatives)yield {k,c};
 for(let pass=0;pass<classes.length;pass++)for(const [index,k]of remaining.entries())yield {k,c:classes[(index+pass)%classes.length]};
}
export async function searchEvidenceGraph(ctx:EvidenceSearchContext):Promise<EvidenceSearchDiagnostics>{
 if(ctx.strategicProbesFirst)return searchSelectedEvidence(ctx);
 const possibleMatrixEdges=matrixCost(ctx.scopeNodes??ctx.nodes,ctx.classes.length),last=ctx.nodes-1;
 const visited=new Map<string,EvidenceEdge>(),valid=new Set<string>(),stations=new Set<number>(),classes=new Set<string>();
 let started=ctx.providerUsed(),freshChecks=0,reason:EvidenceStopReason|undefined,providerFailure=false;
 // Only session-known fresh evidence is discounted. No speculative Redis/SQLite probes.
 let knownCount=0;
 if(possibleMatrixEdges<=ctx.logicalAllowance+ctx.classes.length){
  for(let a=0;a<last;a++)for(let b=a+1;b<=last;b++)for(const c of ctx.classes)if(truth(ctx.known({a,b,c})))knownCount++;
 }
 const missing=possibleMatrixEdges-knownCount;
 const searchMode:EvidenceSearchMode=!ctx.strategicProbesFirst&&!ctx.enough&&missing<=ctx.providerAllowance&&missing<=ctx.logicalAllowance&&missing*evidenceSearchPolicy.estimatedAttemptMs<=ctx.remainingTime()?'EXACT_MATRIX':'ADAPTIVE_GRAPH';
 const observe=async(e:EvidenceEdge):Promise<boolean>=>{
  if(visited.has(key(e)))return true;
  ctx.active();
  if(ctx.remainingTime()<=0){reason='DEADLINE';return false;}
  const cached=ctx.known(e);
  // Provider denial also reduces the session's effective logical allowance to
  // zero. Preserve the stop boundary, but report the resource actually exhausted.
  if(!cached&&freshChecks>=ctx.logicalAllowance){reason=ctx.providerRemaining()===0?'PROVIDER_BUDGET_EXHAUSTED':'LOGICAL_SAFETY_LIMIT';return false;}
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
 for(const c of ctx.classes){
  if(ctx.deferWholeLegWidening&&!ctx.known({a:0,b:last,c})&&!ctx.classes.some(knownClass=>ctx.known({a:0,b:last,c:knownClass})?.fare)&&ctx.classes.some(knownClass=>{
   const hit=ctx.known({a:0,b:last,c:knownClass});
   return hit?.status==='AVAILABLE'&&!hit.fare&&recoveryClassPreference(knownClass)<recoveryClassPreference(c);
  }))continue;
  if(!await observe({a:0,b:last,c}))break;
 }
 quality=ctx.solve();
 solvedVersion=usableVersion;
 if(!reason&&searchMode==='ADAPTIVE_GRAPH'&&(ctx.enough||quality.full))reason='SUFFICIENT_HIGH_QUALITY_RESULTS';
 if(!reason&&searchMode==='EXACT_MATRIX'){
  for(const e of matrix())if(!await observe(e))break;
 }else if(!reason){
  // Retain the old pass/refinement cadence, but distribute its endpoint pairs
  // over regional representatives, then the rest of the route. Whole-leg
  // breadth and gap priorities are unchanged.
  const balanced=ctx.balancedFairness!==false?balancedSpine(ctx.nodes,ctx.classes):undefined;
  spine:for(let pass=0;pass<ctx.classes.length;pass++){
   let index=0;
   for(const legacyStation of routeWideNodes(1,last-1)){
    const next=balanced?.next().value;
    const k=next?.k??legacyStation,c=next?.c??ctx.classes[(index+pass)%ctx.classes.length];index++;
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
 const snapshot=()=>{
 quality=ctx.solve();
 // Revalidate session freshness before claiming coverage at completion.
 for(const [k,e]of visited)if(!truth(ctx.known(e)))valid.delete(k);
 const complete=valid.size===possibleMatrixEdges;
 if(reason==='SUFFICIENT_HIGH_QUALITY_RESULTS'&&!ctx.enough&&!quality.full)reason='MARGINAL_VALUE_LOW';
 reason??=providerFailure?'PROVIDER_UNAVAILABLE':complete?(searchMode==='EXACT_MATRIX'?'EXACT_MATRIX_COMPLETE':'SCOPE_EXHAUSTED'):'MARGINAL_VALUE_LOW';
 return {searchMode,possibleMatrixEdges,checkedMatrixEdges:valid.size,matrixCoverage:possibleMatrixEdges?100*valid.size/possibleMatrixEdges:100,stationsExplored:stations.size,classesExplored:classes.size,fullPathsFound:quality.full,partialPathsFound:quality.partial,stopReason:reason};
 };
 const result=snapshot();
 if(!quality.full&&quality.reserved>0&&['FAIRNESS_RESERVE','MARGINAL_VALUE_LOW'].includes(result.stopReason))ctx.defer?.(async(providerAllowance,logicalAllowance)=>{
  // Retain the original graph and visited identities. This is gap reinvestment,
  // never a new matrix/spine traversal or a new provider admission budget.
  ctx.providerAllowance=providerAllowance;ctx.logicalAllowance=logicalAllowance;
  started=ctx.providerUsed();freshChecks=0;reason=undefined;quality=ctx.solve();
  if(quality.full){reason='SUFFICIENT_HIGH_QUALITY_RESULTS';return snapshot();}
  if(!quality.reserved){reason='SCOPE_EXHAUSTED';return snapshot();}
  function* gaps():Generator<EvidenceEdge>{
   for(const gap of quality.gaps){
    for(const c of ctx.classes)yield {...gap,c};
    let index=0;
    for(const k of routeWideNodes(gap.a+1,gap.b-1)){
     for(let pass=0;pass<ctx.classes.length;pass++){
      const c=ctx.classes[(index+pass)%ctx.classes.length];yield {a:gap.a,b:k,c};yield {a:k,b:gap.b,c};
     }
     index++;
    }
   }
  }
  let checked=0;
  for(const edge of gaps()){
   if(visited.has(key(edge)))continue;
   if(!await observe(edge))break;
   checked++;quality=ctx.solve();
   if(quality.full){reason='SUFFICIENT_HIGH_QUALITY_RESULTS';break;}
   if(checked>=candidateRevisitPolicy.checksPerTurn){reason='FAIRNESS_RESERVE';break;}
  }
  reason??=providerFailure?'PROVIDER_UNAVAILABLE':'SCOPE_EXHAUSTED';
  return snapshot();
 });
 return result;
}
