import {Session as InspectorSession} from 'node:inspector';
import {performance} from 'node:perf_hooks';
import {RailwayDatabase} from '../../local-railway/database.js';
import type {LocalDataset} from '../../local-railway/types.js';
import {LocalJourneyPlannerV2} from '../../local-railway/planner/v2/planner.js';
import {JourneyRecoveryOrchestrator} from '../../journey/availability/journey/orchestrator.js';
import {intervalPaths,type IntervalEdge} from '../../journey/availability/recovery/paths.js';
import {evidenceSearchPolicy} from '../../journey/availability/recovery/evidence-search.js';
import type {TravelClass} from '../../journey/types/journey-segment.js';
import {invokeAvailabilityProvider} from '../../providers/availability-provider-budget.js';
import {AvailabilityScheduler} from '../../providers/railkit/availability-scheduler.js';
import {availabilityFailure,normalizeAvailability} from '../../providers/railkit/railkit-normalizers.js';
import {AvailabilityObservations} from '../../providers/observations/cache.js';
import {AvailabilityFreshnessPolicy} from '../../providers/observations/freshness.js';
import {SqliteAvailabilityObservationStore} from '../../providers/observations/sqlite-store.js';
import {RedisAvailabilityCache,type AvailabilityRedisAdapter} from '../../providers/observations/redis-cache.js';
import {makeObservation,observationMetadata} from '../../providers/observations/model.js';
import {availabilityStateConfig} from '../../config/availability-state.js';
import {hardeningConfig} from '../../config/hardening.js';
import type {AvailabilityRequest,AvailabilityResult} from '../../domain/types/availability.js';

export const fiveClasses:TravelClass[]=['SL','3A','2A','CC','2S'];
export const evaluationDate='18-09-2099';
export type Inventory='AVAILABLE'|'RAC'|'WAITLIST'|'NOT_AVAILABLE';
export type Edge={train:number;a:number;b:number;c:TravelClass};
export interface Scenario {
 id:string;group:string;nodes:number;routeNodes?:string[];classes?:TravelClass[];sizes?:number[];order?:number[];
 /** Keep historical measurements frozen by default; later-phase fixtures opt in. */
 balancedFairness?:boolean;candidateRevisit?:boolean;budget?:number;logicalLimit?:number;candidateLogicalLimit?:number;requestedClasses?:string[];
 warmPercent?:number;warmEdge?:(edge:Edge)=>boolean;cacheLayer?:'hot'|'redis'|'persistent'|'mixed';
 inventory?:(edge:Edge)=>Inventory;deadlineMs?:number;attemptMs?:number;
 failure?:'rate'|'unavailable'|'individual';failureAt?:number;
}
type Trace={edge:Edge;request:AvailabilityRequest;result:AvailabilityResult;calls:number;time:number};
// Transport-only fake. The production Redis cache still validates identity, freshness and promotion.
class MemoryRedis implements AvailabilityRedisAdapter {
 private values=new Map<string,{value:string;observedAt:number;expiresAt:number}>();
 constructor(private now:()=>number){}
 async get(key:string,signal:AbortSignal){signal.throwIfAborted();const v=this.values.get(key);return v&&v.expiresAt>this.now()?v.value:null;}
 async putIfNewer(key:string,value:string,observedAt:number,expiresAt:number,signal:AbortSignal){signal.throwIfAborted();const old=this.values.get(key);if(!old||old.observedAt<observedAt)this.values.set(key,{value,observedAt,expiresAt});}
 close(){this.values.clear();}
}
const edgeKey=(e:Edge)=>`${e.train}:${e.a}:${e.b}:${e.c}`;
// Stable seeded ordering, with an exact rounded population size rather than independent random draws.
function hash(value:string){let h=2166136261;for(const c of 'phase4-seed-1:'+value){h^=c.charCodeAt(0);h=Math.imul(h,16777619);}return h>>>0;}
function envelope(r:AvailabilityRequest,state:Inventory){return {success:true,data:{availability:[{date:r.journeyDate,status:state,availabilityText:state==='AVAILABLE'?'AVAILABLE 20':state==='RAC'?'RAC 3':state==='WAITLIST'?'WL 12':'NOT AVAILABLE'}]}};}

/** In-process V8 coverage counts production solver calls; no inspector socket or source patches. */
async function profile(){
 const inspector=new InspectorSession();inspector.connect();
 const post=(method:string,params={})=>new Promise<unknown>((resolve,reject)=>inspector.post(method,params,(error,result)=>error?reject(error):resolve(result)));
 await post('Profiler.enable');await post('Debugger.enable');await post('Profiler.startPreciseCoverage',{callCount:true,detailed:true});
 return {async finish(){try{
  const data=await post('Profiler.takePreciseCoverage') as {result:{scriptId:string;url:string;functions:{functionName:string;ranges:{count:number;startOffset:number;endOffset:number}[]}[]}[]};
  const count=(file:string,name:string)=>data.result.filter(s=>s.url.replaceAll('\\','/').endsWith(file)).flatMap(s=>s.functions).filter(f=>f.functionName===name).reduce((n,f)=>n+(f.ranges[0]?.count??0),0);
  let frontierAddAttempts=0;
  for(const script of data.result.filter(s=>s.url.replaceAll('\\','/').endsWith('/recovery/evidence-search.ts'))){
   const {scriptSource}=await post('Debugger.getScriptSource',{scriptId:script.scriptId}) as {scriptSource:string};
   const add=script.functions.filter(f=>scriptSource.slice(f.ranges[0].startOffset,f.ranges[0].endOffset).includes('frontier.set(')).sort((a,b)=>(a.ranges[0].endOffset-a.ranges[0].startOffset)-(b.ranges[0].endOffset-b.ranges[0].startOffset))[0];
   frontierAddAttempts+=add?.ranges[0].count??0;
  }
  return {solverInvocations:count('/recovery/paths.ts','intervalPaths'),frontierAddAttempts,matrixIteratorEntries:count('/recovery/evidence-search.ts','matrix')};
 }finally{await post('Profiler.stopPreciseCoverage');inspector.disconnect();}}};
}

export async function evaluateScenario(s:Scenario){
 const classes=s.classes??fiveClasses,sizes=s.sizes??[s.nodes],order=s.order??sizes.map((_,i)=>i);
 if(order.length!==sizes.length||new Set(order).size!==sizes.length||order.some(i=>i<0||i>=sizes.length))throw Error('Invalid train permutation');
 const codes=s.routeNodes??Array.from({length:s.nodes},(_,i)=>i===0?'A':i===s.nodes-1?'B':`S${i}`);
 if(codes.length!==s.nodes||new Set(codes).size!==codes.length)throw Error('Invalid ordered route nodes');
 const source=codes[0],destination=codes.at(-1)!;
 const routes=sizes.map(n=>codes.filter((_,i)=>i<n-1||i===s.nodes-1));
 const db=new RailwayDatabase(':memory:');
 let now=Date.UTC(2099,8,1),calls=0;const start=now,clock=()=>now;
 const store=new SqliteAvailabilityObservationStore({...availabilityStateConfig({}),path:':memory:'},clock);
 const policy=new AvailabilityFreshnessPolicy(),redis=new RedisAvailabilityCache(new MemoryRedis(clock));
 const observations=new AvailabilityObservations(store,policy,redis);
 const scheduler=new AvailabilityScheduler({...hardeningConfig({}),burst:10000,monthly:100000,providerCacheEntries:10000},clock,observations);
 let profiler:Awaited<ReturnType<typeof profile>>|undefined;
 try{
  const trains:LocalDataset['trains']=sizes.map((_,i)=>({number:String(43001+i),name:`Evaluation ${i}`,sourceCode:source,destinationCode:destination,runningDaysRaw:'Daily',runningDays:['MON','TUE','WED','THU','FRI','SAT','SUN']}));
  const stops=trains.flatMap((train,i)=>routes[i].map((stationCode,j)=>{const index=codes.indexOf(stationCode),minutes=360+index*20,time=String(Math.floor(minutes/60)%24).padStart(2,'0')+':'+String(minutes%60).padStart(2,'0');return {trainNumber:train.number,stationCode,sequence:j+1,dayOffset:Math.floor(minutes/1440),arrivalTime:j?time:undefined,departureTime:j<routes[i].length-1?time:undefined,distanceKm:index*100};}));
  db.replace({stations:codes.map(code=>({code,name:code})),trains,stops,metadata:{source:'RAILPULL_NTES',importedAt:'2099-09-01T00:00:00Z',trainCount:trains.length,stationCount:codes.length,stopCount:stops.length}});
  const planned=new LocalJourneyPlannerV2(db,{},true).search({from:source,to:destination,date:evaluationDate});
  const candidates=order.map(i=>{const candidate=planned.journeys.find(j=>j.segments.length===1&&j.segments[0].trainNumber===trains[i].number);if(!candidate)throw Error('Fixture train absent from actual V2 planner');return candidate;});
  const request=(e:Edge):AvailabilityRequest=>({trainNumber:trains[e.train].number,fromStationCode:codes[e.a],toStationCode:codes[e.b],journeyDate:evaluationDate,travelClass:e.c,quota:'GN'});
  const inventory=(e:Edge)=>s.inventory?.(e)??'WAITLIST';
  const scope:Edge[]=routes.flatMap((route,train)=>route.flatMap((from,a)=>route.slice(a+1).flatMap(to=>classes.map(c=>({train,a:codes.indexOf(from),b:codes.indexOf(to),c})))));
  const sorted=[...scope].sort((a,b)=>hash(edgeKey(a))-hash(edgeKey(b))||edgeKey(a).localeCompare(edgeKey(b)));
  const warm=new Set(sorted.slice(0,Math.round(scope.length*(s.warmPercent??0)/100)).map(edgeKey));
  for(const e of scope)if(s.warmEdge?.(e))warm.add(edgeKey(e));
  const seeds={hot:0,redis:0,persistent:0};let index=0;
  for(const e of scope){if(!warm.has(edgeKey(e)))continue;const r=request(e),raw=envelope(r,inventory(e)),o=makeObservation(normalizeAvailability(raw,r),now);
   const tier=s.cacheLayer&&s.cacheLayer!=='mixed'?s.cacheLayer:(['hot','redis','persistent'] as const)[index++%3];seeds[tier]++;
   if(tier==='hot')await scheduler.execute(r,async()=>raw);
   else if(tier==='redis')await redis.remember(o,policy,clock);
   else store.upsertLatest(o);
  }
  const trace:Trace[]=[];
  const provider={providerCallAccounting:'SCOPED' as const,currentTimeMs:clock,remainingTimeMs:()=> (s.deadlineMs??90000)-(now-start),
   async getAvailability(r:AvailabilityRequest):Promise<AvailabilityResult>{
    const e:Edge={train:Number(r.trainNumber)-43001,a:codes.indexOf(r.fromStationCode),b:codes.indexOf(r.toStationCode),c:r.travelClass as TravelClass};
    let result:AvailabilityResult;
    try{
     const raw=await scheduler.execute(r,()=>invokeAvailabilityProvider(()=>scheduler.quota.consume(),async()=>{
      calls++;now+=s.attemptMs??1;
      if(s.failure&&calls>=(s.failureAt??8)&&(s.failure!=='individual'||calls===(s.failureAt??8))){
       // Normal provider failure envelopes exercise the real failure normalizer/cache exclusion.
       return {success:false,error:s.failure==='rate'?'Rate limit exceeded':'Service unavailable',status:s.failure==='rate'?429:503};
      }
      return envelope(r,inventory(e));
     }));
     result=normalizeAvailability(raw,r);const observation=observationMetadata(raw);if(observation)result={...result,observation};
    }catch(error){result=availabilityFailure(r,error);}
    trace.push({edge:e,request:r,result,calls,time:now});return result;
   }};
  profiler=await profile();const began=performance.now(),heap=process.memoryUsage().heapUsed;
  const result=await new JourneyRecoveryOrchestrator(db,provider,{balancedFairness:s.balancedFairness??false,candidateRevisit:s.candidateRevisit??false,providerCallBudgetLimit:s.budget??300,budgetLimit:s.logicalLimit,maxRecoveryRequestsPerCandidate:s.candidateLogicalLimit}).validate({source,destination,journeyDate:evaluationDate,requestedClasses:s.requestedClasses??['ALL'],plannerCandidates:candidates,plannerDiagnostics:planned.diagnostics,supportedClassesByTrain:Object.fromEntries(trains.map(t=>[t.number,classes]))});
  const elapsedMs=performance.now()-began,heapDeltaBytes=process.memoryUsage().heapUsed-heap;
  const structural=await profiler.finish();profiler=undefined;
  // Replay evidence into the SAME bounded production DAG solver after profiling.
  // These milestones mean evidence became sufficient, not that the scheduler had solved/ranked it yet.
  const edges=sizes.map(()=>new Map<string,IntervalEdge>()),fullTrains=new Set<number>();let first:number|null=null,fifth:number|null=null;
  for(const item of trace){const {edge:e,result:r}=item,day=r.days.find(d=>d.date===evaluationDate);
   if(r.providerState!=='SUCCESS'||!day||!['AVAILABLE','RAC'].includes(day.state)||day.canBook===false)continue;
   const route=routes[e.train],from=route.indexOf(codes[e.a]),to=route.indexOf(codes[e.b]),status=day.state as 'AVAILABLE'|'RAC';
   const part={fromStation:codes[e.a],toStation:codes[e.b],departureDateTime:'2099-09-18T06:00:00',arrivalDateTime:'2099-09-18T16:00:00',boardingDate:evaluationDate,distanceKm:(e.b-e.a)*100,availabilityStatus:status};
   edges[e.train].set(edgeKey(e),{from,to,segment:{...part,type:'RESERVED',trainNumber:item.request.trainNumber,selectedClass:e.c,quota:'GN',reservationParts:[part]}});
   const nodes=route.map(code=>({code,distance:codes.indexOf(code)*100})),all=[...edges[e.train].values()];
   const batches=s.requestedClasses&&!s.requestedClasses.includes('ALL')?s.requestedClasses.map(c=>all.filter(x=>x.segment.selectedClass===c)):[all];
   if(batches.some(batch=>intervalPaths(nodes,batch,64,()=>{}).some(p=>p.reserved===(s.nodes-1)*100))){fullTrains.add(e.train);first??=item.calls;if(fullTrains.size>=5)fifth??=item.calls;}
  }
  const d=result.diagnostics,cacheHits=d.hotCacheHits+d.redisCacheHits+d.persistentCacheHits;
  return {id:s.id,group:s.group,nodes:s.nodes,sizes,classes,order,seeds,seededEdges:warm.size,diagnostics:d,
   actualProviderCalls:calls,providerCallsPerFullPath:d.fullPathsFound?calls/d.fullPathsFound:null,
   providerCallsUntilFirstFullPath:first,providerCallsUntilBestFiveWhereMeasurable:fifth,
   callsAfterFirstFull:first===null?null:calls-first,callsAfterFifthFull:fifth===null?null:calls-fifth,
   cacheReuseRatio:d.logicalAvailabilityChecks?cacheHits/d.logicalAvailabilityChecks:0,
   coveragePerProviderCall:calls?d.checkedMatrixEdges/calls:null,
   fullJourneys:result.journeys.filter(j=>j.reservedCoverageRatio===1).length,
   partialJourneys:result.journeys.filter(j=>j.reservedCoverageRatio>0&&j.reservedCoverageRatio<1).length,
   structural:{...structural,generatedIntervals:d.directExploration.reduce((n,p)=>n+p.intervalsGenerated,0),requestedClassEdges:new Set(trace.map(t=>edgeKey(t.edge))).size,frontierSizeUpperBound:evidenceSearchPolicy.frontierSize,solverStatesPerNodeLimit:64,elapsedMs,heapDeltaBytes},
   journeys:result.journeys.map(j=>({train:Number(j.legs[0].trainNumber)-43001,coverage:j.reservedCoverageRatio,unknownKm:j.unknownDistanceKm,status:j.journeyStatus,classChanges:j.classChanges,segments:j.legs.flatMap(l=>l.segments)})),trace};
 }finally{if(profiler)await profiler.finish();observations.close();db.close();}
}
export type EvaluationResult=Awaited<ReturnType<typeof evaluateScenario>>;
