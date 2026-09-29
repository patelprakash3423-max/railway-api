import test from 'node:test';
import assert from 'node:assert/strict';
import {beginSearchTiming,timeSearchAsync,withSearchTiming} from '../utils/search-timing.js';
import {availabilityMetric,availabilitySdkInvoked} from '../providers/availability-observation.js';
import {AvailabilityScheduler} from '../providers/railkit/availability-scheduler.js';
import {hardeningConfig} from '../config/hardening.js';

test('timing summary retains active work at timeout and completed nested spans',async()=>{
 const records:any[]=[];let finish=()=>{};
 await assert.rejects(withSearchTiming('timeout',r=>records.push(r),async()=>{
  finish=beginSearchTiming('provider_invoke');
  await timeSearchAsync('sqlite_read',async()=>42);
  throw Error('deadline');
 }),/deadline/);
 const summary=records[0];assert.equal(summary.requestId,'timeout');
 assert.equal(summary.phases.provider_invoke.active,1);assert.equal(summary.phases.provider_invoke.completed,0);
 assert.equal(summary.phases.sqlite_read.completed,1);assert.ok(summary.phases.sqlite_read.p95UpperBoundMs>=1);
 finish();finish();assert.equal(summary.phases.provider_invoke.active,1);
});
test('controlled timing reports mean, p95 bound, duplicate timestamps and SDK counters',async t=>{
 let clock=0;const records:any[]=[];
 t.mock.method(performance,'now',()=>clock);
 await withSearchTiming('controlled',r=>records.push(r),async()=>{
  const first=beginSearchTiming('solver'),second=beginSearchTiming('solver');clock=5;first();second();first();
  for(const ms of [100,200,300,400])await timeSearchAsync('provider_invoke',async()=>{clock+=ms;availabilitySdkInvoked();});
  availabilityMetric('providerQueueWaitMs',25);
 });
 const row=records[0].phases.provider_invoke;
 assert.equal(row.averageMs,250);assert.equal(row.totalMs,1000);assert.equal(row.p95UpperBoundMs,500);
 assert.equal(records[0].phases.solver.completed,2);assert.equal(records[0].phases.solver.active,0);
 assert.deepEqual(records[0].counters,{actualSdkInvocations:4,providerQueueWaitMs:25});
});
test('scheduler timing separates queue wait from invocation and includes shared waiters',async()=>{
 const scheduler=new AvailabilityScheduler({...hardeningConfig({}),providerConcurrency:1});
 const request={trainNumber:'30001',fromStationCode:'AAA',toStationCode:'BBB',journeyDate:'19-10-2026',travelClass:'SL',quota:'GN' as const};
 let resolve!:(v:unknown)=>void;const pending=new Promise(r=>{resolve=r;});const records:any[]=[];
 await withSearchTiming('queue',r=>records.push(r),async()=>{
  const one=scheduler.execute(request,()=>pending);
  const two=scheduler.execute(request,async()=>{throw Error('must share');});
  const three=scheduler.execute({...request,travelClass:'3A'},async()=>({success:false,error:'offline'}));
  resolve({success:false,error:'offline'});await Promise.all([one,two,three]);
 });
 assert.equal(records[0].phases.scheduler_wait.completed,3);
 assert.equal(records[0].phases.scheduler_queue.completed,3);
 assert.equal(records[0].phases.provider_invoke.completed,2);
 assert.equal(records[0].counters.sharedInflightHits,1);
});
test('timing isolates requests and logging failure preserves original outcome',async()=>{
 const records:any[]=[];
 await Promise.all(['a','b'].map(id=>withSearchTiming(id,r=>records.push(r),()=>timeSearchAsync('availability_check',async()=>id))));
 assert.deepEqual(records.map(r=>r.requestId).sort(),['a','b']);
 assert.ok(records.every(r=>r.phases.availability_check.completed===1));
 assert.equal(await withSearchTiming('quiet',()=>{throw Error('logging');},async()=>42),42);
});
