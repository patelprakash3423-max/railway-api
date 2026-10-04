import {SelectedAvailabilityTrace,withSelectedAvailabilityTrace,finishSelectedDiagnostics} from '../../journey/availability/selected-diagnostics.js';
import {searchSelectedEvidence} from '../../journey/availability/recovery/selected-evidence.js';
import {AvailabilitySession} from '../../journey/availability/session.js';
import {AvailabilityProviderBudget} from '../../providers/availability-provider-budget.js';
import {makeObservation} from '../../providers/observations/model.js';
import {RedisAvailabilityCache} from '../../providers/observations/redis-cache.js';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {RailwayDatabase} from '../database.js';
import {JourneyV2ApiService} from '../../api/services/journey-v2-service.js';
import {hardeningConfig} from '../../config/hardening.js';
import {availabilityStateConfig} from '../../config/availability-state.js';
import {AvailabilityScheduler} from '../../providers/railkit/availability-scheduler.js';
import {normalizeAvailability} from '../../providers/railkit/railkit-normalizers.js';
import {observationMetadata} from '../../providers/observations/model.js';
import {AvailabilityObservations} from '../../providers/observations/cache.js';
import {SqliteAvailabilityObservationStore} from '../../providers/observations/sqlite-store.js';
import {invokeAvailabilityProvider} from '../../providers/availability-provider-budget.js';
import {availabilityRequestKey} from '../../utils/availability-key.js';
import type {AvailabilityRequest} from '../../domain/types/availability.js';
import {rankSelectedPath,type Path} from '../../journey/availability/recovery/paths.js';

const date='18-09-2099',now=()=>Date.UTC(2099,8,1);
type Rule=(r:AvailabilityRequest)=>'AVAILABLE'|'WAITLIST'|'NOT_AVAILABLE'|'UNKNOWN'|'UNSUPPORTED_CLASS';
function fixture(t:TestContext,rule:Rule=()=> 'WAITLIST',codes=['SV','GKP','LKO','CNB','NDLS'],limit:number=40,useRedis=false,distances?:readonly number[],minutes?:readonly number[]){
 const db=new RailwayDatabase(':memory:');t.after(()=>db.close());
 const trains=['15565','15566'].map(number=>({number,name:'VAISHALI FIXTURE',sourceCode:codes[0],destinationCode:codes.at(-1)!,runningDaysRaw:'Daily',runningDays:['MON','TUE','WED','THU','FRI','SAT','SUN'] as const}));
 db.replace({stations:codes.map(code=>({code,name:code})),trains:trains.map(x=>({...x,runningDays:[...x.runningDays]})),stops:trains.flatMap(train=>codes.map((stationCode,i)=>{
  const m=minutes?.[i]??360+i*20,time=`${String(Math.floor(m/60)%24).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
  return {trainNumber:train.number,stationCode,sequence:i+1,dayOffset:Math.floor(m/1440),arrivalTime:i?time:undefined,departureTime:i<codes.length-1?time:undefined,distanceKm:distances?.[i]??i*100};
 })),metadata:{source:'RAILPULL_NTES',importedAt:'2099-09-01T00:00:00Z',trainCount:2,stationCount:codes.length,stopCount:2*codes.length}});
 const store=new SqliteAvailabilityObservationStore({...availabilityStateConfig({}),path:':memory:'},now);t.after(()=>store.close());
 const redisValues=new Map<string,string>();
 const redis=new RedisAvailabilityCache({get:async key=>redisValues.get(key)??null,putIfNewer:async(key,value)=>{redisValues.set(key,value);},close(){}});
 const observations=new AvailabilityObservations(store,undefined,useRedis?redis:undefined),calls:AvailabilityRequest[]=[];
 const config={...hardeningConfig({}),burst:10000,monthly:100000};
 const create=(burst=config.burst,globalLimit?:number)=>{
  const scheduler=new AvailabilityScheduler({...config,burst},now,observations);
  return new JourneyV2ApiService(db,{providerCallAccounting:'SCOPED',currentTimeMs:now,getCachedAvailability:async r=>{const raw=await scheduler.lookupCached(r);return raw===undefined?undefined:{...normalizeAvailability(raw,r),observation:observationMetadata(raw)};},getAvailability:async r=>{
   const raw=await scheduler.execute(r,()=>invokeAvailabilityProvider(()=>scheduler.quota.consume(),async()=>{
    calls.push({...r});const status=rule(r);
    return status==='UNSUPPORTED_CLASS'?{success:false,error:'Class does not exist in this train for this train route',transportEvidence:{statusCode:400,failureCategory:'UNSUPPORTED_CLASS'}}:{success:true,data:{availability:[{date:r.journeyDate,status}]}};
   }));
   return {...normalizeAvailability(raw,r),observation:observationMetadata(raw)};
  }},{diagnostics:true,...(globalLimit?{providerCallBudgetLimit:globalLimit}:{}),...(limit?{selectedRouteProviderCallBudgetLimit:limit}:{})});
 };
 const input={from:codes[0],to:codes.at(-1)!,date,classes:['SL','3A','2A']};
 const service=create();
 const check=async(s=service)=>{const route=(await s.search(input)).results.find(j=>j.legs[0].trainNumber==='15565')!;return s.checkAvailability({...input,routeId:route.id});};
 const seed=(fromStationCode:string,toStationCode:string,travelClass:string,state='AVAILABLE',observedAt=now())=>{
  const request={trainNumber:'15565',fromStationCode,toStationCode,journeyDate:date,travelClass,quota:'GN' as const};
  store.upsertLatest(makeObservation(normalizeAvailability({success:true,data:{availability:[{date,status:state}]}},request),observedAt));
 };
 return {service,input,check,calls,create,store,seed};
}

test('selected full-leg availability is found without probing intermediate stations',async t=>{
 const h=fixture(t,()=> 'AVAILABLE'),r=await h.check();
 assert.equal(r.results[0].reservedCoverageRatio,1);assert.ok(h.calls.every(x=>x.fromStationCode==='SV'&&x.toStationCode==='NDLS'));
});
test('15565 mixed segments compose full coverage using explicitly requested classes',async t=>{
 const h=fixture(t,r=>r.fromStationCode==='SV'&&r.toStationCode==='GKP'&&r.travelClass==='3A'||r.fromStationCode==='GKP'&&r.toStationCode==='LKO'&&r.travelClass==='SL'||r.fromStationCode==='LKO'&&r.toStationCode==='NDLS'&&r.travelClass==='2A'?'AVAILABLE':'WAITLIST');
 const result=await h.check(),j=result.results[0];
 assert.equal(j.reservedCoverageRatio,1);assert.equal(j.classChanges,2);
 assert.deepEqual(j.legs[0].segments.map(s=>s.type==='RESERVED'?[s.fromStation,s.toStation,s.selectedClass]:[]),[['SV','GKP','3A'],['GKP','LKO','SL'],['LKO','NDLS','2A']]);
 assert.ok(h.calls.length<=40);assert.equal(new Set(h.calls.map(availabilityRequestKey)).size,h.calls.length);
 assert.ok(h.calls.every(r=>r.trainNumber==='15565'&&h.input.classes.includes(r.travelClass)));
 const used=h.calls.length;
 const again=await h.check(h.create()); // Cold scheduler: reuse SQLite, not just hot/session cache.
 assert.equal(again.results[0].reservedCoverageRatio,1);assert.equal(h.calls.length,used);assert.equal(again.diagnostics!.providerAvailabilityCalls,0);assert.ok(again.diagnostics!.persistentCacheHits>0);
});
test('one AVAILABLE prefix is retained while unsuccessful suffix exploration continues',async t=>{
 const h=fixture(t,r=>r.fromStationCode==='SV'&&r.toStationCode==='GKP'?'AVAILABLE':'WAITLIST');
 const r=await h.check();assert.ok(r.results[0].legs[0].segments.some(s=>s.type==='RESERVED'&&s.toStation==='GKP'));
 const prefix=h.calls.findIndex(r=>r.fromStationCode==='SV'&&r.toStationCode==='GKP');
 assert.equal(h.calls[prefix+1].fromStationCode,'GKP');assert.equal(h.calls[prefix+1].toStationCode,'NDLS');
 assert.ok(h.calls.slice(prefix+1).some(r=>r.fromStationCode==='GKP'&&r.toStationCode!=='NDLS'));assert.ok(r.results[0].reservedCoverageRatio<1);
});
test('explicit benchmark budget is 40; a later cold check resumes with new probes and no repeated fresh live calls',async t=>{
 const codes=['SV',...Array.from({length:18},(_,i)=>`S${i}`),'NDLS'];
 const h=fixture(t,undefined,codes),first=await h.check();
 assert.equal(first.diagnostics!.providerCallBudgetLimit,40);assert.equal(h.calls.length,40);
 const second=await h.check(h.create());assert.equal(second.diagnostics!.providerAvailabilityCalls,40);assert.equal(h.calls.length,80);
 assert.equal(new Set(h.calls.map(availabilityRequestKey)).size,80);assert.ok(second.diagnostics!.persistentCacheHits>=40);
});
test('configured selected-route budget and global provider quota both remain enforced',async t=>{
 const h=fixture(t,undefined,undefined,5),r=await h.check();assert.equal(h.calls.length,5);assert.equal(r.diagnostics!.providerCallBudgetLimit,5);
 const limited=fixture(t,undefined,undefined,40),q=await limited.check(limited.create(2));assert.equal(limited.calls.length,2);assert.ok(q.diagnostics!.providerRateLimited>0);
});
test('selected budget configuration is validated independently of the global ceiling',()=>{
 assert.equal(hardeningConfig({}).selectedRouteProviderCallBudgetLimit,undefined);
 assert.equal(hardeningConfig({SELECTED_ROUTE_AVAILABILITY_PROVIDER_CALL_LIMIT:'50'}).selectedRouteProviderCallBudgetLimit,50);
 for(const value of ['0','501','NaN','1.5'])assert.throws(()=>hardeningConfig({SELECTED_ROUTE_AVAILABILITY_PROVIDER_CALL_LIMIT:value}));
});
test('normal discovery still makes zero availability calls and returns both local trains',async t=>{
 const h=fixture(t),r=await h.service.search(h.input);assert.equal(r.results.length,2);assert.equal(h.calls.length,0);assert.ok(r.results.every(j=>j.status==='NOT_CHECKED'));
});
test('selected composition prioritizes fewer real reservation tickets before class changes',()=>{
 const path=(tickets:number,changes:number):Path=>({segments:[{type:'RESERVED',reservationParts:Array.from({length:tickets},()=>({})),selectedClass:'SL'}] as Path['segments'],reserved:100,racDistance:0,changes,lastClass:'SL',fragments:1,knownFare:0,missingFares:tickets});
 assert.ok(rankSelectedPath(path(2,1),path(3,0))<0);
});

test('cache-only preflight composes fresh split observations before spending any new live calls',async t=>{
 const h=fixture(t);
 for(const c of h.input.classes)h.seed('SV','NDLS',c,'WAITLIST');
 h.seed('SV','LKO','3A');h.seed('LKO','NDLS','2A');
 const r=await h.check();assert.equal(r.results[0].reservedCoverageRatio,1);assert.equal(h.calls.length,0);
 assert.ok(r.diagnostics!.persistentCacheHits>=5);
});
test('Redis reuse and SQLite fallback preserve selected-route evidence without duplicate live probes',async t=>{
 const h=fixture(t,r=>r.toStationCode==='GKP'||r.fromStationCode==='GKP'?'AVAILABLE':'WAITLIST',undefined,undefined,true);
 const first=await h.check();assert.equal(first.results[0].reservedCoverageRatio,1);const used=h.calls.length;
 const second=await h.check(h.create());assert.equal(h.calls.length,used);assert.equal(second.results[0].reservedCoverageRatio,1);assert.ok(second.diagnostics!.redisCacheHits>0);
});
test('stale observations never establish selected coverage and are refreshed through the provider budget',async t=>{
 const h=fixture(t);h.seed('SV','LKO','SL','AVAILABLE',now()-24*3600000);
 const r=await h.check();assert.equal(r.results[0].reservedCoverageRatio,0);assert.ok(h.calls.some(r=>r.fromStationCode==='SV'&&r.toStationCode==='LKO'&&r.travelClass==='SL'));
 assert.ok(r.diagnostics!.persistentCacheStale>0);
});

test('unknown full-leg evidence is refined rather than treated as unavailable',async t=>{
 const h=fixture(t,r=>r.fromStationCode==='SV'&&r.toStationCode==='NDLS'?'UNKNOWN':r.toStationCode==='GKP'||r.fromStationCode==='GKP'?'AVAILABLE':'WAITLIST');
 const result=await h.check();assert.equal(result.results[0].reservedCoverageRatio,1);assert.ok(h.calls.some(r=>r.fromStationCode==='GKP'));
});

test('selected diagnostics explain exhausted budget and retain the unknown tail',async t=>{
 const h=fixture(t,r=>r.fromStationCode==='SV'&&r.toStationCode==='GKP'||r.fromStationCode==='GKP'&&r.toStationCode==='KLD'?'AVAILABLE':'WAITLIST',['SV','GKP','KLD','LKO','CNB','NDLS'],16);
 const r=await h.check(),d=r.diagnostics!.selectedRoute!;
 assert.equal(d.configuredSelectedRouteProviderCallLimit,16);
 assert.equal(d.newProviderCallsUsed,h.calls.length);
 assert.equal(d.finalSearchStopReason,'SELECTED_ROUTE_BUDGET_EXHAUSTED');
 assert.equal(d.budgetRemaining,0);assert.equal(d.selectedRouteBudgetBlocked,true);assert.equal(d.globalProviderQuotaBlocked,false);
 assert.deepEqual(d.uncoveredRanges.map(g=>[g.fromStation,g.toStation,g.status]),[['KLD','NDLS','UNKNOWN']]);
 assert.ok(d.trace.some(p=>p.from==='SV'&&p.to==='GKP'&&p.causedFurtherExpansion));
 assert.ok(d.trace.some(p=>p.action==='SKIPPED'&&p.reason==='PROVIDER_BUDGET_EXHAUSTED'));
 assert.equal(d.totalProbesConsidered,d.totalProbesExecuted+Object.values(d.probesSkipped).reduce((a,b)=>a+b,0));
 assert.ok(d.trace.every(p=>p.trainNumber==='15565'&&p.quota==='GN'&&h.input.classes.includes(p.travelClass)));
});

test('selected diagnostics distinguish quota rejection, exhaustion, and cold persisted reuse',async t=>{
 const quota=fixture(t),q=(await quota.check(quota.create(2))).diagnostics!.selectedRoute!;
 assert.equal(q.finalSearchStopReason,'GLOBAL_PROVIDER_LIMIT_REACHED');assert.equal(q.globalProviderQuotaBlocked,true);assert.ok(q.budgetRemaining>0);
 const exhausted=fixture(t,undefined,['SV','NDLS']),e=(await exhausted.check()).diagnostics!.selectedRoute!;
 assert.equal(e.finalSearchStopReason,'NO_USEFUL_PROBES_REMAINING');assert.ok(e.budgetRemaining>0);
 const cached=fixture(t,()=> 'AVAILABLE');await cached.check();const c=(await cached.check(cached.create())).diagnostics!.selectedRoute!;
 assert.equal(c.finalSearchStopReason,'FULL_COVERAGE_FOUND');assert.equal(c.newProviderCallsUsed,0);assert.ok(c.persistedObservationHits>0);assert.ok(c.freshObservationHits>0);assert.deepEqual(c.uncoveredRanges,[]);
 assert.ok(c.trace.some(p=>p.source==='PERSISTED'&&p.status==='AVAILABLE'));
});

test('selected trace stays bounded while duplicate and aggregate counters remain exact',async t=>{
 const h=fixture(t,undefined,['SV',...Array.from({length:18},(_,i)=>`S${i}`),'NDLS']);
 await h.check();await h.check(h.create());const r=await h.check(h.create()),d=r.diagnostics!.selectedRoute!;
 assert.equal(d.traceLimit,120);assert.ok(d.trace.length<=120);assert.ok(d.traceEntriesDropped>0);
 assert.ok(d.duplicateProbesAvoided>0);assert.ok(d.totalProbesExecuted>d.trace.length);
});

test('lower global provider ceiling is not mislabeled as selected-route exhaustion',async t=>{
 const h=fixture(t,undefined,undefined,40),r=await h.check(h.create(10000,3)),d=r.diagnostics!.selectedRoute!;
 assert.equal(d.configuredSelectedRouteProviderCallLimit,40);assert.equal(d.configuredGlobalProviderCallLimit,3);assert.equal(d.newProviderCallsUsed,3);
 assert.equal(d.finalSearchStopReason,'GLOBAL_PROVIDER_LIMIT_REACHED');assert.equal(d.globalProviderQuotaBlocked,true);assert.equal(d.selectedRouteBudgetBlocked,false);assert.equal(d.selectedRouteBudgetRemaining,37);
});

test('logical search safety stop retains its underlying reason without claiming provider exhaustion',async()=>{
 const trace=new SelectedAvailabilityTrace();let calls=0;
 await withSelectedAvailabilityTrace(trace,()=>searchSelectedEvidence({nodes:2,classes:['SL'],providerAllowance:40,logicalAllowance:0,enough:false,providerUsed:()=>0,providerRemaining:()=>40,remainingTime:()=>1000,active:()=>{},known:()=>undefined,check:async()=>{calls++;return undefined;},solve:()=>({full:0,partial:0,reserved:0,gaps:[{a:0,b:1}]}),diagnosticProbe:(_,reason)=>trace.event({trainNumber:'15565',fromStationCode:'SV',toStationCode:'NDLS',travelClass:'SL',quota:'GN',journeyDate:date},reason)}));
 const d=finishSelectedDiagnostics(trace,40,300,{providerAvailabilityCalls:0,providerCallBudgetRemaining:40,providerRateLimited:0,providerErrors:0},[]);
 assert.equal(calls,0);assert.equal(d.finalSearchStopReason,'SEARCH_EXHAUSTED');assert.deepEqual(d.underlyingStopReasons,['LOGICAL_SAFETY_LIMIT']);assert.equal(d.probesSkipped.LOGICAL_SAFETY_LIMIT,1);assert.equal(d.newProviderCallsUsed,0);
});

test('selected explicit unsupported class learning eliminates later train/class live probes only for this request',async t=>{
 const h=fixture(t,r=>r.trainNumber==='15565'&&r.travelClass==='CC'?'UNSUPPORTED_CLASS':'WAITLIST',['SV','GKP','NDLS']);
 h.input.classes=['SL','CC'];
 const r=await h.check(),d=r.diagnostics!.selectedRoute!;
 assert.equal(h.calls.filter(r=>r.travelClass==='CC').length,1);
 assert.equal(h.calls.length,4); // Three SL pairs + one CC rejection, instead of six live pairs.
 assert.equal(d.unsupportedClassProbesAvoided,2);
 assert.equal(d.newProviderCallsUsed,4);
 const used=h.calls.length;
 const again=await h.check(); // Same scheduler reuses its exact-request unsupported TTL cache.
 assert.equal(h.calls.length,used);assert.equal(again.diagnostics!.providerAvailabilityCalls,0);
 const other=(await h.service.search(h.input)).results.find(j=>j.legs[0].trainNumber==='15566')!;
 await h.service.checkAvailability({...h.input,routeId:other.id});
 assert.equal(h.calls.filter(r=>r.trainNumber==='15566'&&r.travelClass==='CC').length,3);
 const before=h.calls.length;
 await h.check(h.create()); // No train-wide blacklist survives into a cold request.
 assert.equal(h.calls.length-before,1);assert.equal(h.calls.at(-1)!.travelClass,'CC');
});

test('selected WAITLIST is supported negative inventory, never a train/class blacklist',async t=>{
 const h=fixture(t,()=> 'WAITLIST',['SV','GKP','NDLS']);h.input.classes=['CC'];
 const r=await h.check();
 assert.equal(h.calls.length,3);assert.ok(h.calls.some(r=>r.fromStationCode==='GKP'));
 assert.equal(r.diagnostics!.selectedRoute!.unsupportedClassProbesAvoided,0);
});

test('fresh Vaishali prefixes prioritize verified 3E frontier extensions and strategic splits',async t=>{
 const codes=['SV','GKP','KLD','BST','GD','LKO','CNB','NDLS'];
 const h=fixture(t,r=>r.travelClass==='3E'&&codes.indexOf(r.fromStationCode)>=4&&codes.indexOf(r.toStationCode)-codes.indexOf(r.fromStationCode)===1?'AVAILABLE':'WAITLIST',codes);
 h.input.classes=['3A','SL','2A','1A','3E','2S','CC','EC'];
 for(const c of h.input.classes)h.seed('SV','NDLS',c,'WAITLIST');
 h.seed('SV','GKP','2A');h.seed('GKP','KLD','3E');h.seed('KLD','BST','3E');h.seed('BST','GD','3E');
 const r=await h.check(),d=r.diagnostics!.selectedRoute!;
 assert.deepEqual(h.calls.map(p=>[p.fromStationCode,p.toStationCode,p.travelClass]),[
  ['GD','NDLS','3E'],['GD','LKO','3E'],['LKO','NDLS','3E'],['LKO','CNB','3E'],['CNB','NDLS','3E']
 ]);
 assert.equal(r.results[0].reservedCoverageRatio,1);assert.equal(d.newProviderCallsUsed,5);
 assert.ok(d.persistedObservationHits>=12);assert.equal(d.configuredSelectedRouteProviderCallLimit,40);
 assert.ok(d.positiveClassEvidenceProbes>=5);assert.ok(d.frontierPriorityProbes>=5);
 assert.ok(d.frontierAdvancements.some(f=>f.before==='GD'&&f.after==='LKO'));
 assert.ok(d.frontierAdvancements.some(f=>f.after==='NDLS'));
 assert.ok(d.trace.length<=120);
});

test('nearby positive class evidence never assumes availability on the remaining gap',async t=>{
 const h=fixture(t,()=> 'WAITLIST',['SV','GKP','KLD','BST','GD','NDLS']);h.input.classes=['SL','3E','2A'];
 for(const c of h.input.classes)h.seed('SV','NDLS',c,'WAITLIST');
 h.seed('SV','GKP','2A');h.seed('GKP','KLD','3E');h.seed('KLD','BST','3E');h.seed('BST','GD','3E');
 const r=await h.check();
 assert.deepEqual([h.calls[0].fromStationCode,h.calls[0].toStationCode,h.calls[0].travelClass],['GD','NDLS','3E']);
 assert.ok(r.results[0].reservedCoverageRatio<1);
 assert.ok(r.diagnostics!.selectedRoute!.uncoveredRanges.some(g=>g.fromStation==='GD'&&g.toStation==='NDLS'));
 assert.ok(!r.results[0].legs[0].segments.some(s=>s.type==='RESERVED'&&s.toStation==='NDLS'));
 assert.ok(h.calls.every(p=>p.fromStationCode!=='SV')); // Hydrated prefix is never re-probed live.
});

test('CC, 2S and EC are each learned once, saving six live interval calls in a three-stop route',async t=>{
 const unsupported=['CC','2S','EC'];
 const h=fixture(t,r=>unsupported.includes(r.travelClass)?'UNSUPPORTED_CLASS':'WAITLIST',['SV','GKP','NDLS']);h.input.classes=['SL',...unsupported];
 const r=await h.check();
 for(const c of unsupported)assert.equal(h.calls.filter(p=>p.travelClass===c).length,1);
 assert.equal(h.calls.length,6); // Three SL checks + three initial explicit rejections; formerly 12.
 assert.equal(r.diagnostics!.selectedRoute!.unsupportedClassProbesAvoided,6);
 assert.equal(r.diagnostics!.selectedRoute!.configuredSelectedRouteProviderCallLimit,40);
});

test('selected class suppression preserves fresh cached inventory and never publishes inferred observations',async()=>{
 const calls:AvailabilityRequest[]=[];
 const request:AvailabilityRequest={trainNumber:'15565',fromStationCode:'SV',toStationCode:'NDLS',journeyDate:date,travelClass:'CC',quota:'GN'};
 const provider={getAvailability:async(r:AvailabilityRequest)=>{
  calls.push(r);return normalizeAvailability({success:false,error:'Class does not exist in this train for this train route'},r);
 },getCachedAvailability:async(r:AvailabilityRequest)=>r.fromStationCode==='GD'?{...normalizeAvailability({success:true,data:{availability:[{date,status:'AVAILABLE'}]}},r),observation:{observedAt:now(),freshUntil:now()+60000}}:undefined};
 const trace=new SelectedAvailabilityTrace(),session=new AvailabilitySession(provider,40,new AvailabilityProviderBudget(40),now,true);
 await withSelectedAvailabilityTrace(trace,async()=>{
  assert.equal((await session.get(request)).status,'UNSUPPORTED_CLASS');
  assert.equal((await session.get({...request,fromStationCode:'GKP'})).status,'UNSUPPORTED_CLASS');
  assert.equal((await session.get({...request,fromStationCode:'GD'})).status,'AVAILABLE');
 });
 assert.equal(calls.length,1);assert.equal(session.statistics().providerAvailabilityCalls,1);assert.equal(session.statistics().unsupportedClassSkips,1);
 assert.equal(trace.probesSkipped.UNSUPPORTED_TRAIN_CLASS,1);
 const legacy=new AvailabilitySession(provider,40,new AvailabilityProviderBudget(40),now);
 await legacy.get(request);await legacy.get({...request,fromStationCode:'GKP'});
 assert.equal(calls.length,3);assert.equal(legacy.unsupported.size,0); // Opt-in policy cannot leak into legacy paths.
});

function boundedFixture(t:TestContext,rule:Rule=()=> 'WAITLIST',limit?:number,useRedis=false){
 const h=fixture(t,rule,['SV','GD','X','Y','Z','TDL','S1','S2','S3','S4','NDLS'],limit,useRedis,[0,273,350,480,610,702,740,780,820,860,912]);
 h.input.classes=['3E','3A'];
 for(const c of h.input.classes)h.seed('SV','NDLS',c,'WAITLIST');
 h.seed('SV','GD','3E');h.seed('TDL','NDLS','3A');
 return h;
}

test('bounded GD-TDL closes after adjacent breadth with one direct AVAILABLE probe',async t=>{
 const h=boundedFixture(t,r=>r.fromStationCode==='GD'&&r.toStationCode==='TDL'?'AVAILABLE':'WAITLIST');
 const r=await h.check(),d=r.diagnostics!.selectedRoute!;
 assert.equal(h.calls.length,5);assert.deepEqual([h.calls[4].fromStationCode,h.calls[4].toStationCode],['GD','TDL']);
 assert.equal(r.results[0].reservedCoverageRatio,1);assert.equal(d.boundedGapsDetected,1);assert.equal(d.boundedGapPriorityProbes,5);
 assert.deepEqual(d.gapShrinkEvents,[{trainNumber:'15565',beforeFrom:'GD',beforeTo:'TDL',afterFrom:null,afterTo:null,distanceBeforeKm:429,distanceAfterKm:0}]);
 assert.equal(d.finalSearchStopReason,'FULL_COVERAGE_FOUND');assert.deepEqual(d.uncoveredRanges,[]);
 assert.equal(d.boundedGapProbeResults.length,5);
 assert.equal(d.boundedGapProbeResults[4].status,'AVAILABLE');
 assert.equal(d.boundedGapProbeResults[4].causedGapShrink,true);
 assert.equal(d.boundedGapProbeResults[4].refinementSkipReason,'SUFFICIENT_HIGH_QUALITY_RESULTS');
 const parts=r.results[0].legs[0].segments.flatMap(s=>s.type==='RESERVED'?s.reservationParts??[]:[]);
 assert.deepEqual(parts.map(p=>[p.fromStation,p.toStation]),[['SV','GD'],['GD','TDL'],['TDL','NDLS']]);
});

test('bounded gaps use boundary-specific classes and progressively shrink from both sides',async t=>{
 const h=boundedFixture(t,r=>r.fromStationCode==='GD'&&r.toStationCode==='Y'&&r.travelClass==='3E'||r.fromStationCode==='Z'&&r.toStationCode==='TDL'&&r.travelClass==='3A'||r.fromStationCode==='Y'&&r.toStationCode==='Z'&&r.travelClass==='3E'?'AVAILABLE':'WAITLIST');
 const r=await h.check(),d=r.diagnostics!.selectedRoute!;
 assert.equal(r.results[0].reservedCoverageRatio,1);
 assert.ok(h.calls.length<=9,JSON.stringify(h.calls));
 const left=h.calls.findIndex(p=>p.fromStationCode==='GD'&&p.toStationCode==='Y');
 assert.ok(left>=0);assert.equal(h.calls[left].travelClass,'3E');
 const right=h.calls.findIndex(p=>p.fromStationCode==='Z'&&p.toStationCode==='TDL');
 assert.ok(right>=0);assert.equal(h.calls[right].travelClass,'3A');
 assert.ok(d.gapShrinkEvents.length>=2);
 assert.equal(d.gapShrinkEvents.at(-1)?.afterFrom,null);
 assert.equal(d.boundedGapPriorityProbes,h.calls.length);
 assert.ok(h.calls.every(p=>['GD','X','Y','Z'].includes(p.fromStationCode)&&['X','Y','Z','TDL'].includes(p.toStationCode)));
});

test('right-boundary 3A evidence can shrink a bounded gap before left-boundary progress',async t=>{
 const h=boundedFixture(t,r=>r.fromStationCode==='X'&&r.toStationCode==='TDL'&&r.travelClass==='3A'?'AVAILABLE':'WAITLIST',10);
 const r=await h.check(),d=r.diagnostics!.selectedRoute!;
 assert.ok(h.calls.some(p=>p.fromStationCode==='X'&&p.toStationCode==='TDL'&&p.travelClass==='3A'));
 assert.deepEqual(d.gapShrinkEvents[0],{trainNumber:'15565',beforeFrom:'GD',beforeTo:'TDL',afterFrom:'GD',afterTo:'X',distanceBeforeKm:429,distanceAfterKm:77});
 assert.deepEqual(d.uncoveredRanges.map(g=>[g.fromStation,g.toStation,g.distanceKm]),[['GD','X',77]]);
 assert.ok(r.results[0].legs[0].segments.some(s=>s.type==='RESERVED'&&s.toStation==='NDLS'));
});

test('WAITLIST leaves the bounded gap unknown, preserves both islands, and never probes past its boundaries live',async t=>{
 const h=boundedFixture(t),r=await h.check(),d=r.diagnostics!.selectedRoute!;
 assert.ok(h.calls.length>2);assert.ok(h.calls.every(p=>['GD','X','Y','Z'].includes(p.fromStationCode)&&['X','Y','Z','TDL'].includes(p.toStationCode)));
 assert.equal(r.results[0].status,'INVENTORY_CHECK_INCOMPLETE');assert.equal(r.results[0].unknownDistanceKm,429);
 assert.deepEqual(r.results[0].legs[0].segments.map(s=>[s.fromStation,s.toStation]),[['SV','GD'],['TDL','NDLS']]);
 assert.deepEqual(d.uncoveredRanges,[{trainNumber:'15565',fromStation:'GD',toStation:'TDL',distanceKm:429,status:'UNKNOWN'}]);
 assert.deepEqual(d.gapShrinkEvents,[]);assert.equal(d.boundedGapsDetected,1);
 assert.ok(d.probesSkipped.OUTSIDE_BOUNDED_GAP>0);
});

test('cold persisted and Redis gap evidence closes the route for free',async t=>{
 const h=boundedFixture(t,r=>r.fromStationCode==='GD'&&r.toStationCode==='TDL'?'AVAILABLE':'WAITLIST',undefined,true);
 const first=await h.check();assert.equal(first.diagnostics!.selectedRoute!.newProviderCallsUsed,5);
 const second=await h.check(h.create());assert.equal(h.calls.length,5);assert.equal(second.diagnostics!.selectedRoute!.newProviderCallsUsed,0);
 assert.equal(second.results[0].reservedCoverageRatio,1);assert.ok(second.diagnostics!.redisCacheHits>0);
 const sqlite=boundedFixture(t);sqlite.seed('GD','TDL','3E');
 const cached=await sqlite.check();assert.equal(sqlite.calls.length,0);assert.equal(cached.results[0].reservedCoverageRatio,1);assert.ok(cached.diagnostics!.persistentCacheHits>0);
});

test('large bounded gap still enforces 40 new calls and learns explicit unsupported classes',async t=>{
 const codes=['SV','GD',...Array.from({length:19},(_,i)=>`G${i}`),'TDL',...Array.from({length:20},(_,i)=>`S${i}`),'NDLS'];
 const h=fixture(t,r=>['CC','EC','2S'].includes(r.travelClass)?'UNSUPPORTED_CLASS':'WAITLIST',codes);
 h.input.classes=['SL','3A','2A','1A','3E','2S','CC','EC'];
 for(const c of h.input.classes)h.seed('SV','NDLS',c,'WAITLIST');
 h.seed('SV','GD','3E');h.seed('TDL','NDLS','3A');
 await h.service.search(h.input);assert.equal(h.calls.length,0);
 const r=await h.check(),d=r.diagnostics!.selectedRoute!;
 assert.equal(h.calls.length,40);assert.equal(d.newProviderCallsUsed,40);assert.equal(d.configuredSelectedRouteProviderCallLimit,40);assert.equal(d.configuredGlobalProviderCallLimit,500);
 assert.equal(d.finalSearchStopReason,'SELECTED_ROUTE_BUDGET_EXHAUSTED');
 for(const c of ['CC','EC','2S'])assert.ok(h.calls.filter(p=>p.travelClass===c).length<=1);
 assert.ok(h.calls.every(p=>codes.indexOf(p.fromStationCode)>=1&&codes.indexOf(p.toStationCode)<=codes.indexOf('TDL')));
 assert.ok(d.trace.length<=120);assert.ok(d.gapShrinkEvents.length<=32);assert.ok(d.persistedObservationHits>=10);
});

test('a bounded gap outranks an earlier open gap in the same selected route',async()=>{
 const calls:{a:number;b:number}[]=[];
 await searchSelectedEvidence({nodes:7,classes:['3E'],providerAllowance:1,logicalAllowance:1,enough:false,providerUsed:()=>calls.length,providerRemaining:()=>1-calls.length,remainingTime:()=>1000,active:()=>{},known:()=>undefined,
  solve:()=>({full:0,partial:1,reserved:300,gaps:[{a:0,b:1},{a:3,b:5}]}),
  check:async e=>{calls.push(e);return {travelClass:e.c,status:'WAITLIST'};}
 });
 assert.equal(calls.length,1);assert.ok(calls[0].a>=3&&calls[0].b<=5);assert.equal(calls[0].b-calls[0].a,1);
});

test('gap shrink diagnostics are bounded with explicit dropped-entry accounting',()=>{
 const trace=new SelectedAvailabilityTrace();
 for(let i=0;i<80;i++)trace.gapShrink({trainNumber:'15565',beforeFrom:'GD',beforeTo:'TDL',afterFrom:'Y',afterTo:'TDL',distanceBeforeKm:429,distanceAfterKm:222});
 assert.equal(trace.gapShrinkEvents.length,32);assert.equal(trace.gapShrinkEventsDropped,48);
 assert.deepEqual(Object.keys(trace.gapShrinkEvents[0]).sort(),['trainNumber','beforeFrom','beforeTo','afterFrom','afterTo','distanceBeforeKm','distanceAfterKm'].sort());
});


for(const scenario of [
 {name:'A: direct closure',available:['GD-TDL'],remaining:[]},
 {name:'B: left boundary advances',available:['GD-X2'],remaining:[['X2','TDL']]},
 {name:'C: right boundary advances',available:['X2-TDL'],remaining:[['GD','X2']]},
 {name:'D: both boundaries advance',available:['GD-X1','X3-TDL'],remaining:[['X1','X3']]},
 {name:'UNKNOWN still refines',available:['GD-X2'],remaining:[['X2','TDL']],unknown:true}
])test(`composed Vaishali prefix and larger WAITLIST preserve GD-TDL exploration: ${scenario.name}`,async t=>{
 const codes=['SV','GKP','KLD','BST','GD','X1','X2','X3','TDL','S1','S2','S3','S4','S5','NDLS'];
 const h=fixture(t,r=>scenario.available.includes(`${r.fromStationCode}-${r.toStationCode}`)?'AVAILABLE':scenario.unknown&&r.fromStationCode==='GD'&&r.toStationCode==='TDL'?'UNKNOWN':'WAITLIST',codes,110,false,[0,80,140,200,273,350,480,610,702,740,780,820,860,890,912]);
 h.input.classes=['SL','3A','2A','1A','3E','2S','CC','EC'];
 for(const c of h.input.classes){h.seed('SV','NDLS',c,'WAITLIST');h.seed('GD','NDLS',c,'WAITLIST');}
 h.seed('SV','GKP','2A');h.seed('GKP','KLD','3E');h.seed('KLD','BST','3E');h.seed('BST','GD','3E');h.seed('TDL','NDLS','3A');
 const r=await h.check(),d=r.diagnostics!.selectedRoute!;
 assert.ok(d.boundedGapsDetected>0,JSON.stringify(d));assert.ok(d.boundedGapPriorityProbes>0,JSON.stringify(d));
 assert.ok(d.boundedGapCandidatesGenerated>0);assert.ok(d.boundedGapCandidatesExecuted>0);
 assert.ok(d.gapShrinkEvents.some(g=>g.beforeFrom==='GD'&&g.beforeTo==='TDL'&&g.distanceBeforeKm===429));
 assert.deepEqual(d.uncoveredRanges.map(g=>[g.fromStation,g.toStation]),scenario.remaining);
 if(scenario.name!=='D: both boundaries advance')assert.ok(h.calls.some(p=>p.fromStationCode==='GD'&&p.toStationCode==='TDL'));
 assert.equal(new Set(h.calls.map(availabilityRequestKey)).size,h.calls.length);
 if(!scenario.remaining.length){assert.equal(r.results[0].reservedCoverageRatio,1);assert.equal(d.finalSearchStopReason,'FULL_COVERAGE_FOUND');}
 else {
  const [from,to]=scenario.remaining[0];
  assert.ok(h.calls.some(p=>p.fromStationCode===from&&p.toStationCode===to),'refine the new exact gap after advancing either boundary');
 }
});


test('cached strategic frontier cannot exhaust an unobserved bounded-gap boundary extension',async t=>{
 const codes=['SV','GD','X','Y','Z','TDL','S1','S2','S3','S4','NDLS'];
 const h=boundedFixture(t,r=>r.fromStationCode==='GD'&&r.toStationCode==='Z'?'AVAILABLE':'WAITLIST');
 for(let a=0;a<codes.length-1;a++)for(let b=a+1;b<codes.length;b++)for(const c of h.input.classes){
  if(a===1&&b===4||a===0&&b===1||a===5&&b===10)continue;
  h.seed(codes[a],codes[b],c,'WAITLIST');
 }
 const r=await h.check(),d=r.diagnostics!.selectedRoute!;
 assert.ok(h.calls.some(p=>p.fromStationCode==='GD'&&p.toStationCode==='Z'),JSON.stringify({calls:h.calls,detected:d.boundedGapsDetected,priority:d.boundedGapPriorityProbes,stop:d.finalSearchStopReason}));
 assert.ok(d.boundedGapPriorityProbes>0);
 assert.equal(h.calls.length,1);assert.equal(d.boundedGapCandidatesExecuted,1);assert.equal(d.boundedGapPriorityProbes,1);
 assert.ok(d.boundedGapRefinementRounds>0);assert.ok(d.boundedGapRejectionReasons.EXACT_EVIDENCE_ALREADY_EXISTS!>0);
 assert.equal(d.boundedGapCandidatesRejected,Object.values(d.boundedGapRejectionReasons).reduce((n,v)=>n+v,0));
 assert.ok(d.boundedGapCandidatesGenerated>=d.boundedGapCandidatesRejected+d.boundedGapCandidatesExecuted);
 assert.ok(d.trace.length<=120);assert.ok(Object.keys(d.boundedGapRejectionReasons).length<=5);
 assert.ok(d.gapShrinkEvents.some(g=>g.afterFrom==='Z'&&g.afterTo==='TDL'));
 const again=await h.check(h.create());
 assert.equal(h.calls.length,1);assert.equal(again.diagnostics!.selectedRoute!.newProviderCallsUsed,0);
});

test('an adjacent bounded gap really exhausts after its one exact supported probe',async t=>{
 const h=fixture(t,()=> 'WAITLIST',['SV','GD','TDL','NDLS']);h.input.classes=['3E'];
 h.seed('SV','NDLS','3E','WAITLIST');h.seed('SV','GD','3E');h.seed('TDL','NDLS','3E');
 const d=(await h.check()).diagnostics!.selectedRoute!;
 assert.equal(d.boundedGapCandidatesExecuted,1);assert.equal(d.boundedGapPriorityProbes,1);
 assert.equal(d.boundedGapReseedCount,0);assert.equal(d.finalSearchStopReason,'NO_USEFUL_PROBES_REMAINING');
 assert.ok(d.budgetRemaining>0);
});

test('recursive bounded refinement includes adjacent internal stations between split anchors',async t=>{
 const h=boundedFixture(t,r=>r.fromStationCode==='X'&&r.toStationCode==='Y'?'AVAILABLE':'WAITLIST',110);
 const r=await h.check(),d=r.diagnostics!.selectedRoute!;
 assert.ok(h.calls.some(p=>p.fromStationCode==='X'&&p.toStationCode==='Y'));
 assert.ok(d.gapShrinkEvents.some(g=>g.afterFrom==='GD'&&g.afterTo==='X'));
 assert.ok(d.gapShrinkEvents.some(g=>g.afterFrom==='Y'&&g.afterTo==='TDL'));
 assert.equal(new Set(h.calls.map(availabilityRequestKey)).size,h.calls.length);
 assert.ok(h.calls.every(p=>['GD','X','Y','Z'].includes(p.fromStationCode)&&['X','Y','Z','TDL'].includes(p.toStationCode)));
 assert.equal(d.boundedGapProbeResults.length+d.boundedGapProbeResultsDropped,d.boundedGapCandidatesExecuted);
 assert.ok(d.boundedGapRefinementRounds>1);
 assert.ok(!h.calls.some(p=>p.fromStationCode==='GD'&&p.toStationCode==='TDL'),'the adjacent island supersedes the original gap');
 const adjacent=d.boundedGapProbeResults.find(p=>p.from==='X'&&p.to==='Y');
 assert.equal(adjacent?.status,'AVAILABLE');assert.equal(adjacent.causedGapShrink,true);
 assert.equal(adjacent.createdNewUnresolvedSubrange,true);
 assert.ok(d.boundedGapWaitlistResults>0);assert.equal(d.boundedGapAvailableResults,1);
 assert.ok(d.boundedGapProbeResults.every(p=>p.trainNumber==='15565'&&p.requestedDate===date&&p.quota==='GN'));
});

const breadthCodes=['SV','GD','BBK','BNZ','ASH','CNB','ETW','TDL','S1','S2','S3','S4','S5','S6','NDLS'];
function breadthFixture(t:TestContext,rule:Rule=()=> 'WAITLIST',limit=110,midnight=false){
 const h=fixture(t,rule,breadthCodes,limit,false,[0,273,361,386,395,471,610,702,730,760,790,820,850,880,912],midnight?[880,1155,1258,1299,1330,1425,1516,1600,1630,1660,1690,1720,1750,1780,1830]:undefined);
 h.input.classes=['SL','3A','2A','1A','3E'];
 for(const c of h.input.classes)h.seed('SV','NDLS',c,'WAITLIST');
 h.seed('SV','GD','3E');
 if(midnight){
  const request={trainNumber:'15565',fromStationCode:'TDL',toStationCode:'NDLS',journeyDate:'19-09-2099',travelClass:'3A',quota:'GN' as const};
  h.store.upsertLatest(makeObservation(normalizeAvailability({success:true,data:{availability:[{date:request.journeyDate,status:'AVAILABLE'}]}},request),now()));
 }else h.seed('TDL','NDLS','3A');
 return h;
}

for(const stale of [false,true])test(`adjacent-first constrained budget discovers BNZ-ASH before class depth (stale=${stale})`,async t=>{
 const h=breadthFixture(t,r=>r.fromStationCode==='BNZ'&&r.toStationCode==='ASH'&&r.travelClass==='3A'?'AVAILABLE':'WAITLIST',2);
 for(let i=1;i<7;i++)if(i!==3)h.seed(breadthCodes[i],breadthCodes[i+1],'2A','WAITLIST');
 for(const [a,b] of [['GD','TDL'],['GD','ASH'],['BBK','TDL']])h.seed(a,b,'3E','WAITLIST');
 if(stale)h.seed('BNZ','ASH','3A','WAITLIST',now()-86400000);
 const r=await h.check(),d=r.diagnostics!.selectedRoute!;
 assert.deepEqual(h.calls[0],{trainNumber:'15565',fromStationCode:'BNZ',toStationCode:'ASH',journeyDate:date,travelClass:'3A',quota:'GN'});
 assert.ok(r.results[0].reservedCoverageRatio>483/912);
 assert.ok(r.results[0].legs[0].segments.some(s=>s.type==='RESERVED'&&s.reservationParts?.some(p=>p.fromStation==='BNZ'&&p.toStation==='ASH')));
 assert.deepEqual(d.uncoveredRanges.map(g=>[g.fromStation,g.toStation]),[['GD','BNZ'],['ASH','TDL']]);
 assert.ok(h.calls.slice(1).every(p=>p.fromStationCode!=='GD'||p.toStationCode!=='TDL'),'obsolete spanning pair must not be swept');
 assert.equal(d.boundedAdjacentPairsTotal,6);assert.equal(d.boundedAdjacentPairsFreshlyCovered,6);
 assert.equal(d.boundedAdjacentPriorityProbes,1);assert.equal(d.boundedClassDepthProbes,0);
 assert.equal(h.calls.length,2);assert.equal(d.newProviderCallsUsed,2);
});

test('adjacent-first WAITLIST breadth precedes structural breadth and retains alternate-class depth',async t=>{
 const h=breadthFixture(t),r=await h.check(),d=r.diagnostics!.selectedRoute!;
 const first=h.calls.slice(0,6);
 assert.equal(new Set(first.map(p=>p.fromStationCode+'-'+p.toStationCode)).size,6);
 assert.ok(first.every(p=>breadthCodes.indexOf(p.toStationCode)-breadthCodes.indexOf(p.fromStationCode)===1));
 assert.equal(d.boundedAdjacentPairsFreshlyCovered,6);assert.equal(d.boundedAdjacentPriorityProbes,6);
 assert.ok(d.boundedClassDepthProbes>0);
 assert.equal(new Set(h.calls.map(availabilityRequestKey)).size,h.calls.length);
 assert.ok(h.calls.filter(p=>p.fromStationCode==='BNZ'&&p.toStationCode==='ASH').length>1);
 const represented=new Set<string>();let firstDepth=-1;
 h.calls.forEach((p,i)=>{const k=p.fromStationCode+'-'+p.toStationCode;if(represented.has(k)&&firstDepth<0)firstDepth=i;represented.add(k);});
 assert.ok(firstDepth>6,'structural pairs receive breadth before class depth');
});

test('adjacent-first errors do not satisfy fresh pair coverage',async t=>{
 const h=breadthFixture(t,r=>r.fromStationCode==='BNZ'&&r.toStationCode==='ASH'?'UNKNOWN':'WAITLIST',1);
 for(let i=1;i<7;i++)if(i!==3)h.seed(breadthCodes[i],breadthCodes[i+1],'2A','WAITLIST');
 const d=(await h.check()).diagnostics!.selectedRoute!;
 assert.equal(h.calls[0].fromStationCode,'BNZ');assert.equal(h.calls[0].toStationCode,'ASH');
 assert.equal(d.boundedAdjacentPairsFreshlyCovered,5);assert.equal(d.boundedUniquePairsFreshlyCovered,5);
 assert.equal(d.boundedAdjacentPriorityProbes,1);assert.equal(d.boundedClassDepthProbes,0);
});

test('adjacent-first keeps boarding date rollover and evidence-based boundary classes',async t=>{
 const h=breadthFixture(t,()=> 'WAITLIST',6,true),d=(await h.check()).diagnostics!.selectedRoute!;
 assert.equal(h.calls.length,6);assert.equal(d.boundedAdjacentPairsFreshlyCovered,6);
 assert.ok(h.calls.every(p=>p.journeyDate===(p.fromStationCode==='ETW'?'19-09-2099':date)));
 assert.equal(h.calls.find(p=>p.fromStationCode==='GD')?.travelClass,'3E');
 assert.equal(h.calls.find(p=>p.fromStationCode==='ETW')?.travelClass,'3A');
});

for(const category of ['INVALID_REQUEST','SECTION_NOT_BOOKABLE'] as const)test(`adjacent-first ${category} retries breadth in another class and still learns unsupported`,async()=>{
 const evidence=new Map<string,import('../../journey/availability/types.js').InventoryCheck>();
 const calls:import('../../journey/availability/recovery/evidence-search.js').EvidenceEdge[]=[];
 const id=(e:{a:number;b:number;c:string})=>`${e.a}:${e.b}:${e.c}`;
 const trace=new SelectedAvailabilityTrace();
 await withSelectedAvailabilityTrace(trace,()=>searchSelectedEvidence({nodes:5,classes:['CC','SL','3A'],providerAllowance:7,logicalAllowance:7,enough:false,
  providerUsed:()=>calls.length,providerRemaining:()=>7-calls.length,remainingTime:()=>10000,active:()=>{},known:e=>evidence.get(id(e)),
  solve:()=>({full:0,partial:1,reserved:200,gaps:[{a:1,b:3}]}),
  check:async e=>{
   calls.push(e);
   const check:import('../../journey/availability/types.js').InventoryCheck=e.c==='CC'?{travelClass:e.c,status:'UNSUPPORTED_CLASS',errorCategory:'UNSUPPORTED_CLASS'}:
    e.c==='SL'?{travelClass:e.c,status:category==='SECTION_NOT_BOOKABLE'?'SECTION_NOT_BOOKABLE':'PROVIDER_ERROR',errorCategory:category}:{travelClass:e.c,status:'WAITLIST'};
   evidence.set(id(e),check);return check;
  }}));
 assert.equal(calls.filter(e=>e.c==='CC').length,1);
 assert.equal(new Set(calls.map(id)).size,calls.length);
 assert.equal(trace.boundedBreadth.boundedAdjacentPairsFreshlyCovered,2);
 assert.equal(trace.boundedBreadth.boundedAdjacentPriorityProbes,5);
 assert.ok(calls.slice(0,5).every(e=>e.b-e.a===1),'errors leave adjacent breadth ahead of structural/class-depth work');
});

test('adjacent-first rehydrates newly exposed boundaries after a gap shrinks',async()=>{
 type Edge=import('../../journey/availability/recovery/evidence-search.js').EvidenceEdge;
 type Check=import('../../journey/availability/types.js').InventoryCheck;
 const evidence=new Map<string,Check>(),calls:Edge[]=[],lookups:Edge[]=[];
 const id=(e:Edge)=>`${e.a}:${e.b}:${e.c}`;
 const solve=()=>{
  const covered=new Set<number>([0,9]);
  for(const [key,hit] of evidence)if(hit.status==='AVAILABLE'){
   const [a,b]=key.split(':').map(Number);for(let i=a;i<b;i++)covered.add(i);
  }
  const gaps:{a:number;b:number}[]=[];
  for(let a=0;a<10;a++)if(!covered.has(a)){const start=a;while(a+1<10&&!covered.has(a+1))a++;gaps.push({a:start,b:a+1});}
  return {full:gaps.length?0:1,partial:1,reserved:covered.size,gaps};
 };
 await searchSelectedEvidence({nodes:11,classes:['SL','3A'],providerAllowance:80,logicalAllowance:80,enough:false,
  providerUsed:()=>calls.length,providerRemaining:()=>80-calls.length,remainingTime:()=>10000,active:()=>{},known:e=>evidence.get(id(e)),solve,
  cached:async e=>{
   lookups.push(e);
   if(e.a===5&&e.b===8&&e.c==='3A'){const hit:Check={travelClass:e.c,status:'AVAILABLE'};evidence.set(id(e),hit);return hit;}
   return evidence.get(id(e));
  },
  check:async e=>{const known=evidence.get(id(e));if(known)return known;calls.push(e);
   const hit:Check={travelClass:e.c,status:e.a===1&&e.b===5?'AVAILABLE':'WAITLIST'};evidence.set(id(e),hit);return hit;
  }});
 assert.ok(calls.some(e=>e.a===1&&e.b===5));
 assert.ok(lookups.some(e=>e.a===5&&e.b===8&&e.c==='3A'));
 assert.ok(!calls.some(e=>e.a===5&&e.b===8),'persisted AVAILABLE on a new boundary must be consumed before a live probe');
 assert.deepEqual(solve().gaps,[{a:8,b:9}]);
});
