import {pathToFileURL} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AvailabilityRequest, AvailabilityResult } from '../../domain/types/availability.js';
import type { V2Journey, V2Leg } from '../planner/v2/types.js';
import { AvailabilityOrchestrator } from '../../journey/availability/orchestrator.js';
import type { ValidationInput, ValidationOptions } from '../../journey/availability/types.js';
import { chooseClasses, rankValidated } from '../../journey/availability/ranking.js';
import { requestKey } from '../../journey/availability/inventory.js';
const date='18-09-2026';
function candidate(numbers=['30001'],nextDay=false):V2Journey{
  const segments:V2Leg[]=numbers.map((number,i)=>{const from=i?`X${i}`:'AAA',to=i===numbers.length-1?'ZZZ':`X${i+1}`,boardingDate=nextDay&&i?'19-09-2026':date,iso=nextDay&&i?'2026-09-19':'2026-09-18',hour=6+i*3;return{trainNumber:number,trainName:number,from,to,fromStation:from,toStation:to,boardingDate,originDate:boardingDate,departureDateTime:`${iso}T${String(hour).padStart(2,'0')}:00:00+05:30`,boardingDateTime:`${iso}T${String(hour).padStart(2,'0')}:00:00+05:30`,arrivalDateTime:`${iso}T${String(hour+2).padStart(2,'0')}:00:00+05:30`,distanceKm:500};});
  return{from:'AAA',to:'ZZZ',departureDateTime:segments[0].departureDateTime,arrivalDateTime:segments.at(-1)!.arrivalDateTime,durationMinutes:120*numbers.length+60*(numbers.length-1),changes:numbers.length-1,segments,connections:segments.slice(1).map(s=>({station:s.from,minutes:60,safety:'TIGHT'})),totalDistanceKm:500*numbers.length,interchangeTiers:segments.slice(1).map(()=>'MAJOR'),distanceDetourPercent:0,durationDetourPercent:0};
}
function answer(r:AvailabilityRequest,state:'AVAILABLE'|'RAC'|'WAITLIST'|'NOT_AVAILABLE'='AVAILABLE',fare:number|undefined=100):AvailabilityResult{return{request:{...r},provider:'railkit',providerState:'SUCCESS',days:[{date:r.journeyDate,state,availabilityText:state}],fare:fare===undefined?undefined:{currency:'INR',totalFare:fare}};}
function harness(fn:(r:AvailabilityRequest)=>AvailabilityResult|Promise<AvailabilityResult>=r=>answer(r),options:ValidationOptions={}){
  const calls:AvailabilityRequest[]=[];
  const provider={getAvailability:async(r:AvailabilityRequest)=>{calls.push({...r});return fn(r);},searchTrainsBetweenStations:async()=>{throw new Error('Forbidden discovery');},getTrainInfo:async()=>{throw new Error('Forbidden info');}};
  const orchestrator=new AvailabilityOrchestrator(provider,options);
  const run=(plannerCandidates=[candidate()],extra:Partial<ValidationInput>={})=>orchestrator.validate({source:'AAA',destination:'ZZZ',journeyDate:date,requestedClasses:['SL'],plannerCandidates,...extra});
  return{calls,run,provider};
}
for(const status of ['AVAILABLE','RAC','WAITLIST','NOT_AVAILABLE'] as const)test(`V2 inventory direct ${status}`,async()=>{
  const h=harness(r=>answer(r,status)),r=await h.run();assert.equal(h.calls.length,1);assert.equal(r.journeys[0].status,['AVAILABLE','RAC'].includes(status)?'FULLY_RESERVED_USABLE':'SCHEDULED_BUT_NOT_FULLY_AVAILABLE');assert.equal(r.journeys[0].legs[0].availabilityStatus,status==='NOT_AVAILABLE'?'UNAVAILABLE':status);
});
for(const second of ['AVAILABLE','RAC','WAITLIST'] as const)test(`V2 inventory AVAILABLE + ${second}`,async()=>{
  const h=harness(r=>answer(r,r.trainNumber==='30001'?'AVAILABLE':second)),r=await h.run([candidate(['30001','30002'])]);assert.equal(r.journeys[0].status,second==='WAITLIST'?'SCHEDULED_BUT_NOT_FULLY_AVAILABLE':'FULLY_RESERVED_USABLE');assert.equal(r.journeys[0].legs.length,2);
});
test('V2 inventory mixed classes across whole train legs',async()=>{
  const h=harness(r=>answer(r,r.travelClass===(r.trainNumber==='30001'?'SL':'3A')?'AVAILABLE':'WAITLIST'));
  const r=await h.run([candidate(['30001','30002'])],{requestedClasses:['ALL']});assert.equal(r.journeys[0].status,'FULLY_RESERVED_USABLE');assert.deepEqual(r.journeys[0].legs.map(l=>l.selectedClass),['SL','3A']);assert.equal(r.journeys[0].classChanges,1);assert.equal(h.calls.length,3);
});
test('V2 inventory ALL widens only until a usable round',async()=>{
  const h=harness(r=>answer(r,r.travelClass==='2A'?'AVAILABLE':'WAITLIST'));const r=await h.run(undefined,{requestedClasses:['all']});assert.deepEqual(h.calls.map(c=>c.travelClass),['SL','3A','2A']);assert.equal(r.diagnostics.classRoundsAttempted.length,2);assert.equal(r.journeys[0].status,'FULLY_RESERVED_USABLE');
});
test('V2 inventory supported metadata avoids known unsupported classes',async()=>{
  const h=harness();await h.run(undefined,{requestedClasses:['ALL'],supportedClassesByTrain:{'30001':['CC']}});assert.deepEqual(h.calls.map(c=>c.travelClass),['CC']);
});
test('V2 inventory duplicate exact requests cost once including shared failures',async()=>{
  const h=harness(r=>answer(r,'WAITLIST'));const r=await h.run([candidate(),candidate()]);assert.equal(h.calls.length,1);assert.equal(r.diagnostics.availabilityCacheHits,1);assert.equal(r.diagnostics.waitlistResponses,1);
});
test('V2 inventory shared leg across different candidates is reused',async()=>{
  const h=harness();const r=await h.run([candidate(['30001','30002']),candidate(['30001','30003'])]);assert.equal(h.calls.length,3);assert.equal(r.diagnostics.availabilityCacheHits,1);assert.equal(r.diagnostics.usableJourneysFound,2);
});
test('V2 inventory cache includes full segment date class and quota identity',()=>{
  const r:AvailabilityRequest={trainNumber:'30001',fromStationCode:'AAA',toStationCode:'ZZZ',journeyDate:date,travelClass:'SL',quota:'GN'};
  for(const edit of [{trainNumber:'30002'},{fromStationCode:'XXX'},{toStationCode:'YYY'},{journeyDate:'19-09-2026'},{travelClass:'3A'},{quota:'TQ'}])assert.notEqual(requestKey(r),requestKey({...r,...edit} as AvailabilityRequest));
});
test('V2 inventory cache is request-local even when orchestrator is reused',async()=>{const h=harness();await h.run();await h.run();assert.equal(h.calls.length,2);});
for(const category of ['RATE_LIMITED','UNSUPPORTED_CLASS','INVALID_REQUEST','BOOKING_UNSUPPORTED','INVALID_PROVIDER_RESPONSE','UNKNOWN_PROVIDER_ERROR'] as const)test(`V2 inventory error category ${category}`,async()=>{
  const h=harness(()=>{throw{failureCategory:category};});const r=await h.run();assert.equal(r.journeys[0].legs[0].availabilityStatus,category==='UNSUPPORTED_CLASS'?'UNSUPPORTED_CLASS':'PROVIDER_ERROR');assert.equal(r.journeys[0].status,category==='UNSUPPORTED_CLASS'?'SCHEDULED_BUT_NOT_FULLY_AVAILABLE':'INVENTORY_CHECK_INCOMPLETE');assert.equal(r.diagnostics.providerErrorCategories[category],category==='UNSUPPORTED_CLASS'?undefined:1);if(category==='UNSUPPORTED_CLASS'){assert.equal(r.diagnostics.unsupportedClassResponses,1);assert.equal(r.diagnostics.providerErrors,0);}assert.equal(r.diagnostics.waitlistResponses,0);
});
test('V2 inventory normalized provider unavailable and wrong date remain incomplete',async()=>{
  const h=harness(r=>({...answer(r),providerState:'PROVIDER_UNAVAILABLE',days:[]}));assert.equal((await h.run()).diagnostics.providerErrorCategories.PROVIDER_UNAVAILABLE,1);
  const wrong=harness(r=>({...answer(r),days:[{date:'19-09-2026',state:'AVAILABLE'}]}));assert.equal((await wrong.run()).journeys[0].status,'INVENTORY_CHECK_INCOMPLETE');
});
test('V2 inventory structural HTTP 429 and invalid request category',async()=>{
  for(const [status,category] of [[429,'RATE_LIMITED'],[400,'INVALID_REQUEST']] as const){const h=harness(()=>{throw{status};});assert.equal((await h.run()).diagnostics.providerErrorCategories[category],1);}
});
test('V2 inventory second leg uses its boarding date',async()=>{
  const h=harness();await h.run([candidate(['30001','30002'],true)]);assert.deepEqual(h.calls.map(c=>c.journeyDate),[date,'19-09-2026']);
});
test('V2 inventory zero budget keeps unchecked schedule fallback',async()=>{
  const h=harness(undefined,{budgetLimit:0});const r=await h.run();assert.equal(h.calls.length,0);assert.equal(r.diagnostics.budgetRemaining,0);assert.equal(r.journeys[0].status,'INVENTORY_CHECK_INCOMPLETE');assert.equal(r.journeys[0].legs[0].availabilityStatus,null);assert.equal(r.diagnostics.candidatesDeferredByBudget,1);
});
test('V2 inventory atomic multi-leg deferral spends no partial requests',async()=>{
  const h=harness(undefined,{budgetLimit:1});const r=await h.run([candidate(['30001','30002'])]);assert.equal(h.calls.length,0);assert.equal(r.diagnostics.atomicBudgetDeferrals,1);assert.equal(r.diagnostics.candidatesValidationStarted,0);
});
test('V2 inventory atomic reservation covers all uncached classes in round',async()=>{
  const h=harness(undefined,{budgetLimit:3});const r=await h.run([candidate(['30001','30002'])],{requestedClasses:['SL','3A']});assert.equal(h.calls.length,0);assert.equal(r.diagnostics.atomicBudgetDeferrals,1);
});
test('V2 inventory cache hits require zero remaining budget',async()=>{
  const h=harness(undefined,{budgetLimit:1});const r=await h.run([candidate(),candidate()]);assert.equal(h.calls.length,1);assert.equal(r.diagnostics.usableJourneysFound,2);assert.equal(r.diagnostics.availabilityCacheHits,1);
});
test('V2 inventory bottleneck first rejects before spending other leg',async()=>{
  const c=candidate(['30001','30002']);c.segments[1].distanceKm=800;
  const h=harness(r=>answer(r,r.trainNumber==='30002'?'WAITLIST':'AVAILABLE'));const r=await h.run([c]);assert.deepEqual(h.calls.map(c=>c.trainNumber),['30002']);assert.equal(r.diagnostics.bottleneckEarlyExits,1);assert.deepEqual(r.journeys[0].legs.map(l=>l.trainNumber),['30001','30002']);
});
test('V2 inventory complete and partial fares preserve unknowns',async()=>{
  const h=harness(r=>answer(r,'AVAILABLE',r.trainNumber==='30001'?100:200));const full=(await h.run([candidate(['30001','30002'])])).journeys[0];assert.equal(full.totalFare.amount,300);assert.equal(full.totalFare.status,'COMPLETE');
  const missing=harness(r=>{const a=answer(r);if(r.trainNumber==='30002')delete a.fare;return a;});const partial=(await missing.run([candidate(['30001','30002'])])).journeys[0];assert.equal(partial.totalFare.amount,null);assert.equal(partial.totalFare.knownSubtotal,100);assert.equal(partial.totalFare.status,'PARTIAL');assert.equal(partial.status,'FULLY_RESERVED_USABLE');
});
test('V2 inventory fare never implies availability',async()=>{
  const h=harness(r=>({...answer(r),days:[]}));const r=await h.run();assert.equal(r.journeys[0].status,'INVENTORY_CHECK_INCOMPLETE');assert.equal(r.journeys[0].totalFare.amount,null);
});
test('V2 inventory usable target stops batches early and preserves remaining schedules',async()=>{
  const h=harness(undefined,{usableTarget:2,batchSizes:[2,2]});const candidates=Array.from({length:8},(_,i)=>candidate([String(30001+i)]));const r=await h.run(candidates);assert.equal(h.calls.length,2);assert.equal(r.journeys.length,8);assert.equal(r.diagnostics.batchesAttempted,1);assert.equal(r.diagnostics.fallbackJourneysReturned,6);
});
test('V2 inventory AVAILABLE alternatives beat direct RAC and WAITLIST',async()=>{
  const h=harness(r=>answer(r,r.trainNumber==='30001'?'RAC':r.trainNumber==='30002'?'WAITLIST':'AVAILABLE'));
  const r=await h.run([candidate(),candidate(['30002']),candidate(['30003','30004'])]);assert.equal(r.journeys[0].availableLegCount,2);assert.equal(r.journeys[0].status,'FULLY_RESERVED_USABLE');assert.equal(r.journeys[1].racLegCount,1);assert.equal(r.journeys[2].status,'SCHEDULED_BUT_NOT_FULLY_AVAILABLE');assert.deepEqual(r.journeys.map(j=>j.finalRank),[1,2,3]);assert.ok(rankValidated(r.journeys[0],r.journeys[1])<0);
});
test('V2 inventory class DP minimizes switches among observed equally usable choices',()=>{
  const selected=chooseClasses([[{travelClass:'SL',status:'AVAILABLE'},{travelClass:'3A',status:'AVAILABLE'}],[{travelClass:'3A',status:'AVAILABLE'}]]);assert.deepEqual(selected?.map(c=>c.travelClass),['3A','3A']);
});
test('V2 inventory final ranking and diagnostics are deterministic',async()=>{
  const run=()=>harness().run([candidate(),candidate(['30002','30003'])]);assert.deepEqual(await run(),await run());
});
test('V2 inventory mode budgets reuse existing product values',async()=>{
  const h=harness();for(const [mode,limit]of [['QUICK',12],['STANDARD',30],['DEEP',40]]as const)assert.equal((await h.run(undefined,{mode})).diagnostics.availabilityBudgetLimit,limit);
});
test('V2 inventory rejects invalid classes quota and configuration before calls',async()=>{
  const h=harness();await assert.rejects(h.run(undefined,{requestedClasses:['bad']}));await assert.rejects(h.run(undefined,{requestedClasses:['ALL','SL']}));await assert.rejects(h.run(undefined,{quota:'TQ' as 'GN'}));assert.equal(h.calls.length,0);
  await assert.rejects(harness(undefined,{budgetLimit:-1}).run());await assert.rejects(harness(undefined,{classRounds:[['SL']]}).run());
});

test('V2 inventory CLI is explicitly fake, keyless, offline and availability-only',t=>{
  const dir=mkdtempSync(join(tmpdir(),'v2-inventory-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const db=join(dir,'railway.sqlite');
  const run=(args:string[])=>spawnSync(process.execPath,['--import',pathToFileURL(resolve('src/local-railway/tests/network-denied.mjs')).href,'--import','tsx',...args],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:process.env.HOME}});
  const imported=run(['src/local-railway/cli.ts','import','--trains','src/local-railway/tests/fixtures/trains.csv','--stops','src/local-railway/tests/fixtures/stops.csv','--db',db]);assert.equal(imported.status,0,imported.stderr);
  const p=run(['src/journey/availability/cli.ts','AAA','DDD',date,'--fake','--json','--db',db]);assert.equal(p.status,0,p.stderr);const r=JSON.parse(p.stdout);assert.equal(r.inventoryMode,'FAKE_OFFLINE');assert.ok(r.plannerDiagnostics);assert.ok(r.diagnostics.plannerCandidatesReceived>0);assert.ok(r.diagnostics.availabilityRequestsUsed<=30);
  assert.notEqual(run(['src/journey/availability/cli.ts','AAA','DDD',date,'--db',db]).status,0);
  for(const name of ['orchestrator','service'])assert.doesNotMatch(readFileSync(resolve(`src/journey/availability/${name}.ts`),'utf8'),/\.(?:searchTrainsBetweenStations|getTrainInfo)\s*\(/);
});
test('V2 inventory cached provider failures do not retry shared requests',async()=>{
  const h=harness(()=>{throw new Error('offline failure');});const r=await h.run([candidate(),candidate()]);assert.equal(h.calls.length,1);assert.equal(r.diagnostics.providerErrors,1);assert.equal(r.diagnostics.availabilityCacheHits,1);assert.ok(r.journeys.every(j=>j.status==='INVENTORY_CHECK_INCOMPLETE'));
});
test('V2 inventory later class success revisits other legs with cumulative classes',async()=>{
  const c=candidate(['30001','30002']);c.segments[1].distanceKm=800;
  const h=harness(r=>answer(r,r.travelClass===(r.trainNumber==='30002'?'2A':'SL')?'AVAILABLE':'WAITLIST'));
  const r=await h.run([c],{requestedClasses:['ALL']});assert.equal(r.journeys[0].status,'FULLY_RESERVED_USABLE');assert.deepEqual(r.journeys[0].legs.map(l=>l.selectedClass),['SL','2A']);
});
test('V2 inventory no known requested classes avoids provider entirely',async()=>{
  const h=harness();const r=await h.run(undefined,{supportedClassesByTrain:{'30001':['CC']}});assert.equal(h.calls.length,0);assert.equal(r.journeys[0].status,'SCHEDULED_BUT_NOT_FULLY_AVAILABLE');
});
test('V2 inventory missing all fares keeps usable journey',async()=>{
  const h=harness(r=>{const a=answer(r);delete a.fare;return a;});const j=(await h.run()).journeys[0];assert.equal(j.status,'FULLY_RESERVED_USABLE');assert.equal(j.totalFare.status,'UNKNOWN');assert.equal(j.totalFare.amount,null);
});
test('V2 inventory ALL reuses cached usable class with zero spare budget',async()=>{
  const h=harness(r=>answer(r,r.travelClass==='3A'?'AVAILABLE':'WAITLIST'),{budgetLimit:2});const r=await h.run([candidate(),candidate()],{requestedClasses:['ALL']});
  assert.equal(h.calls.length,2);assert.equal(r.diagnostics.budgetRemaining,0);assert.equal(r.diagnostics.usableJourneysFound,2);assert.equal(r.diagnostics.availabilityCacheHits,1);
});
test('V2 inventory explicit unsupported class remains scoped to the failing route',async()=>{
  const h=harness(r=>{if(r.trainNumber==='30001'&&r.toStationCode==='ZZZ')throw{failureCategory:'UNSUPPORTED_CLASS'};return answer(r);});
  const r=await h.run([candidate(),candidate(['30001','30002'])]);assert.equal(h.calls.length,3);assert.equal(r.diagnostics.unsupportedClassResponses,1);assert.equal(r.diagnostics.providerErrors,0);assert.equal(r.diagnostics.providerErrorCategories.UNSUPPORTED_CLASS,undefined);assert.equal(r.journeys.find(j=>j.legs.length===1)?.status,'SCHEDULED_BUT_NOT_FULLY_AVAILABLE');assert.equal(r.journeys.find(j=>j.legs.length===2)?.status,'FULLY_RESERVED_USABLE');
});

for(const state of ['AVAILABLE','RAC'] as const)test(`V2 ${state} with canBook=false stays incomplete`,async()=>{
 const h=harness(r=>({...answer(r,state),days:[{date:r.journeyDate,state,canBook:false}]}));
 const result=await h.run();assert.equal(result.journeys[0].status,'INVENTORY_CHECK_INCOMPLETE');
 assert.equal(result.journeys[0].legs[0].availabilityStatus,'PROVIDER_ERROR');assert.equal(result.diagnostics.usableJourneysFound,0);assert.equal(result.diagnostics.unavailableResponses,0);
});
