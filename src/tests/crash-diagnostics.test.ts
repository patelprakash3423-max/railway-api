import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {memoryPhase,withSearchMemoryDiagnostics} from '../utils/search-memory.js';

test('phase diagnostics isolate concurrent request context and tolerate logger failure',async()=>{
 const records:Record<string,unknown>[]=[];
 await Promise.all(['one','two'].map(requestId=>withSearchMemoryDiagnostics(requestId,r=>records.push(r),async()=>{
  await new Promise<void>(r=>setImmediate(r));
  assert.equal(memoryPhase('planner',()=>requestId),requestId);
 })));
 assert.deepEqual(records.map(r=>[r.requestId,r.event]),[['one','journey_v2_planner_started'],['one','journey_v2_planner_completed'],['two','journey_v2_planner_started'],['two','journey_v2_planner_completed']]);
 withSearchMemoryDiagnostics('throwing',()=>{throw Error('logger failed');},()=>{
  assert.equal(memoryPhase('network_build',()=>42),42);
  assert.throws(()=>memoryPhase('planner',()=>{throw Error('original');}),/original/);
 });
});

for(const origin of ['uncaughtException','unhandledRejection'])test(`fatal monitor logs ${origin} without preventing nonzero exit`,()=>{
 const child=spawnSync(process.execPath,['--import','./src/test-support/local-network-only.mjs','--import','tsx','--unhandled-rejections=throw','--input-type=module'],{
  encoding:'utf8',timeout:15000,env:{...process.env,RAILKIT_API_KEY:'diagnostic-test-secret'},input:`
   import {installCrashDiagnostics} from './src/utils/crash-diagnostics.ts';
   import {withSearchMemoryDiagnostics} from './src/utils/search-memory.ts';
   installCrashDiagnostics();installCrashDiagnostics();
   withSearchMemoryDiagnostics('fatal-request',()=>{},()=>{
    ${origin==='uncaughtException'?"setImmediate(()=>{throw Error('diagnostic-test-secret');});":"void Promise.reject(Error('diagnostic-test-secret'));"}
   });
  `});
 assert.equal(child.error,undefined);assert.equal(child.status,1,child.stderr);
 const lines=child.stderr.split('\n').filter(line=>line.startsWith('{'));
 assert.equal(lines.length,1,child.stderr);
 const record=JSON.parse(lines[0]);assert.equal(record.event,'process_uncaught_exception');assert.equal(record.origin,origin);
 assert.equal(record.requestId,'fatal-request');assert.ok(record.rss>0);assert.ok(record.heapUsed>0);assert.ok(record.elapsedMs>=0);
 assert.doesNotMatch(lines[0],/diagnostic-test-secret/);assert.match(record.stack,/\[REDACTED\]/);
});
