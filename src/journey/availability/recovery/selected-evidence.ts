import {selectedSearchStopped,selectedBoundedBreadth,selectedFallbackEvent} from '../selected-diagnostics.js';
import {selectedFallbackPolicy} from './evidence-search.js';
import type {BoundedGapRejection,BoundedProbeProgress,EvidenceEdge,EvidenceGap,EvidenceSearchContext,EvidenceSearchDiagnostics,EvidenceStopReason} from './evidence-search.js';

/** A deterministic refinement tree, reconstructed from fresh observations on a
 * later check. Replaying its cached prefix spends no live-call budget. */
export async function searchSelectedEvidence(ctx:EvidenceSearchContext):Promise<EvidenceSearchDiagnostics>{
 const last=ctx.nodes-1,visited=new Set<string>(),valid=new Set<string>(),stations=new Set<number>(),classes=new Set<string>();
 const cacheLookups=new Set<string>();
 const observed=new Map<string,EvidenceEdge>(),unsupported=new Set<string>();
 // Only retain records admitted by the capped diagnostic sink. These annotations
 // describe observed refinement; they never admit or suppress a search probe.
 const progress:{edge:EvidenceEdge;record:BoundedProbeProgress}[]=[];
 const edgeKey=(e:EvidenceEdge)=>`${e.a}:${e.b}:${e.c}`;
 const distance=(a:number,b:number)=>(ctx.nodeDistances?.[b]??b)-(ctx.nodeDistances?.[a]??a);
 const remember=(edge:EvidenceEdge,check:Awaited<ReturnType<typeof ctx.check>>)=>{
  observed.set(edgeKey(edge),edge);
  if(check?.status==='UNSUPPORTED_CLASS'&&check.errorCategory==='UNSUPPORTED_CLASS')unsupported.add(edge.c);
 };
 const started=ctx.providerUsed();let checks=0,reason:EvidenceStopReason|undefined;
 let quality=ctx.solve();
 const frontier=()=>quality.gaps[0]?.a??(quality.full?last:0);
 const bounded=(g:EvidenceGap)=>g.a>0&&g.b<last;
 const detectedGaps=new Set<string>();
 const preparedGaps=new Set<string>(),boundedPairs=new Map<string,EvidenceGap>(),adjacentPairs=new Map<string,EvidenceGap>();
 let adjacentPriorityProbes=0,classDepthProbes=0;
 const pairFresh=(e:EvidenceGap)=>ctx.classes.some(c=>['AVAILABLE','RAC','WAITLIST','UNAVAILABLE'].includes(ctx.known({...e,c})?.status??''));
 let lastGapSide:'LEFT'|'RIGHT'|undefined;
 // The solver merges adjacent unknown intervals and retains reserved islands.
 // An internal gap therefore has confirmed coverage on both boundaries.
 const detectGaps=()=>{for(const g of quality.gaps.filter(bounded)){
  const id=`${g.a}:${g.b}`;if(!detectedGaps.has(id)){detectedGaps.add(id);ctx.diagnosticBoundedGap?.(g);}
 }};
 const updateQuality=(next:typeof quality)=>{
  const before=quality,beforeFrontier=frontier();quality=next;
  if(frontier()!==beforeFrontier)ctx.diagnosticFrontier?.(beforeFrontier,frontier());
  for(const gap of before.gaps.filter(bounded)){
   const remaining=quality.gaps.filter(g=>g.a<gap.b&&g.b>gap.a);
   // Expiring evidence can enlarge a gap; never describe that as closure.
   if(remaining.some(g=>g.a<gap.a||g.b>gap.b))continue;
   if(!remaining.length)ctx.diagnosticGapShrink?.(gap,null);
   else if(remaining.reduce((n,g)=>n+distance(g.a,g.b),0)<distance(gap.a,gap.b))for(const g of remaining)ctx.diagnosticGapShrink?.(gap,g);
  }
  detectGaps();
  return before.gaps.length!==quality.gaps.length||before.gaps.some((g,i)=>g.a!==quality.gaps[i]?.a||g.b!==quality.gaps[i]?.b);
 };
 type Probe=EvidenceEdge&{pass:number;order:number;boundedCandidate?:boolean};
 interface Range {a:number;b:number;splits:number[];probes:Probe[];done:boolean;hydrated:boolean}
 const ranges=new Map<string,Range>(),queue:Range[]=[];
 const trackCandidate=(edge:Probe)=>{
  if(!edge.boundedCandidate&&quality.gaps.some(g=>bounded(g)&&edge.a<g.b&&edge.b>g.a)){
   edge.boundedCandidate=true;ctx.diagnosticBoundedCandidate?.('GENERATED');
  }
  if(quality.gaps.some(g=>bounded(g)&&edge.a>=g.a&&edge.b<=g.b))boundedPairs.set(`${edge.a}:${edge.b}`,{a:edge.a,b:edge.b});
 };
 const reject=(edge:Probe,reason:BoundedGapRejection)=>{if(edge.boundedCandidate)ctx.diagnosticBoundedCandidate?.('REJECTED',reason);};
 const splitPoints=(a:number,b:number)=>{
  if(b-a<2)return [];
  const middle=Math.floor((a+b)/2);
  const preferred=ctx.preferredNodes?.find(k=>k>a&&k<b);
  // One locally useful split, a middle point and an early point. Subsequent
  // disjoint child ranges distribute refinement over the rest of the leg.
  return [...new Set([preferred??middle,middle,a+1])].filter(k=>k>a&&k<b);
 };
 function* probes(a:number,b:number,splits:number[]):Generator<EvidenceEdge>{
  for(const c of ctx.classes)yield {a,b,c};
  // Rotate the initial class across splits; widen classes only on later passes.
  for(let pass=0;pass<ctx.classes.length;pass++)for(const [i,k]of splits.entries()){
   const c=ctx.classes[(i+pass)%ctx.classes.length];
   yield {a,b:k,c};yield {a:k,b,c};
  }
 }
 const schedule=(a:number,b:number,priority=false)=>{
  if(a>=b)return;
  const id=`${a}:${b}`;let range=ranges.get(id);
  if(!range){const splits=splitPoints(a,b);range={a,b,splits,probes:[...probes(a,b,splits)].map((e,i)=>({...e,order:i,pass:i<ctx.classes.length?-1:Math.floor((i-ctx.classes.length)/(2*splits.length))})),done:false,hydrated:false};ranges.set(id,range);queue.push(range);}
  for(const edge of range.probes)trackCandidate(edge);
  if(priority&&!range.done){const i=queue.indexOf(range);if(i>=0)queue.splice(i,1);queue.unshift(range);}
 };
 // An exhausted split tree is not an exhausted gap: its disjoint children
 // omit longer extensions from the original boundaries. Refill only those
 // boundary frontiers (linear in stops/classes), never the all-pairs matrix.
 const reseedBoundedGaps=()=>{
  for(const gap of quality.gaps.filter(bounded)){
   const candidates=[...probes(gap.a,gap.b,Array.from({length:gap.b-gap.a-1},(_,i)=>gap.a+i+1))];
   const pending=candidates.filter(e=>!visited.has(edgeKey(e)));
   if(!pending.length)continue;
   const id=`${gap.a}:${gap.b}`,range=ranges.get(id)??{...gap,splits:splitPoints(gap.a,gap.b),probes:[],done:false,hydrated:false};
   range.probes=pending.map((e,i)=>({...e,order:i,pass:0}));range.done=false;range.hydrated=false;
   for(const edge of range.probes)trackCandidate(edge);
   ranges.set(id,range);queue.push(range);ctx.diagnosticBoundedCandidate?.('RESEEDED');
  }
  return queue.length>0;
 };
 const prepareBoundedFrontier=()=>{
  for(const gap of quality.gaps.filter(bounded)){
   const id=`${gap.a}:${gap.b}`;if(preparedGaps.has(id))continue;preparedGaps.add(id);
   // Expose the existing disjoint split tree and boundary frontier before class
   // depth. This is linear in stations/classes, not an all-pairs matrix.
   const pending=[gap];
   for(let i=0;i<pending.length;i++){
    const {a,b}=pending[i];schedule(a,b);
    const anchors=[a,...splitPoints(a,b),b].sort((x,y)=>x-y);
    if(b-a>1)for(let j=1;j<anchors.length;j++)pending.push({a:anchors[j-1],b:anchors[j]});
   }
   for(let a=gap.a;a<gap.b;a++)adjacentPairs.set(`${a}:${a+1}`,{a,b:a+1});
   const range=ranges.get(id)!,existing=new Set(range.probes.map(edgeKey));
   for(const e of probes(gap.a,gap.b,Array.from({length:gap.b-gap.a-1},(_,i)=>gap.a+i+1))){
    if(existing.has(edgeKey(e))||visited.has(edgeKey(e)))continue;
    const edge={...e,order:range.probes.length,pass:0};range.probes.push(edge);trackCandidate(edge);existing.add(edgeKey(e));
    // A newly active gap may reuse a previously hydrated child range. Look up
    // its newly exposed boundaries too before deciding which pairs lack truth.
    range.hydrated=false;
    if(range.done){range.done=false;queue.push(range);}
   }
  }
 };
 // Rank only the existing bounded split frontier, never every station pair.
 // Bounded gaps outrank open ends. Prefer larger gaps, then their strategic
 // children, without admitting live probes across already reserved boundaries.
 const targetGap=(e:EvidenceGap)=>[...quality.gaps].sort((a,b)=>Number(bounded(b))-Number(bounded(a))||(bounded(a)&&bounded(b)?distance(b.a,b.b)-distance(a.a,a.b):0)||a.a-b.a).find(g=>e.a<g.b&&e.b>g.a);
 const gapRank=(e:{a:number;b:number})=>{
  const g=targetGap(e);
  if(!g)return [2,2,0,0,0];
  return [bounded(g)?0:1,e.a>=g.a&&e.b<=g.b?0:1,bounded(g)?-distance(g.a,g.b):0,g.a,e.a===g.a||bounded(g)&&e.b===g.b?0:1];
 };
 const compare=(a:number[],b:number[])=>{for(let i=0;i<Math.min(a.length,b.length);i++)if(a[i]!==b[i])return a[i]-b[i];return a.length-b.length;};
 const scores=(range:Range)=>{
  const positive=new Map<string,number>(),supported=new Set<string>(),waitlists:EvidenceEdge[]=[],usable:EvidenceEdge[]=[];
  for(const e of observed.values()){
   const hit=ctx.known(e); // Fresh evidence only; popularity never asserts inventory.
   if(!hit)continue;
   if(['AVAILABLE','RAC','WAITLIST','UNAVAILABLE'].includes(hit.status))supported.add(e.c);
   if(hit.status==='WAITLIST')waitlists.push(e);
   if(hit.status==='AVAILABLE'||hit.status==='RAC'){
    usable.push(e);
    const near=e.b<=range.a?range.a-e.b:e.a>=range.b?e.a-range.b:Infinity;
    if(near<=2)positive.set(e.c,(positive.get(e.c)??0)+(near===0?4:1));
   }
  }
  const positiveFor=(e:EvidenceEdge)=>{
   const gap=targetGap(e);if(!gap||!bounded(gap))return positive.get(e.c)??0;
   return usable.filter(p=>p.c===e.c).reduce((n,p)=>{
    const left=e.a===gap.a&&p.b<=gap.a?gap.a-p.b:Infinity;
    const right=e.b===gap.b&&p.a>=gap.b?p.a-gap.b:Infinity;
    const near=Math.min(left,right);return n+(near<=2?(near===0?4:1):0);
   },0);
  };
  const rank=(e:Probe)=>{
   const gap=targetGap(e),isBounded=gap&&bounded(gap);
   const direct=isBounded&&e.a===gap.a&&e.b===gap.b;
   // Within each breadth tier retain direct closure and useful boundary order,
   // using each boundary's own fresh positive class evidence.
   const sameSide=isBounded&&!direct&&(lastGapSide==='LEFT'&&e.a===gap.a||lastGapSide==='RIGHT'&&e.b===gap.b);
   const contained=isBounded&&e.a>=gap.a&&e.b<=gap.b;
   const breadth=contained?(pairFresh(e)?2:e.b-e.a===1?0:1):3;
   const trainPositive=usable.some(p=>p.c===e.c);
   return [isBounded?0:1,breadth,...gapRank(e),isBounded?Number(!direct):0,Number(!!sameSide),-positiveFor(e),
   contained?Number(!trainPositive):0,contained?ctx.classes.indexOf(e.c):0,
   // Repeated long WAITLIST probes make another equally long probe less useful;
   // shorter refinements remain eligible and no class is blacklisted by this.
   Number(waitlists.filter(w=>w.c===e.c&&w.a===e.a&&w.b<=e.b&&distance(w.a,w.b)>=distance(e.a,e.b)/2).length>=2),
   Number(!supported.has(e.c)),isBounded?-distance(e.a,e.b):e.pass,isBounded?e.pass:-distance(e.a,e.b),e.order];
  };
  return {positiveFor,rank};
 };
 schedule(0,last);
 detectGaps();for(const gap of [...quality.gaps].reverse())schedule(gap.a,gap.b,true);
 while(!reason){
  if(quality.full){reason='SUFFICIENT_HIGH_QUALITY_RESULTS';break;}
  prepareBoundedFrontier();
  if(!queue.length&&!reseedBoundedGaps())break;
  ctx.active();
  if(ctx.remainingTime()<=0){reason='DEADLINE';break;}
  // Hydrate bounded frontiers before choosing a breadth probe so a fresh result
  // in another class satisfies the pair without an unnecessary provider call.
  const queueRank=(r:Range)=>{
   const g=targetGap(r),inside=g&&bounded(g)&&r.a>=g.a&&r.b<=g.b;
   if(inside&&!r.hydrated)return [-2];
   const pending=r.probes.filter(e=>!visited.has(edgeKey(e)));
   if(!pending.length)return [-1];
   const {rank}=scores(r);return pending.map(rank).sort(compare)[0];
  };
  const hasBounded=quality.gaps.some(bounded);
  const ranked=queue.map(range=>({range,rank:hasBounded?queueRank(range):[...gapRank(range),-distance(range.a,range.b)]})).sort((a,b)=>compare(a.rank,b.rank));
  queue.splice(0,queue.length,...ranked.map(r=>r.range));
  const range=queue[0];
  if(!range.hydrated){
   range.hydrated=true;
   if(quality.gaps.some(g=>bounded(g)&&range.a>=g.a&&range.b<=g.b))ctx.diagnosticBoundedRefinement?.();
   const hydratedUsable:EvidenceEdge[]=[];
   // Bounded frontiers include a linear boundary sweep, never the pair matrix.
   if(ctx.cached)for(const edge of range.probes){
    ctx.active();if(ctx.remainingTime()<=0){reason='DEADLINE';break;}
    const id=edgeKey(edge);if(cacheLookups.has(id))continue;cacheLookups.add(id);
    const hit=await ctx.cached(edge);
    if(hit){remember(edge,hit);if(hit.status==='AVAILABLE'||hit.status==='RAC')hydratedUsable.push(edge);if(['AVAILABLE','RAC','WAITLIST','UNAVAILABLE'].includes(hit.status))valid.add(id);stations.add(edge.a);stations.add(edge.b);classes.add(edge.c);}
   }
   if(reason)break;
   const previous=quality.reserved,changed=updateQuality(ctx.solve());
   if(changed||quality.reserved>previous){
    if(!quality.full)for(const edge of hydratedUsable)ctx.diagnosticProbe?.(edge,'CACHED_BATCH_EXPANSION',true);
    if(quality.full){reason='SUFFICIENT_HIGH_QUALITY_RESULTS';break;}
    for(const gap of [...quality.gaps].reverse())schedule(gap.a,gap.b,true);
    if(queue[0]!==range)continue;
   }
   continue;
  }
  if(!range.probes.length){
   queue.shift();range.done=true;
   const anchors=[range.a,...range.splits,range.b].sort((a,b)=>a-b);
   for(let i=1;i<anchors.length;i++){
    const a=anchors[i-1],b=anchors[i];
    // Two adjacent split anchors need their own exact check too: neither
    // parent's boundary probe necessarily covers this internal leaf.
    if(b-a>1||quality.gaps.some(g=>bounded(g)&&a>=g.a&&b<=g.b))schedule(a,b);
   }
   continue;
  }
  const {positiveFor,rank}=scores(range);
  range.probes.sort((a,b)=>compare(rank(a),rank(b)));
  const edge=range.probes.shift()!,id=edgeKey(edge);trackCandidate(edge);
  if(visited.has(id)){reject(edge,'DUPLICATE');ctx.diagnosticProbe?.(edge,'DUPLICATE');continue;}
  const known=ctx.known(edge);
  if(!known&&(unsupported.has(edge.c)||ctx.unsupportedClass?.(edge.c))){visited.add(id);reject(edge,'UNSUPPORTED_CLASS');ctx.diagnosticProbe?.(edge,'UNSUPPORTED_TRAIN_CLASS');continue;}
  if(!known&&!quality.gaps.some(g=>edge.a<g.b&&edge.b>g.a)){reject(edge,'OUTSIDE_GAP');ctx.diagnosticProbe?.(edge,'ALREADY_COVERED');continue;}
  const gap=targetGap(edge),boundedTarget=gap&&bounded(gap);
  const coveredBefore=!!boundedTarget&&pairFresh(edge);
  if(!known&&boundedTarget&&(edge.a<gap.a||edge.b>gap.b)){reject(edge,'OUTSIDE_GAP');ctx.diagnosticProbe?.(edge,'OUTSIDE_BOUNDED_GAP');continue;}
  if(!known&&checks>=ctx.logicalAllowance){reason='LOGICAL_SAFETY_LIMIT';ctx.diagnosticProbe?.(edge,reason);break;}
  if(!known&&ctx.providerRemaining()>0&&ctx.providerUsed()-started>=ctx.providerAllowance){reason='FAIRNESS_RESERVE';ctx.diagnosticProbe?.(edge,reason);break;}
  if(!known&&quality.gaps.some(g=>edge.a===g.a&&edge.b<=g.b||bounded(g)&&edge.b===g.b&&edge.a>=g.a))ctx.diagnosticPriority?.(edge,positiveFor(edge)>0);
  // The existing gateway performs Redis/SQLite lookup before admitting a miss.
  const check=await ctx.check(edge);
  if(!check){reason=ctx.providerRemaining()===0?'PROVIDER_BUDGET_EXHAUSTED':'LOGICAL_SAFETY_LIMIT';ctx.diagnosticProbe?.(edge,reason);break;}
  visited.add(id);if(!known)checks++;stations.add(edge.a);stations.add(edge.b);classes.add(edge.c);
  remember(edge,check);
  if(['AVAILABLE','RAC','WAITLIST','UNAVAILABLE'].includes(check.status))valid.add(id);
  if(check.errorCategory==='PROVIDER_BUDGET_EXHAUSTED'){reason='PROVIDER_BUDGET_EXHAUSTED';break;}
  if(check.errorCategory==='RATE_LIMITED'){reason='PROVIDER_RATE_LIMIT';break;}
  if(known)reject(edge,'EXACT_EVIDENCE_ALREADY_EXISTS');
  if(!known&&boundedTarget){
   if(coveredBefore)classDepthProbes++;
   else if(edge.b-edge.a===1)adjacentPriorityProbes++;
   ctx.diagnosticBoundedCandidate?.('EXECUTED');
   ctx.diagnosticBoundedPriority?.();
   if(edge.a===gap.a&&edge.b<gap.b)lastGapSide='LEFT';
   else if(edge.b===gap.b&&edge.a>gap.a)lastGapSide='RIGHT';
  }
  if(!known&&boundedTarget)for(const prior of progress){
   if(edge.a>=prior.edge.a&&edge.b<=prior.edge.b&&(edge.a>prior.edge.a||edge.b<prior.edge.b)){
    prior.record.scheduledFurtherRefinement=true;prior.record.refinementSkipReason=null;
   }
  }
  const record=!known&&boundedTarget?ctx.diagnosticBoundedResult?.(edge,check):undefined;
  if(record)progress.push({edge,record});
  if(check.status==='AVAILABLE'||check.status==='RAC'){
   const previous=quality.reserved,changed=updateQuality(ctx.solve());
   if(record&&boundedTarget){
    const remaining=quality.gaps.filter(g=>g.a<gap.b&&g.b>gap.a);
    record.causedGapShrink=remaining.every(g=>g.a>=gap.a&&g.b<=gap.b)&&remaining.reduce((n,g)=>n+distance(g.a,g.b),0)<distance(gap.a,gap.b);
    record.createdNewUnresolvedSubrange=record.causedGapShrink&&remaining.length>0;
   }
   if(quality.full){reason='SUFFICIENT_HIGH_QUALITY_RESULTS';break;}
   // A confirmed portion changes the next question immediately: bridge the
   // uncovered range before spending more calls on the original endpoints.
   if(quality.reserved>previous)ctx.diagnosticProbe?.(edge,'UNCOVERED_RANGE_EXPANSION',true);
   if(changed||quality.reserved>previous)for(const gap of [...quality.gaps].reverse())schedule(gap.a,gap.b,true);
  }
 }
 quality=ctx.solve();
 // Only selected recovery's exhausted normal scope enters this request-bounded
 // endpoint sweep. Negative evidence stays reusable everywhere else.
 if(!reason&&!quality.full)selectedFallbackEvent('normalScopeExhaustions');
 if(!reason&&!quality.full&&ctx.claimFallback&&ctx.refreshNegative&&ctx.providerRemaining()>0&&ctx.providerUsed()<=selectedFallbackPolicy.maxInitialLiveCalls){
  selectedFallbackEvent('complementaryFallbackAttempts');
  const initialSplits=new Set(splitPoints(0,last)),seen=new Set<string>(),initialReserved=quality.reserved;let candidates=0;
  const usable=(e:EvidenceEdge)=>['AVAILABLE','RAC'].includes(ctx.known(e)?.status??'');
  const stopPositive=(k:number)=>ctx.classes.some(c=>usable({a:0,b:k,c})||usable({a:k,b:last,c}));
  const preferred=ctx.preferredNodes??Array.from({length:last-1},(_,i)=>i+1);
  const stops=[...new Set(preferred)].filter(k=>k>0&&k<last).sort((a,b)=>Number(stopPositive(b))-Number(stopPositive(a))||Number(initialSplits.has(a))-Number(initialSplits.has(b))||preferred.indexOf(a)-preferred.indexOf(b)).slice(0,selectedFallbackPolicy.maxStops);
  const probe=async(edge:EvidenceEdge)=>{
   const id=edgeKey(edge);if(seen.has(id))return true;seen.add(id);
   ctx.active();if(ctx.remainingTime()<=0){reason='DEADLINE';return false;}
   const cached=await ctx.cached?.(edge)??ctx.known(edge);
   if(cached?.status==='AVAILABLE'||cached?.status==='RAC'){remember(edge,cached);valid.add(id);updateQuality(ctx.solve());return !quality.full;}
   if(unsupported.has(edge.c)||ctx.unsupportedClass?.(edge.c)){ctx.diagnosticProbe?.(edge,'UNSUPPORTED_TRAIN_CLASS');return true;}
   if(cached&&!['WAITLIST','UNAVAILABLE'].includes(cached.status))return true;
   // A reserved island already drives the existing bounded-gap frontier. Do
   // not introduce unrelated endpoint misses across those covered boundaries.
   if(!cached&&initialReserved>0)return true;
   if(cached){
    const observedAt=cached.rawDetails?.observation?.observedAt??cached.evidence?.observedAt;
    if(observedAt===undefined||(ctx.currentTimeMs?.()??Date.now())-observedAt<selectedFallbackPolicy.minimumNegativeAgeMs){
     selectedFallbackEvent('negativeRefreshTooRecent');ctx.diagnosticProbe?.(edge,'NEGATIVE_REFRESH_TOO_RECENT');return true;
    }
   }
   if(ctx.providerRemaining()<=0){reason='PROVIDER_BUDGET_EXHAUSTED';return false;}
   if(checks>=ctx.logicalAllowance){reason='LOGICAL_SAFETY_LIMIT';return false;}
   if(ctx.providerUsed()-started>=ctx.providerAllowance){reason='FAIRNESS_RESERVE';return false;}
   if(candidates>=selectedFallbackPolicy.maxProviderCandidates||!ctx.claimFallback!())return false;
   candidates++;selectedFallbackEvent('fallbackProviderCandidates');
   if(cached)selectedFallbackEvent('negativeRefreshAttempts');
   ctx.diagnosticProbe?.(edge,cached?'NEGATIVE_REFRESH':'COMPLEMENTARY_ENDPOINT_PROBE',true);
   const check=cached?await ctx.refreshNegative!(edge,selectedFallbackPolicy.minimumNegativeAgeMs):await ctx.check(edge);checks++;
   if(!check){reason=ctx.providerRemaining()<=0?'PROVIDER_BUDGET_EXHAUSTED':'LOGICAL_SAFETY_LIMIT';return false;}
   remember(edge,check);stations.add(edge.a);stations.add(edge.b);classes.add(edge.c);
   if(['AVAILABLE','RAC','WAITLIST','UNAVAILABLE'].includes(check.status))valid.add(id);
   if(check.errorCategory==='PROVIDER_BUDGET_EXHAUSTED'){reason='PROVIDER_BUDGET_EXHAUSTED';return false;}
   if(check.errorCategory==='RATE_LIMITED'){reason='PROVIDER_RATE_LIMIT';return false;}
   if(check.status==='PROVIDER_ERROR'){reason='PROVIDER_UNAVAILABLE';return false;}
   if(check.status==='AVAILABLE'||check.status==='RAC')updateQuality(ctx.solve());
   return !quality.full;
  };
  let continuing=true;
  for(const k of stops){
   const classes=ctx.classes.filter(c=>!unsupported.has(c)&&!ctx.unsupportedClass?.(c)).sort((a,b)=>Number(usable({a:0,b:k,c:b})||usable({a:k,b:last,c:b}))-Number(usable({a:0,b:k,c:a})||usable({a:k,b:last,c:a}))).slice(0,selectedFallbackPolicy.maxClassesPerStop);
   for(const c of classes){
    if(!await probe({a:0,b:k,c})||!await probe({a:k,b:last,c})){continuing=false;break;}
   }
   if(!continuing)break;
  }
  // With no internal stop (or only recent split evidence), the whole-leg
  // negative is still a strategic exact candidate, under the same shared cap.
  if(continuing&&!quality.full)for(const c of ctx.classes.filter(c=>!unsupported.has(c)&&!ctx.unsupportedClass?.(c)).slice(0,selectedFallbackPolicy.maxClassesPerStop))if(!await probe({a:0,b:last,c}))break;
  quality=ctx.solve();
  if(quality.full){reason='SUFFICIENT_HIGH_QUALITY_RESULTS';selectedFallbackEvent('fullCoverageAfterFallback');}
  else reason??='BOUNDED_FALLBACK_COMPLETE';
 }
 // Full coverage ends general exploration. Only exact unions of consecutive
 // same-class tickets may bypass ALREADY_COVERED here; never infer through seats.
 // Eight candidates total bounds cache work as well as new provider attempts.
 const consolidationSeen=new Set<string>();
 for(let attempts=0;quality.full&&attempts<8;attempts++){
  const parts=quality.reservationParts;
  if(!parts||parts.length<2)break;
  let edge:EvidenceEdge|undefined;
  for(let i=0;i<parts.length-1&&!edge;i++){
   let end=i;
   while(end+1<parts.length&&parts[end].b===parts[end+1].a&&parts[i].c===parts[end+1].c)end++;
   // Try the largest union first, then the adjacent pair. Re-solving after a
   // successful merge exposes further unions without an all-pairs matrix.
   for(const j of [end,i+1]){
    if(j>end||j===i)continue;
    const candidate={a:parts[i].a,b:parts[j].b,c:parts[i].c};
    if(!consolidationSeen.has(edgeKey(candidate))){edge=candidate;break;}
   }
  }
  if(!edge)break;
  consolidationSeen.add(edgeKey(edge));ctx.active();
  if(ctx.remainingTime()<=0){reason='DEADLINE';break;}
  let hit=await ctx.cached?.(edge)??ctx.known(edge);
  if(!hit){
   if(unsupported.has(edge.c)||ctx.unsupportedClass?.(edge.c))continue;
   if(checks>=ctx.logicalAllowance){reason='LOGICAL_SAFETY_LIMIT';break;}
   if(ctx.providerRemaining()<=0){reason='PROVIDER_BUDGET_EXHAUSTED';break;}
   if(ctx.providerUsed()-started>=ctx.providerAllowance){reason='FAIRNESS_RESERVE';break;}
   ctx.diagnosticProbe?.(edge,'TICKET_CONSOLIDATION',true);
   hit=await ctx.check(edge);checks++;
  }
  if(!hit){reason=ctx.providerRemaining()<=0?'PROVIDER_BUDGET_EXHAUSTED':'LOGICAL_SAFETY_LIMIT';break;}
  remember(edge,hit);
  if(['AVAILABLE','RAC','WAITLIST','UNAVAILABLE'].includes(hit.status))valid.add(edgeKey(edge));
  if(hit.errorCategory==='RATE_LIMITED'){reason='PROVIDER_RATE_LIMIT';break;}
  if(hit.errorCategory==='PROVIDER_BUDGET_EXHAUSTED'){reason='PROVIDER_BUDGET_EXHAUSTED';break;}
  quality=ctx.solve();
 }
 selectedBoundedBreadth({boundedUniquePairsFreshlyCovered:[...boundedPairs.values()].filter(pairFresh).length,
  boundedAdjacentPairsTotal:adjacentPairs.size,boundedAdjacentPairsFreshlyCovered:[...adjacentPairs.values()].filter(pairFresh).length,
  boundedAdjacentPriorityProbes:adjacentPriorityProbes,boundedClassDepthProbes:classDepthProbes});
 for(const {edge,record} of progress)if(!record.scheduledFurtherRefinement){
  record.refinementSkipReason=reason??(unsupported.has(edge.c)?'UNSUPPORTED_CLASS':edge.b-edge.a===1?'NO_INTERNAL_STATIONS':'NO_UNEXPLORED_SMALLER_STRATEGIC_CANDIDATES');
 }
 selectedSearchStopped(reason??'SCOPE_EXHAUSTED');
 const possibleMatrixEdges=(ctx.scopeNodes??ctx.nodes)*((ctx.scopeNodes??ctx.nodes)-1)/2*ctx.classes.length;
 return {searchMode:'ADAPTIVE_GRAPH',possibleMatrixEdges,checkedMatrixEdges:valid.size,matrixCoverage:possibleMatrixEdges?100*valid.size/possibleMatrixEdges:100,
  stationsExplored:stations.size,classesExplored:classes.size,fullPathsFound:quality.full,partialPathsFound:quality.partial,
  stopReason:reason??'SCOPE_EXHAUSTED'};
}
