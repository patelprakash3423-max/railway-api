import {pathToFileURL} from 'node:url';
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { RailwayDatabase } from '../database.js';
import type { LocalDataset } from '../types.js';
import type { V2Journey, V2Leg } from '../planner/v2/types.js';
import type { AvailabilityRequest, AvailabilityResult } from '../../domain/types/availability.js';
import { JourneyRecoveryOrchestrator, rankJourneys, type JourneyOptions } from '../../journey/availability/journey/orchestrator.js';
import { requestKey } from '../../journey/availability/inventory.js';
const date='18-09-2026';
const iso=(m:number)=>new Date(Date.UTC(2026,8,18,0,m)).toISOString().slice(0,16)+':00+05:30';
type Rule=(r:AvailabilityRequest)=>'AVAILABLE'|'RAC'|'WAITLIST'|'NOT_AVAILABLE';
function fixture(t:TestContext,distances=[1000],fractions=distances.map(()=>.7),start=360){
  const stations=new Set<string>(),trains:LocalDataset['trains']=[],stops:LocalDataset['stops']=[],legs:V2Leg[]=[];
  distances.forEach((km,i)=>{
    const trainNumber=String(30001+i),codes=[`S${i}`,`M${i}`,`S${i+1}`],times=[start+i*400,start+i*400+100,start+i*400+300];codes.forEach(c=>stations.add(c));
    trains.push({number:trainNumber,name:trainNumber,sourceCode:codes[0],destinationCode:codes[2],runningDaysRaw:'Daily',runningDays:['MON','TUE','WED','THU','FRI','SAT','SUN']});
    codes.forEach((stationCode,k)=>stops.push({trainNumber,stationCode,sequence:k+1,dayOffset:Math.floor(times[k]/1440),arrivalTime:k?iso(times[k]).slice(11,16):undefined,departureTime:k<2?iso(times[k]).slice(11,16):undefined,distanceKm:[0,km*fractions[i],km][k]}));
    legs.push({trainNumber,trainName:trainNumber,from:codes[0],to:codes[2],fromStation:codes[0],toStation:codes[2],boardingDate:times[0]>=1440?'19-09-2026':date,originDate:date,departureDateTime:iso(times[0]),boardingDateTime:iso(times[0]),arrivalDateTime:iso(times[2]),distanceKm:km});
  });
  const db=new RailwayDatabase(':memory:');db.replace({stations:[...stations].map(code=>({code,name:code})),trains,stops,metadata:{source:'RAILPULL_NTES',importedAt:'2026-09-14T00:00:00Z',trainCount:trains.length,stationCount:stations.size,stopCount:stops.length}});t.after(()=>db.close());
  const candidate:V2Journey={from:'S0',to:`S${distances.length}`,departureDateTime:legs[0].departureDateTime,arrivalDateTime:legs.at(-1)!.arrivalDateTime,durationMinutes:distances.length*400-100,changes:distances.length-1,segments:legs,connections:[],totalDistanceKm:distances.reduce((a,b)=>a+b),interchangeTiers:[],distanceDetourPercent:0,durationDetourPercent:0};
  return {db,candidate};
}
async function run(t:TestContext,rule:Rule,distances=[1000],fractions=distances.map(()=>.7),options:JourneyOptions={},count=1,start=360,metadata?:Record<string,string[]>){
  const {db,candidate}=fixture(t,distances,fractions,start),calls:AvailabilityRequest[]=[];
  let discovery=0,info=0;
  const provider={getAvailability:async(r:AvailabilityRequest):Promise<AvailabilityResult>=>{calls.push({...r});const state=rule(r);return {request:r,provider:'railkit',providerState:'SUCCESS',days:[{date:r.journeyDate,state}],fare:state==='AVAILABLE'||state==='RAC'?{currency:'INR',totalFare:100}:undefined};},getTrainInfo:async()=>{info++;throw Error('forbidden');},searchTrainsBetweenStations:async()=>{discovery++;throw Error('forbidden');}};
  const result=await new JourneyRecoveryOrchestrator(db,provider,{budgetLimit:100,maxRecoveryRequestsPerCandidate:60,usableTarget:10,...options}).validate({source:candidate.from,destination:candidate.to,journeyDate:date,requestedClasses:['SL','3A'],supportedClassesByTrain:metadata,plannerCandidates:Array.from({length:count},()=>candidate)});
  assert.equal(discovery,0);assert.equal(info,0);assert.equal(new Set(calls.map(requestKey)).size,calls.length);
  return {...result,calls,j:result.journeys[0]};
}
const partial:Rule=r=>r.toStationCode.startsWith('M')&&r.travelClass==='SL'?'AVAILABLE':'WAITLIST';
const split:Rule=r=>r.toStationCode.startsWith('M')&&r.travelClass==='SL'?'AVAILABLE':r.fromStationCode.startsWith('M')&&r.travelClass==='3A'?'RAC':'WAITLIST';
for(const distances of [[1000],[600,400]])test(`journey normal ${distances.length} legs never recover`,async t=>{const r=await run(t,()=> 'AVAILABLE',distances);assert.equal(r.j.journeyStatus,'FULLY_RESERVED_USABLE');assert.equal(r.diagnostics.legsRecoveryAttempted,0);assert.equal(r.calls.length,distances.length);});
test('journey AVAILABLE and RAC need no recovery or class improvement',async t=>{const r=await run(t,r=>r.trainNumber==='30001'?'AVAILABLE':'RAC',[600,400]);assert.equal(r.j.journeyStatus,'FULLY_RESERVED_USABLE');assert.equal(r.diagnostics.recoveryIntervalRequests,0);});
test('journey failed leg alone recovers to full split',async t=>{const r=await run(t,r=>r.trainNumber==='30001'?'AVAILABLE':split(r),[600,400]);assert.equal(r.j.journeyStatus,'FULLY_RESERVED_WITH_SPLIT_CLASS');assert.equal(r.diagnostics.legsRecoveryAttempted,1);assert.equal(r.calls.filter(c=>c.trainNumber==='30001').length,1);assert.equal(r.j.trainChanges,1);assert.equal(r.j.classChanges,1);});
test('journey failed leg recovers 70%',async t=>{const r=await run(t,partial);assert.equal(r.j.reservedCoverageRatio,.7);assert.equal(r.j.journeyStatus,'PARTIAL_RESERVED_RECOVERY');});
test('journey 600 full plus 400 half yields 80%',async t=>{const r=await run(t,r=>r.trainNumber==='30001'?'AVAILABLE':partial(r),[600,400],[.5,.5]);assert.equal(r.j.reservedDistanceKm,800);assert.equal(r.j.reservedCoverageRatio,.8);});
test('journey multiple recovered legs aggregate globally',async t=>{const r=await run(t,partial,[300,700],[.7,.65]);assert.equal(r.diagnostics.legsRecoveryAttempted,2);assert.equal(r.j.reservedCoverageRatio,.665);});
for(const [ratio,status] of [[.5,'PARTIAL_RESERVED_RECOVERY'],[.49,'SCHEDULED_BUT_NOT_FULLY_AVAILABLE']] as const)test(`journey threshold ${ratio}`,async t=>{const r=await run(t,partial,[1000],[ratio]);assert.equal(r.j.reservedCoverageRatio,ratio);assert.equal(r.j.journeyStatus,status);});
test('journey accepts sub-50 leg evidence when global coverage qualifies',async t=>{const r=await run(t,r=>r.trainNumber==='30001'?'AVAILABLE':partial(r),[600,400],[.5,.25]);assert.equal(r.j.reservedCoverageRatio,.7);assert.equal(r.j.legs[1].reservedCoverageRatio,.25);assert.equal(r.j.journeyStatus,'PARTIAL_RESERVED_RECOVERY');});
test('journey optimistic infeasibility makes no recovery requests',async t=>{const r=await run(t,()=> 'WAITLIST',[100,900],[.5,.5],{},1,360,{'30001':['SL'],'30002':[]});assert.equal(r.diagnostics.coverageFeasibilityPruned,1);assert.equal(r.diagnostics.recoveryIntervalRequests,0);});
test('journey global budget shared and enforced',async t=>{const r=await run(t,split,[1000],[.7],{budgetLimit:5});assert.ok(r.calls.length<=5);assert.equal(r.calls.length,r.diagnostics.wholeLegRequests+r.diagnostics.recoveryIntervalRequests);assert.equal(r.diagnostics.availabilityBudgetLimit,5);});
test('journey candidate cap protects global remainder',async t=>{const r=await run(t,()=> 'WAITLIST',[1000],[.7],{budgetLimit:30,maxRecoveryRequestsPerCandidate:2});assert.ok(r.diagnostics.recoveryIntervalRequests<=2);assert.ok(r.diagnostics.candidateRecoveryBudgetPruned);assert.ok(r.diagnostics.budgetRemaining>=26);assert.equal(r.j.journeyStatus,'INVENTORY_CHECK_INCOMPLETE');});
test('journey full-leg cache reused by recovery',async t=>{const r=await run(t,split);assert.ok(r.diagnostics.availabilityCacheHits>=2);assert.equal(r.calls.filter(c=>c.fromStationCode==='S0'&&c.toStationCode==='S1').length,2);});
for(const error of [{status:429},new Error('offline'),{status:503}])test(`journey provider failure stays unknown ${JSON.stringify(error)}`,async t=>{const r=await run(t,r=>{if(r.trainNumber==='30002')throw error;return 'AVAILABLE';},[500,500]);assert.equal(r.j.journeyStatus,'INVENTORY_CHECK_INCOMPLETE');assert.equal(r.j.unknownDistanceKm,500);assert.equal(r.j.selfManagedDistanceKm,0);assert.equal(r.diagnostics.legsRecoveryAttempted,0);});
for(const state of ['WAITLIST','NOT_AVAILABLE']as const)test(`journey ${state} is confirmed inventory failure`,async t=>{const r=await run(t,()=>state);assert.equal(r.j.journeyStatus,'SCHEDULED_BUT_NOT_FULLY_AVAILABLE');assert.equal(r.j.unknownDistanceKm,0);assert.equal(r.j.selfManagedDistanceKm,1000);});
test('journey SELF_MANAGED preserved and fare excludes gaps',async t=>{const r=await run(t,partial);assert.deepEqual(r.j.legs[0].segments.map(s=>s.type),['RESERVED','SELF_MANAGED']);const gap=r.j.legs[0].segments[1];assert.equal(gap.fromStation,'M0');assert.equal(gap.toStation,'S1');assert.equal(gap.distanceKm,300);assert.equal(r.j.knownReservedFare,100);assert.equal(r.j.fareComplete,false);assert.ok(!('fare'in gap));});
test('journey split outranks partial and normal outranks split',async t=>{const a=await run(t,()=> 'AVAILABLE'),b=await run(t,split),c=await run(t,partial);assert.ok(rankJourneys(a.j,b.j)<0);assert.ok(rankJourneys(b.j,c.j)<0);});
test('journey higher coverage outranks fewer train changes',async t=>{const a=await run(t,partial,[500,500],[.8,.8]),b=await run(t,partial,[1000],[.55]);assert.ok(rankJourneys(a.j,b.j)<0);});
test('journey deterministic ranking and requests',async t=>{const a=await run(t,split),b=await run(t,split);assert.deepEqual(a,b);});
test('journey multiple candidates share interval cache',async t=>{const r=await run(t,split,[1000],[.7],{},2);assert.equal(r.journeys.length,2);assert.equal(r.calls.length,5);assert.ok(r.diagnostics.availabilityCacheHits>=7);});
test('journey interval boarding date crosses midnight',async t=>{const r=await run(t,split,[1000],[.7],{},1,1400);assert.ok(r.calls.some(c=>c.fromStationCode==='M0'&&c.journeyDate==='19-09-2026'));});
test('journey longest failed bottleneck is attempted first',async t=>{const r=await run(t,partial,[300,700]);const first=r.calls.find(c=>c.fromStationCode.startsWith('M')||c.toStationCode.startsWith('M'));assert.equal(first?.trainNumber,'30002');});
test('journey whole batch validates before interval requests',async t=>{const r=await run(t,split,[500,500]);const index=r.calls.findIndex(c=>c.fromStationCode.startsWith('M')||c.toStationCode.startsWith('M'));assert.equal(index,4);});
test('journey target stops recovery and later batch spending',async t=>{const r=await run(t,()=> 'AVAILABLE',[1000],[.7],{usableTarget:1,batchSizes:[1]},3);assert.equal(r.calls.length,1);assert.equal(r.diagnostics.recoveryIntervalRequests,0);});
test('journey configurable global threshold independent of leg threshold',async t=>{const r=await run(t,partial,[1000],[.7],{minimumJourneyReservedCoverageRatio:.8});assert.equal(r.j.journeyStatus,'SCHEDULED_BUT_NOT_FULLY_AVAILABLE');});

test('journey Planner V2 service is offline with no discovery or info access',async t=>{
  const {db}=fixture(t);
  const {PlannerV2JourneyRecoveryService}=await import('../../journey/availability/journey/orchestrator.js');
  let calls=0;
  const result=await new PlannerV2JourneyRecoveryService(db,{getAvailability:async r=>{calls++;return {request:r,provider:'railkit',providerState:'SUCCESS',days:[{date:r.journeyDate,state:'AVAILABLE'}]};}}).search({source:'S0',destination:'S1',journeyDate:date,requestedClasses:['SL']});
  assert.ok(result.plannerDiagnostics);assert.equal(result.journeys[0].journeyStatus,'FULLY_RESERVED_USABLE');assert.equal(calls,1);
});
test('journey CLI requires fake mode and runs keyless with networking denied',async t=>{
  const {mkdtempSync,rmSync,readFileSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join,resolve}=await import('node:path');const {spawnSync}=await import('node:child_process');
  const dir=mkdtempSync(join(tmpdir(),'journey-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const db=join(dir,'railway.sqlite');
  const run=(args:string[])=>spawnSync(process.execPath,['--import',pathToFileURL(resolve('src/local-railway/tests/network-denied.mjs')).href,'--import','tsx',...args],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:process.env.HOME}});
  const imported=run(['src/local-railway/cli.ts','import','--trains','src/local-railway/tests/fixtures/trains.csv','--stops','src/local-railway/tests/fixtures/stops.csv','--db',db]);assert.equal(imported.status,0,imported.stderr);
  const args=['src/journey/availability/journey/cli.ts','AAA','EEE',date,'--db',db];assert.notEqual(run(args).status,0);assert.notEqual(run([...args,'--live']).status,0);
  const result=run([...args,'--fake','--json']);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).inventoryMode,'FAKE_OFFLINE');
  const source=readFileSync(resolve('src/journey/availability/journey/orchestrator.ts'),'utf8');assert.doesNotMatch(source,/\.(?:searchTrains?BetweenStations|getTrainInfo)\s*\(/);assert.doesNotMatch(source,/railkit-provider/);
});
test('journey interval provider failure does not manufacture partial coverage',async t=>{const r=await run(t,r=>{if(r.fromStationCode.startsWith('M'))throw {status:429};return partial(r);});assert.equal(r.j.journeyStatus,'INVENTORY_CHECK_INCOMPLETE');assert.ok(r.j.unknownDistanceKm>0);assert.equal(r.j.selfManagedDistanceKm,0);});
test('journey full split sums only known reservation fares',async t=>{const r=await run(t,split);assert.equal(r.j.knownReservedFare,200);assert.equal(r.j.fareComplete,true);assert.equal(r.j.trainChanges,0);assert.equal(r.j.classChanges,1);});
test('journey unsupported classes cannot trigger interval spending',async t=>{const r=await run(t,()=> 'WAITLIST',[1000],[.7],{},1,360,{'30001':[]});assert.equal(r.calls.length,0);assert.equal(r.diagnostics.legsRecoveryAttempted,0);assert.equal(r.j.journeyStatus,'SCHEDULED_BUT_NOT_FULLY_AVAILABLE');});

test('Phase C ALL reaches deferred complementary 3E within STANDARD budget',async t=>{
  const {db,candidate}=fixture(t),calls:AvailabilityRequest[]=[];
  const provider={getAvailability:async(r:AvailabilityRequest):Promise<AvailabilityResult>=>{
    calls.push({...r});
    const state=(r.toStationCode==='M0'&&r.travelClass==='SL')||(r.fromStationCode==='M0'&&r.travelClass==='3E')?'AVAILABLE':'WAITLIST';
    return {request:r,provider:'railkit',providerState:'SUCCESS',days:[{date:r.journeyDate,state}]};
  }};
  const result=await new JourneyRecoveryOrchestrator(db,provider).validate({source:'S0',destination:'S1',journeyDate:date,requestedClasses:['ALL'],plannerCandidates:[candidate]});
  t.diagnostic(JSON.stringify({whole:result.diagnostics.wholeLegRequests,interval:result.diagnostics.recoveryIntervalRequests,remaining:result.diagnostics.budgetRemaining,classes:calls.filter(r=>r.fromStationCode==='M0').map(r=>r.travelClass)}));
  assert.equal(result.journeys[0].journeyStatus,'FULLY_RESERVED_WITH_SPLIT_CLASS');
  assert.equal(result.journeys[0].trainChanges,0);
  assert.deepEqual(result.journeys[0].legs[0].segments.map(s=>s.type==='RESERVED'?[s.trainNumber,s.selectedClass]:s.type),[['30001','SL'],['30001','3E']]);
  assert.ok(calls.length<=30);
});
