import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { RailwayDatabase } from '../database.js';
import type { LocalDataset, LocalTrainStop, Weekday } from '../types.js';
import { LocalJourneyPlannerV2, stateDominates, type SearchState } from '../planner/v2/planner.js';
import { deriveMaxChanges, type V2Journey, type V2Limits } from '../planner/v2/types.js';
import { networkFor, lowerBounds, routeSql } from '../planner/v2/network.js';
import { candidateDominates, diversify, rankV2 } from '../planner/v2/ranking.js';
const request = { from: 'AAA', to: 'ZZZ', date: '18-09-2026' };
interface Service { number?: string; codes: string[]; times: number[]; distances: (number | undefined)[]; days?: Weekday[]; dwell?: number }
const service = (codes: string[], times: number[], distances: number[]): Service => ({ codes, times, distances });
function fixture(t: TestContext, services: Service[]): RailwayDatabase {
  const data: LocalDataset = { stations: [], trains: [], stops: [], metadata: { source: 'RAILPULL_NTES', importedAt: '2026-09-13T00:00:00Z', label: 'V2_SYNTHETIC', trainCount: services.length, stationCount: 0, stopCount: 0 } };
  const clock = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  services.forEach((s, index) => {
    const number = s.number ?? String(30000 + index), runningDays = s.days ?? ['MON','TUE','WED','THU','FRI','SAT','SUN'];
    data.trains.push({ number, name: number, sourceCode: s.codes[0], destinationCode: s.codes.at(-1)!, runningDays, runningDaysRaw: runningDays.join(',') });
    s.codes.forEach((code, i) => {
      const arrival = s.times[i], departure = arrival + (i > 0 && i < s.codes.length - 1 ? s.dwell ?? 0 : 0);
      const stop: LocalTrainStop = { trainNumber: number, stationCode: code, sequence: i + 1, dayOffset: Math.floor(departure / 1440), arrivalDayOffset: Math.floor(arrival / 1440), arrivalTime: i ? clock(arrival) : undefined, departureTime: i < s.codes.length - 1 ? clock(departure) : undefined, distanceKm: s.distances[i] }; data.stops.push(stop);
      if (!data.stations.some(s => s.code === code)) data.stations.push({ code, name: code });
    });
  });
  data.metadata.stationCount = data.stations.length; data.metadata.stopCount = data.stops.length;
  const db = new RailwayDatabase(':memory:'); db.replace(data); t.after(() => db.close()); return db;
}
const direct = (distance = 1000, duration = 1000) => service(['AAA','ZZZ'], [360, 360 + duration], [0, distance]);
function search(t: TestContext, services: Service[], limits: Partial<V2Limits> = {}) { return new LocalJourneyPlannerV2(fixture(t, services), limits).search(request); }
function chain(legs: number, distance: number, duration = 150): Service[] {
  return Array.from({ length: legs }, (_, i) => service([i ? `X${i}` : 'AAA', i === legs - 1 ? 'ZZZ' : `X${i + 1}`], [420 + i * (duration + 30), 420 + i * (duration + 30) + duration], [0, distance / legs]));
}
for (const [distance, expected] of [[500,1],[1000,3],[1500,5],[2000,5]]) test(`V2 max changes ${distance}km`, () => assert.equal(deriveMaxChanges(distance), expected));
test('V2 direct baseline and explicit future inventory leg fields', t => {
  const r = search(t, [direct()]); assert.equal(r.journeys.length,1); assert.equal(r.diagnostics.baselineSource,'DIRECT');
  assert.equal(r.diagnostics.maxDistanceKm,1500); assert.equal(r.diagnostics.maxDurationMinutes,1500);
  const leg=r.journeys[0].segments[0];assert.equal(leg.fromStation,'AAA');assert.equal(leg.toStation,'ZZZ');assert.equal(leg.boardingDateTime,leg.departureDateTime);assert.equal(leg.distanceKm,1000);
});
for (const legs of [2,4,6]) test(`V2 ${legs-1}-change schedule found`, t => {
  const distance=legs===6?1500:1000;const r=search(t,[direct(distance,1500),...chain(legs,distance)]);
  assert.ok(r.journeys.some(j=>j.changes===legs-1)); assert.ok(r.journeys.every(j=>j.changes<=r.diagnostics.derivedMaxChanges));
});
test('V2 fallback baseline without direct service', t => { const r=search(t,chain(2,600));assert.equal(r.diagnostics.baselineSource,'BOUNDED_PATH');assert.equal(r.journeys[0].changes,1);assert.equal(r.diagnostics.baselineDistanceKm,600); });
test('V2 both hard detour bounds include equality and reject excess', t => {
  const r=search(t,[direct(),service(['AAA','ZZZ'],[400,1900],[0,1500]),service(['AAA','ZZZ'],[410,1410],[0,1501]),service(['AAA','ZZZ'],[420,1921],[0,1000])]);
  assert.equal(r.journeys.length,2); assert.ok(r.journeys.some(j=>j.totalDistanceKm===1500&&j.durationMinutes===1500));
  assert.ok(r.journeys.every(j=>j.totalDistanceKm<=1500&&j.durationMinutes<=1500));
});
for (const transfer of [29,30,360,361]) test(`V2 transfer ${transfer} minutes`, t => {
  const r=search(t,[direct(),service(['AAA','XXX'],[400,600],[0,500]),service(['XXX','ZZZ'],[600+transfer,800+transfer],[0,500])]);
  assert.equal(r.journeys.some(j=>j.changes===1),transfer>=30&&transfer<=360);
});
test('V2 unknown candidate distance is rejected, relaxed distance stays optimistic', t => {
  const broken=service(['AAA','ZZZ'],[400,900],[0,1000]);broken.distances[1]=undefined;
  const db=fixture(t,[direct(),broken]);const r=new LocalJourneyPlannerV2(db).search(request);
  assert.equal(r.journeys.length,1);assert.ok(r.diagnostics.statesUnknownDistancePruned>0);assert.equal(lowerBounds(networkFor(db),'ZZZ','distance').get('AAA'),0);
});
test('V2 train-origin weekdays and midnight arrival days', t => {
  const through:Service={codes:['OOO','AAA','BBB','ZZZ'],times:[1200,1470,2870,3000],distances:[0,100,500,1100],days:['THU'],dwell:30};
  const db=fixture(t,[through]);const r=new LocalJourneyPlannerV2(db).search(request);assert.equal(r.journeys.length,1);
  assert.equal(r.journeys[0].segments[0].originDate,'17-09-2026');assert.equal(r.journeys[0].segments[0].departureDateTime,'2026-09-18T01:00:00+05:30');assert.equal(r.journeys[0].arrivalDateTime,'2026-09-19T02:00:00+05:30');
  const fail=new LocalJourneyPlannerV2(db).search({...request,date:'19-09-2026'});assert.equal(fail.journeys.length,0);assert.ok(fail.diagnostics.statesCalendarPruned>0);
});
test('V2 midnight connection uses next boarding date',t=>{
  const r=search(t,[direct(1000,1500),service(['AAA','XXX'],[1200,1430],[0,500]),service(['XXX','ZZZ'],[20,220],[0,500])]);
  const j=r.journeys.find(j=>j.changes===1)!;assert.ok(j);assert.equal(j.connections[0].minutes,30);assert.equal(j.segments[1].boardingDate,'19-09-2026');
});
test('V2 loops across intermediate traversed stations are rejected', t => {
  const r=search(t,[direct(),service(['AAA','XXX','YYY'],[400,450,500],[0,100,200]),service(['YYY','XXX','ZZZ'],[540,590,700],[0,100,800])]);
  assert.ok(r.diagnostics.statesLoopPruned>0);assert.ok(!r.journeys.some(j=>j.segments.some(s=>s.from==='YYY')));
});
test('V2 cannot split and reuse the same train',t=>{
  const s:Service={codes:['AAA','XXX','ZZZ'],times:[400,600,1000],distances:[0,500,1000],dwell:60};
  const r=search(t,[s]);assert.ok(r.diagnostics.statesLoopPruned>0);assert.ok(r.journeys.every(j=>new Set(j.segments.map(s=>s.trainNumber)).size===j.segments.length));
});
test('V2 impossible chronology never becomes a candidate', t => { const r=search(t,[direct(),service(['AAA','ZZZ'],[900,800],[0,1000])]);assert.equal(r.journeys.length,1);assert.ok(r.diagnostics.statesTimingPruned>0); });
test('V2 progressive widening reaches small interchanges', t => {
  const r=search(t,[direct(),...chain(2,1000)]);assert.deepEqual(r.diagnostics.stagesAttempted,['DIRECT','MAJOR','MAJOR+MEDIUM','MAJOR+MEDIUM+SMALL']);assert.ok(r.journeys.some(j=>j.changes===1));
});
test('V2 enough strong direct choices avoid unnecessary widening',t=>{
  const r=search(t,[direct(),service(['AAA','ZZZ'],[400,1400],[0,1000])],{strongCandidateTarget:2});assert.deepEqual(r.diagnostics.stagesAttempted,['DIRECT']);
});
test('V2 major backward movement is pruned even inside detour bounds',t=>{
  const r=search(t,[direct(),service(['AAA','XXX'],[400,500],[0,100]),service(['XXX','ZZZ'],[540,1340],[0,1300])]);assert.ok(r.diagnostics.statesBackwardPruned>0);assert.ok(r.journeys.every(j=>j.changes===0));
});
test('V2 optimistic lower bounds prune impossible remaining distance',t=>{
  const r=search(t,[direct(),service(['AAA','XXX'],[400,500],[0,800]),service(['XXX','ZZZ'],[540,800],[0,800])]);assert.ok(r.diagnostics.statesLowerBoundPruned>0);assert.equal(r.journeys.length,1);
});
test('V2 dominance preserves distinct finite transfer windows and resources',()=>{
  const a:SearchState={station:'XXX',arrival:500,departure:100,distance:200,legs:[],connections:[],used:new Set(['1']),visited:new Set(['AAA','XXX']),tiers:[]};
  const b={...a,distance:300};assert.ok(stateDominates(a,b));assert.ok(!stateDominates({...a,arrival:490},b));assert.ok(!stateDominates({...a,used:new Set(['2'])},b));assert.ok(!stateDominates(a,a));
});
test('V2 candidate dominance, diversity and ranking retain best choices',t=>{
  const base=search(t,[direct(),...chain(2,1000)]).journeys.find(j=>j.changes===1)!;
  const copies:V2Journey[]=Array.from({length:5},(_,i)=>({...base,segments:base.segments.map((s,k)=>({...s,trainNumber:String(40000+i*2+k)}))}));
  assert.equal(diversify(copies).length,3);assert.equal(diversify(copies)[0],copies[0]);
  const slow={...base,durationMinutes:base.durationMinutes+300,connections:base.connections.map(c=>({...c,safety:'GOOD' as const}))};
  const fast={...base,connections:base.connections.map(c=>({...c,safety:'TIGHT' as const}))};assert.ok(rankV2(fast,slow)<0);assert.ok(candidateDominates(fast,slow));
  assert.ok(!candidateDominates({...fast,departureDateTime:'2026-09-18T08:00:00+05:30'},slow));
});
test('V2 deterministic results and bounded truncation',t=>{
  const db=fixture(t,[direct(),...chain(4,1000)]), planner=new LocalJourneyPlannerV2(db,{beamWidth:1,maxExpandedStates:2,outgoingTrainCap:1});
  const a=planner.search(request),b=planner.search(request);assert.deepEqual(a.journeys,b.journeys);assert.deepEqual({...a.diagnostics,queryDurationMs:0},{...b.diagnostics,queryDurationMs:0});assert.ok(a.diagnostics.truncated);assert.ok(a.diagnostics.statesExpanded<=2);assert.ok(a.diagnostics.maxFrontierSize<=1);
});
test('V2 graph cache and indexed ordered route scan',t=>{
  const db=fixture(t,[direct()]), a=networkFor(db);assert.equal(a,networkFor(db));
  const plan=JSON.stringify(db.db.prepare('EXPLAIN QUERY PLAN '+routeSql).all());assert.match(plan,/USING INDEX/);assert.doesNotMatch(plan,/TEMP B-TREE/);
  db.db.prepare("UPDATE dataset_metadata SET json=json_set(json,'$.importedAt','2026-09-14T00:00:00Z')").run();assert.notEqual(a,networkFor(db));
});
test('V2 rejects invalid limits and requests',t=>{
  const db=fixture(t,[direct()]);assert.throws(()=>new LocalJourneyPlannerV2(db,{beamWidth:0}),/limit/);const p=new LocalJourneyPlannerV2(db);assert.throws(()=>p.search({...request,maxChanges:6}));assert.throws(()=>p.search({...request,date:'31-02-2026'}));assert.throws(()=>p.search({...request,to:'AAA'}));assert.throws(()=>p.search({...request,to:'MISSING'}));
});
test('V2 complete cap also bounds abundant direct services',t=>{
  const r=search(t,[direct(),service(['AAA','ZZZ'],[400,1400],[0,1000]),service(['AAA','ZZZ'],[420,1420],[0,1000])],{maxCompleteCandidates:1});
  assert.equal(r.diagnostics.completeCandidatesGenerated,1);assert.equal(r.journeys.length,1);assert.ok(r.diagnostics.truncationReasons.includes('completeCandidates'));
});
test('V2 small baseline budget returns explicit bounded-search failure',t=>{
  const r=search(t,chain(6,1500),{maxBaselineStates:1});assert.equal(r.diagnostics.baselineSource,'NONE');assert.equal(r.journeys.length,0);assert.ok(r.diagnostics.truncationReasons.includes('baselineStates'));
});
test('V2 reusable metrics count distinct services, directional links and weekly frequency',t=>{
  const one={...service(['AAA','XXX','ZZZ'],[400,500,600],[0,500,1000]),days:['FRI'] as Weekday[]};
  const db=fixture(t,[one,service(['AAA','ZZZ'],[500,900],[0,1000])]);const n=networkFor(db),m=n.metrics.get('AAA')!;
  assert.equal(m.trains,2);assert.equal(m.frequency,8);assert.equal(m.sourceConnectivity,0);assert.equal(m.destinationConnectivity,2);assert.equal(m.tier,'MAJOR');
  assert.equal(lowerBounds(n,'ZZZ','distance').get('AAA'),1000);assert.equal(lowerBounds(n,'ZZZ','duration').get('AAA'),200);
});

test('V2 CLI works with network denied and has no runtime provider dependencies',t=>{
  const dir=mkdtempSync(join(tmpdir(),'v2-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const db=join(dir,'railway.sqlite'),guard=resolve('src/local-railway/tests/network-denied.mjs');
  const env={PATH:process.env.PATH,HOME:process.env.HOME};
  const run=(args:string[])=>{const p=spawnSync(process.execPath,['--import',guard,'--import','tsx',...args],{env,encoding:'utf8'});assert.equal(p.status,0,p.stderr);return p.stdout;};
  run(['src/local-railway/cli.ts','import','--trains','src/local-railway/tests/fixtures/trains.csv','--stops','src/local-railway/tests/fixtures/stops.csv','--db',db]);
  const r=JSON.parse(run(['src/local-railway/planner/v2/cli.ts','AAA','DDD','18-09-2026','--db',db,'--json']));assert.equal(r.plannerVersion,2);assert.ok(r.journeys.length);
  const visited=new Set<string>();
  const walk=(file:string)=>{if(visited.has(file))return;visited.add(file);assert.doesNotMatch(file,/providers|railkit/);const source=readFileSync(file,'utf8');for(const m of source.matchAll(/(?:import|export)\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/g)){assert.notEqual(m[1],'railkit');if(m[1].startsWith('.'))walk(resolve(file,'..',m[1].replace(/\.js$/,'.ts')));}};
  walk(resolve('src/local-railway/planner/v2/cli.ts'));
});
test('V2 poor existing candidates still permit tier widening',t=>{
  const r=search(t,[direct(),service(['AAA','ZZZ'],[500,1900],[0,1000]),...chain(2,1000)],{strongCandidateTarget:2});assert.ok(r.diagnostics.stagesAttempted.includes('MAJOR'));assert.ok(r.journeys.some(j=>j.changes===1));
});
test('V2 progressive duration bound prunes overlong first leg',t=>{
  const r=search(t,[direct(),service(['AAA','XXX'],[400,2000],[0,500]),service(['XXX','ZZZ'],[2040,2200],[0,500])]);assert.ok(r.diagnostics.statesDurationPruned>0);assert.equal(r.journeys.length,1);
});
