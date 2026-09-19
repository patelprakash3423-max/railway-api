import {pathToFileURL} from 'node:url';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {RailwayDatabase} from '../database.js';
import type {LocalDataset} from '../types.js';
import type {AvailabilityRequest,AvailabilityResult} from '../../domain/types/availability.js';
import {AvailabilitySession} from '../../journey/availability/session.js';
import {AvailabilityOrchestrator} from '../../journey/availability/orchestrator.js';
import {recoverSingleTrainLeg} from '../../journey/availability/recovery/recover.js';
import {rankRecovery} from '../../journey/availability/recovery/paths.js';
import type {RecoveryInput,RecoveryLimits} from '../../journey/availability/recovery/types.js';
import {requestKey} from '../../journey/availability/inventory.js';
import type {V2Journey} from '../planner/v2/types.js';
const date='18-09-2026';
const iso=(m:number)=>new Date(Date.UTC(2026,8,18,0,m)).toISOString().slice(0,16)+':00+05:30';
function setup(t:TestContext,distances:(number|undefined)[]=[0,300,700,1000],times=distances.map((_,i)=>360+i*180)){
  const codes=distances.map((_,i)=>String.fromCharCode(65+i)),trainNumber='30001';
  const data:LocalDataset={stations:codes.map(code=>({code,name:code})),trains:[{number:trainNumber,name:'Synthetic recovery',sourceCode:codes[0],destinationCode:codes.at(-1)!,runningDaysRaw:'Daily',runningDays:['MON','TUE','WED','THU','FRI','SAT','SUN']}],stops:codes.map((code,i)=>({trainNumber,stationCode:code,sequence:i+1,dayOffset:Math.floor(times[i]/1440),arrivalTime:i?iso(times[i]).slice(11,16):undefined,departureTime:i<codes.length-1?iso(times[i]).slice(11,16):undefined,distanceKm:distances[i]})),metadata:{source:'RAILPULL_NTES',importedAt:'2026-09-13T00:00:00Z',trainCount:1,stationCount:codes.length,stopCount:codes.length}};
  const db=new RailwayDatabase(':memory:');db.replace(data);t.after(()=>db.close());
  const input:RecoveryInput={trainNumber,fromStation:codes[0],toStation:codes.at(-1)!,boardingDateTime:iso(times[0]),arrivalDateTime:iso(times.at(-1)!),distanceKm:distances.at(-1)!-distances[0]!,requestedClasses:['SL','3A']};
  return{db,input};
}
type Status='AVAILABLE'|'RAC'|'WAITLIST'|'NOT_AVAILABLE';
function provider(rule:(r:AvailabilityRequest)=>Status|Promise<Status>=()=> 'WAITLIST',fare:(r:AvailabilityRequest)=>number|undefined=()=>100){
  const calls:AvailabilityRequest[]=[];
  return{calls,getAvailability:async(r:AvailabilityRequest):Promise<AvailabilityResult>=>{calls.push({...r});const state=await rule(r),price=fare(r);return{request:{...r},provider:'railkit',providerState:'SUCCESS',days:[{date:r.journeyDate,state,availabilityText:state}],fare:price===undefined?undefined:{currency:'INR',totalFare:price}};},getTrainInfo:async()=>{throw new Error('Forbidden info');},searchTrainsBetweenStations:async()=>{throw new Error('Forbidden discovery');}};
}
const key=(r:AvailabilityRequest)=>`${r.fromStationCode}-${r.toStationCode}-${r.travelClass}`;
async function run(t:TestContext,answers:Record<string,Status>,distances:(number|undefined)[]=[0,300,700,1000],options:Partial<RecoveryLimits>={},budget=100){
  const {db,input}=setup(t,distances),p=provider(r=>answers[key(r)]??'WAITLIST'),session=new AvailabilitySession(p,budget);
  const result=await recoverSingleTrainLeg(db,session,input,options);return{...result,p,session,db,input};
}
for(const state of ['AVAILABLE','RAC']as const)test(`V2 recovery full interval ${state}`,async t=>{
  const r=await run(t,{'A-D-SL':state});assert.equal(r.best.recoveryStatus,'FULL_RESERVED_SINGLE_CLASS');assert.equal(r.best.reservedCoverageRatio,1);assert.equal(r.best.trainChanges,0);assert.equal(r.best.segments.length,1);
});
test('V2 recovery WAITLIST never counts as reserved',async t=>{const r=await run(t,{});assert.equal(r.best.recoveryStatus,'NO_USABLE_RECOVERY');assert.equal(r.best.reservedCoverageRatio,0);assert.equal(r.solutions.length,0);assert.ok(r.best.waitlistChecks>0);});
test('V2 recovery full split class and RAC plus AVAILABLE',async t=>{
  const r=await run(t,{'A-B-SL':'AVAILABLE','B-D-3A':'RAC'});assert.equal(r.best.recoveryStatus,'FULL_RESERVED_SPLIT_CLASS');assert.equal(r.best.reservedCoverageRatio,1);assert.equal(r.best.classChanges,1);assert.equal(r.best.trainChanges,0);assert.equal(r.best.racSegmentCount,1);assert.equal(r.best.availableSegmentCount,1);
});
test('V2 recovery adjacent same class merges display but preserves exact reservation evidence',async t=>{
  const r=await run(t,{'A-B-SL':'AVAILABLE','B-D-SL':'AVAILABLE'});assert.equal(r.best.recoveryStatus,'FULL_RESERVED_SINGLE_CLASS');assert.equal(r.best.segments.length,1);const s=r.best.segments[0];assert.equal(s.type,'RESERVED');if(s.type==='RESERVED'){assert.equal(s.reservationParts.length,2);assert.equal(s.fare?.totalFare,200);assert.equal(s.fromStation,'A');assert.equal(s.toStation,'D');}assert.ok(r.checks.some(c=>c.fromStation==='A'&&c.toStation==='D'&&c.check.status==='WAITLIST'));
});
for(const [name,answer,types]of[
  ['alternate boarding',{'B-D-SL':'AVAILABLE'},['SELF_MANAGED','RESERVED']],
  ['alternate drop',{'A-C-SL':'AVAILABLE'},['RESERVED','SELF_MANAGED']],
  ['both edges uncovered',{'B-C-SL':'AVAILABLE'},['SELF_MANAGED','RESERVED','SELF_MANAGED']],
]as const)test(`V2 recovery ${name}`,async t=>{const r=await run(t,answer,[0,200,800,1000]);assert.equal(r.best.recoveryStatus,'PARTIAL_RESERVED_RECOVERY');assert.deepEqual(r.best.segments.map(s=>s.type),types);assert.ok(r.best.reservedCoverageRatio>=.5);assert.equal(r.best.fareComplete,false);});
test('V2 recovery middle gap stays explicitly self managed',async t=>{
  const r=await run(t,{'A-B-SL':'AVAILABLE','C-D-3A':'AVAILABLE'},[0,300,700,1000]);assert.equal(r.best.recoveryStatus,'PARTIAL_RESERVED_RECOVERY');assert.equal(r.best.reservedCoverageRatio,.6);assert.deepEqual(r.best.segments.map(s=>s.type),['RESERVED','SELF_MANAGED','RESERVED']);const gap=r.best.segments[1];assert.equal(gap.distanceKm,400);assert.ok(!('fare'in gap));assert.ok(!('availabilityStatus'in gap));assert.ok(!('trainNumber'in gap));
});
for(const [km,expected]of [[500,'PARTIAL_RESERVED_RECOVERY'],[490,'NO_USABLE_RECOVERY']]as const)test(`V2 recovery ${km/10}% threshold uses kilometers`,async t=>{
  const r=await run(t,{'A-B-SL':'AVAILABLE'},[0,km,900,1000]);assert.equal(r.best.reservedCoverageRatio,km/1000);assert.equal(r.best.recoveryStatus,expected);assert.equal(r.solutions.length>0,km===500);
});
test('V2 recovery configurable threshold remains separate from detour bounds',async t=>{const r=await run(t,{'A-C-SL':'AVAILABLE'},[0,100,700,1000],{minimumReservedCoverageRatio:.8});assert.equal(r.best.recoveryStatus,'NO_USABLE_RECOVERY');assert.equal(r.diagnostics.minimumReservedCoverageRatio,.8);});
test('V2 recovery distance not stop-count coverage',async t=>{const r=await run(t,{'D-E-SL':'AVAILABLE'},[0,10,20,100,1000]);assert.equal(r.best.reservedCoverageRatio,.9);assert.equal(r.best.selfManagedDistanceKm,100);});
test('V2 recovery two class changes via three reserved edges',async t=>{
  const r=await run(t,{'A-B-SL':'AVAILABLE','B-C-3A':'AVAILABLE','C-D-SL':'AVAILABLE'});assert.equal(r.best.recoveryStatus,'FULL_RESERVED_SPLIT_CLASS');assert.equal(r.best.classChanges,2);assert.equal(r.best.reservedSegmentCount,3);
});
test('V2 recovery fare aggregation and missing-fare partial sum',async t=>{
  const {db,input}=setup(t),p=provider(r=>['A-B-SL','B-D-3A'].includes(key(r))?'AVAILABLE':'WAITLIST',r=>r.fromStationCode==='A'?150:undefined);const r=await recoverSingleTrainLeg(db,new AvailabilitySession(p,100),input);assert.equal(r.best.reservedCoverageRatio,1);assert.equal(r.best.totalKnownFare,150);assert.equal(r.best.fareComplete,false);
});
test('V2 recovery repeated intervals use same session cache without new budget',async t=>{
  const {db,input}=setup(t),p=provider(r=>key(r)==='A-D-SL'?'AVAILABLE':'WAITLIST'),session=new AvailabilitySession(p,2);const first=await recoverSingleTrainLeg(db,session,input);const second=await recoverSingleTrainLeg(db,session,input);assert.equal(first.best.reservedCoverageRatio,1);assert.equal(p.calls.length,1);assert.equal(second.diagnostics.availabilityRequestsUsed,0);assert.equal(second.diagnostics.availabilityCacheHits,1);
});
test('V2 recovery reuses actual availability orchestrator budget and full-interval cache',async t=>{
  const {db,input}=setup(t),p=provider(()=> 'AVAILABLE'),session=new AvailabilitySession(p,1);
  const leg={trainNumber:'30001',trainName:'Synthetic',from:'A',to:'D',fromStation:'A',toStation:'D',boardingDate:date,originDate:date,departureDateTime:input.boardingDateTime,boardingDateTime:input.boardingDateTime,arrivalDateTime:input.arrivalDateTime,distanceKm:1000};
  const j:V2Journey={from:'A',to:'D',departureDateTime:leg.departureDateTime,arrivalDateTime:leg.arrivalDateTime,durationMinutes:540,changes:0,segments:[leg],connections:[],totalDistanceKm:1000,interchangeTiers:[],distanceDetourPercent:0,durationDetourPercent:0};
  await new AvailabilityOrchestrator(p).validate({source:'A',destination:'D',journeyDate:date,requestedClasses:['SL'],plannerCandidates:[j]},session);
  const r=await recoverSingleTrainLeg(db,session,input);assert.equal(p.calls.length,1);assert.equal(session.remaining,0);assert.equal(r.best.recoveryStatus,'FULL_RESERVED_SINGLE_CLASS');assert.equal(r.diagnostics.availabilityCacheHits,1);assert.equal(r.diagnostics.availabilityRequestsUsed,0);
});
test('V2 recovery exhausted budget yields incomplete, not false inventory failure',async t=>{const r=await run(t,{},undefined,{},0);assert.equal(r.best.recoveryStatus,'INVENTORY_CHECK_INCOMPLETE');assert.equal(r.p.calls.length,0);assert.ok(r.diagnostics.truncated);});
test('V2 recovery atomic interval class round defers without partial spend',async t=>{const r=await run(t,{'A-D-SL':'AVAILABLE'},undefined,{},1);assert.equal(r.p.calls.length,0);assert.ok(r.diagnostics.atomicIntervalDeferrals>0);});
test('V2 recovery split pair atomic reservation shares prior full-leg spending',async t=>{
  const r=await run(t,{'A-B-SL':'AVAILABLE','B-D-3A':'AVAILABLE'},undefined,{},3);assert.equal(r.p.calls.length,2);assert.equal(r.diagnostics.budgetRemaining,1);assert.equal(r.best.recoveryStatus,'INVENTORY_CHECK_INCOMPLETE');
});
test('V2 recovery provider errors remain incomplete and do not become WAITLIST',async t=>{
  const {db,input}=setup(t),p=provider(()=>{throw{status:429};});const r=await recoverSingleTrainLeg(db,new AvailabilitySession(p,100),input);assert.equal(r.best.recoveryStatus,'INVENTORY_CHECK_INCOMPLETE');assert.ok(r.diagnostics.providerErrors);assert.equal(r.best.waitlistChecks,0);
});
test('V2 recovery multi-day interval boarding uses intermediate departure day',async t=>{
  const {db,input}=setup(t,[0,300,700,1000],[1200,1500,1800,2100]),p=provider(r=>key(r)==='B-D-SL'?'AVAILABLE':'WAITLIST');await recoverSingleTrainLeg(db,new AvailabilitySession(p,100),input);assert.ok(p.calls.some(r=>r.fromStationCode==='B'&&r.journeyDate==='19-09-2026'));assert.ok(p.calls.filter(r=>r.fromStationCode==='A').every(r=>r.journeyDate===date));
});
test('V2 recovery missing intermediate distance skips split, no equal-stop estimate',async t=>{const r=await run(t,{'A-C-SL':'AVAILABLE'},[0,undefined,700,1000]);assert.equal(r.best.reservedCoverageRatio,.7);assert.equal(r.diagnostics.missingDistanceStopsSkipped,1);assert.ok(r.p.calls.every(r=>r.fromStationCode!=='B'&&r.toStationCode!=='B'));});
test('V2 recovery unknown endpoint distance rejects before any inventory request',async t=>{
  const {db,input}=setup(t);db.db.prepare("UPDATE train_stops SET distance_km=NULL WHERE sequence=4").run();const p=provider();await assert.rejects(recoverSingleTrainLeg(db,new AvailabilitySession(p,100),input),/endpoint distances/);assert.equal(p.calls.length,0);
});
test('V2 recovery bounded split/interval caps report truncation',async t=>{const r=await run(t,{},[0,100,200,300,400,500,600,700,800,900,1000],{maxSplitPoints:2,maxIntervals:3});assert.ok(r.diagnostics.candidateIntervalsGenerated<=3);assert.ok(r.diagnostics.truncated);assert.ok(r.diagnostics.truncationReasons.includes('splitPoints'));});
test('V2 recovery full beats partial; higher coverage beats fewer class changes',async t=>{
  const full=await run(t,{'A-B-SL':'AVAILABLE','B-D-3A':'AVAILABLE'}),partial=await run(t,{'B-D-SL':'AVAILABLE'});assert.ok(rankRecovery(full.best,partial.best)<0);
  const higher={...partial.best,reservedCoverageRatio:.9,reservedDistanceKm:900,classChanges:2};assert.ok(rankRecovery(higher,partial.best)<0);
});
test('V2 recovery AVAILABLE beats RAC at equal reserved coverage',async t=>{const a=await run(t,{'B-D-SL':'AVAILABLE'}),b=await run(t,{'B-D-SL':'RAC'});assert.ok(rankRecovery(a.best,b.best)<0);});
test('V2 recovery deterministic output and request order',async t=>{const a=await run(t,{'A-B-SL':'AVAILABLE','B-D-3A':'AVAILABLE'}),b=await run(t,{'A-B-SL':'AVAILABLE','B-D-3A':'AVAILABLE'});assert.deepEqual(a.best,b.best);assert.deepEqual(a.diagnostics,b.diagnostics);assert.deepEqual(a.p.calls,b.p.calls);assert.equal(new Set(a.p.calls.map(requestKey)).size,a.p.calls.length);});
test('V2 recovery rejects mismatched scheduled endpoints and times',async t=>{const {db,input}=setup(t),p=provider(),session=new AvailabilitySession(p,20);await assert.rejects(recoverSingleTrainLeg(db,session,{...input,distanceKm:999}));await assert.rejects(recoverSingleTrainLeg(db,session,{...input,arrivalDateTime:iso(901)}));assert.equal(p.calls.length,0);});
test('V2 recovery uses class metadata and widens classes without provider info',async t=>{const {db,input}=setup(t),p=provider(()=> 'AVAILABLE');const r=await recoverSingleTrainLeg(db,new AvailabilitySession(p,10),{...input,requestedClasses:['ALL'],supportedClasses:['CC']});assert.equal(r.best.recoveryStatus,'FULL_RESERVED_SINGLE_CLASS');assert.deepEqual(p.calls.map(r=>r.travelClass),['CC']);});

test('V2 recovery CLI is keyless, fake-only and free of discovery/info calls',t=>{
  const dir=mkdtempSync(join(tmpdir(),'recovery-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const db=join(dir,'railway.sqlite');
  const run=(args:string[])=>spawnSync(process.execPath,['--import',pathToFileURL(resolve('src/local-railway/tests/network-denied.mjs')).href,'--import','tsx',...args],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:process.env.HOME}});
  const imported=run(['src/local-railway/cli.ts','import','--trains','src/local-railway/tests/fixtures/trains.csv','--stops','src/local-railway/tests/fixtures/stops.csv','--db',db]);assert.equal(imported.status,0,imported.stderr);
  const args=['src/journey/availability/recovery/cli.ts','10012','BBB','EEE',date,'--db',db];
  assert.notEqual(run(args).status,0);const p=run([...args,'--fake','--json']);assert.equal(p.status,0,p.stderr);const r=JSON.parse(p.stdout);assert.equal(r.inventoryMode,'FAKE_OFFLINE');assert.equal(r.best.recoveryStatus,'FULL_RESERVED_SPLIT_CLASS');
  for(const file of ['recover','local-leg','paths'])assert.doesNotMatch(readFileSync(resolve(`src/journey/availability/recovery/${file}.ts`),'utf8'),/\.(?:searchTrainsBetweenStations|getTrainInfo)\s*\(/);
});
test('V2 shared session deduplicates concurrent exact requests and failures',async()=>{
  const p=provider(async()=>{await Promise.resolve();return 'WAITLIST' as const;}),session=new AvailabilitySession(p,1);
  const r:AvailabilityRequest={trainNumber:'30001',fromStationCode:'A',toStationCode:'D',journeyDate:date,travelClass:'SL',quota:'GN'};
  const results=await Promise.all([session.get(r),session.get(r)]);assert.equal(p.calls.length,1);assert.deepEqual(results[0],results[1]);assert.equal(session.statistics().availabilityCacheHits,1);assert.equal(session.remaining,0);
});
test('V2 recovery cached unavailable whole leg leaves remaining shared budget for intervals',async t=>{
  const {db,input}=setup(t),p=provider(r=>['A-B-SL','B-D-3A'].includes(key(r))?'AVAILABLE':'WAITLIST'),session=new AvailabilitySession(p,8);
  for(const travelClass of ['SL','3A'])await session.get({trainNumber:input.trainNumber,fromStationCode:'A',toStationCode:'D',journeyDate:date,travelClass,quota:'GN'});
  const r=await recoverSingleTrainLeg(db,session,input);assert.equal(r.best.recoveryStatus,'FULL_RESERVED_SPLIT_CLASS');assert.equal(r.diagnostics.availabilityCacheHits,2);assert.equal(r.diagnostics.availabilityRequestsUsed,3);assert.equal(session.statistics().availabilityRequestsUsed,5);assert.equal(session.remaining,3);
});

for(const state of ['AVAILABLE','RAC'] as const)test(`V2 recovery ${state} canBook=false cannot cover any interval`,async t=>{
 const {db,input}=setup(t);
 const p={getAvailability:async(r:AvailabilityRequest):Promise<AvailabilityResult>=>({request:r,provider:'railkit',providerState:'SUCCESS',days:[{date:r.journeyDate,state,canBook:false}]})};
 const session=new AvailabilitySession(p,100),result=await recoverSingleTrainLeg(db,session,input);
 assert.equal(result.best.reservedCoverageRatio,0);assert.equal(result.best.recoveryStatus,'INVENTORY_CHECK_INCOMPLETE');
 assert.equal(result.solutions.length,0);assert.equal(session.statistics().unavailableResponses,0);
});
