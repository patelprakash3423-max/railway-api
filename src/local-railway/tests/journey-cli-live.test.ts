import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {LocalDataset} from '../types.js';
import {RailwayDatabase} from '../database.js';
import {runJourneyCli} from '../../journey/availability/journey/cli-runner.js';
import type {AvailabilityRequest,AvailabilityResult} from '../../domain/types/availability.js';

function setup(t:TestContext){
  const dir=mkdtempSync(join(tmpdir(),'journey-live-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'railway.sqlite'),db=new RailwayDatabase(path);
  const trains:LocalDataset['trains']=Array.from({length:30},(_,i)=>({number:String(40001+i),name:`Train ${i}`,sourceCode:'AAA',destinationCode:'CCC',runningDaysRaw:'Daily',runningDays:['MON','TUE','WED','THU','FRI','SAT','SUN']}));
  db.replace({stations:['AAA','BBB','CCC'].map(code=>({code,name:code})),trains,stops:trains.flatMap(train=>['AAA','BBB','CCC'].map((stationCode,i)=>({trainNumber:train.number,stationCode,sequence:i+1,dayOffset:0,arrivalTime:i?['06:00','09:00','12:00'][i]:undefined,departureTime:i<2?['06:00','09:00','12:00'][i]:undefined,distanceKm:i*300}))),metadata:{source:'RAILPULL_NTES',importedAt:'2026-09-14T00:00:00Z',trainCount:30,stationCount:3,stopCount:90}});db.close();
  return ['AAA','CCC','18-09-2026','--db',path,'--classes','ALL','--mode','STANDARD'];
}
function stub(){
  let created=0,discovery=0,info=0;const calls:AvailabilityRequest[]=[];
  const provider={getAvailability:async(r:AvailabilityRequest):Promise<AvailabilityResult>=>{calls.push(r);return {request:r,provider:'railkit',providerState:'SUCCESS',days:[{date:r.journeyDate,state:'WAITLIST'}]};},getTrainInfo:async()=>{info++;throw Error('Forbidden info');},searchTrainBetweenStations:async()=>{discovery++;throw Error('Forbidden discovery');},searchTrainsBetweenStations:async()=>{discovery++;throw Error('Forbidden discovery');}};
  return {calls,createLiveProvider:async()=>{created++;return provider;},counts:()=>({created,discovery,info})};
}
for(const flags of [[],['--fake','--live'],['--fake','--live','--confirm-live']])test(`journey CLI requires exactly one inventory mode: ${flags.join(' ')}`,async()=>{
  const p=stub();await assert.rejects(runJourneyCli(['AAA','CCC','18-09-2026',...flags],p),/exactly one/);assert.equal(p.calls.length,0);assert.equal(p.counts().created,0);
});
test('journey CLI live confirmation guard precedes database and provider construction',async()=>{
  const p=stub();await assert.rejects(runJourneyCli(['AAA','CCC','18-09-2026','--db','/missing/database','--live'],p),/requires --confirm-live/);assert.equal(p.calls.length,0);assert.deepEqual(p.counts(),{created:0,discovery:0,info:0});
});
test('journey CLI fake output and provider behavior remain unchanged',async t=>{
  const args=setup(t),p=stub(),output:string[]=[],summary:string[]=[];
  const r=await runJourneyCli([...args,'--fake','--json'],{...p,log:s=>output.push(s),summary:s=>summary.push(s)});
  const payload=JSON.parse(output[0]);assert.equal(payload.inventoryMode,'FAKE_OFFLINE');assert.deepEqual(payload.syntheticSupportedClasses,['SL','3A']);assert.deepEqual(payload.journeys,JSON.parse(JSON.stringify(r.journeys)));assert.equal(summary.length,0);assert.equal(output.length,1);assert.equal(p.calls.length,0);assert.equal(p.counts().created,0);
});
test('journey CLI confirmed live stub shares a hard STANDARD 30-call budget with recovery',async t=>{
  const args=setup(t),p=stub(),output:string[]=[],summaries:string[]=[];
  const r=await runJourneyCli([...args,'--live','--confirm-live','--json'],{...p,log:s=>output.push(s),summary:s=>summaries.push(s)});
  const d=r.diagnostics;assert.equal(d.availabilityBudgetLimit,30);assert.ok(p.calls.length<=30);assert.ok(p.calls.length>=24);assert.equal(p.calls.length,d.availabilityRequestsUsed);assert.equal(d.wholeLegRequests+d.recoveryIntervalRequests,p.calls.length);assert.ok(d.wholeLegRequests>0);assert.ok(d.recoveryIntervalRequests>0);assert.deepEqual(p.counts(),{created:1,discovery:0,info:0});
  const payload=JSON.parse(output[0]);assert.equal(payload.inventoryMode,'LIVE');assert.ok(!('syntheticSupportedClasses'in payload));
  for(const label of ['Planner candidates','Whole-leg requests','Recovery requests','Availability calls','Cache hits','Budget used','Fully reserved','Full split','Partial recovery','Scheduled fallback','Inventory incomplete','Global budget','Whole-leg calls','Recovery calls','Released reserve calls','Budget remaining','Recovery reserve initial','Recovery reserve used','Recovery reserve released','Candidates checked whole-leg','Candidates sent to recovery','Recovery attempts','Recovery successes','AVAILABLE','RAC','WAITLIST','UNSUPPORTED_CLASS','PROVIDER_ERROR'])assert.ok(summaries[0].includes(`${label}: `));
  assert.match(summaries[0],/Discovery calls: 0\nTrain-info calls: 0/);
});
