import {pathToFileURL} from 'node:url';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { RailwayDatabase } from '../database.js';
import { readDataset, importRailway, type ImportOptions } from '../importer.js';
import { parseCsv } from '../csv.js';
import { parseRunningDays, runsOnDate } from '../calendar.js';
import { LocalJourneyPlanner } from '../planner/local-journey-planner.js';
import { membershipSql, pairSql } from '../indexes.js';
import type { LocalDataset } from '../types.js';
const fixture = resolve('src/local-railway/tests/fixtures');
const options: ImportOptions = { trains: join(fixture, 'trains.csv'), stops: join(fixture, 'stops.csv'), stations: join(fixture, 'stations.csv'), label: 'SYNTHETIC_TEST_FIXTURE' };
const request = { from: 'AAA', to: 'DDD', date: '18-09-2026', maxChanges: 2 };
function dataset(numbers?: string[]): LocalDataset {
  const data = readDataset(options);
  if (numbers) { data.trains = data.trains.filter(t => numbers.includes(t.number)); data.stops = data.stops.filter(s => numbers.includes(s.trainNumber)); data.metadata.trainCount = data.trains.length; data.metadata.stopCount = data.stops.length; }
  return data;
}
function setup(t: TestContext, data = dataset()) {
  const db = new RailwayDatabase(':memory:'); db.replace(data); t.after(() => db.close()); return db;
}
function modified(t: TestContext, file: 'trains' | 'stops' | 'stations', edit: (s: string) => string): ImportOptions {
  const dir = mkdtempSync(join(tmpdir(), 'railway-csv-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, `${file}.csv`); writeFileSync(path, edit(readFileSync(options[file]!, 'utf8'))); return { ...options, [file]: path };
}
test('CSV handles BOM, quoted commas, escaped quotes, multiline fields and CRLF', () => {
  assert.deepEqual(parseCsv('\uFEFFa,b\r\n"Mon,Wed","a""b\nc"\r\n'), [['a','b'],['Mon,Wed','a"b\nc']]);
  assert.throws(() => parseCsv('a\n"unclosed'), /Unclosed/);
  assert.throws(() => parseCsv('a\n"x"y'), /quoting/);
});
for (const raw of ['Daily',' DAILY ','Mon,Tue,Wed,Thu,Fri,Sat,Sun']) test(`calendar ${raw}`, () => assert.equal(parseRunningDays(raw).length, 7));
test('calendar selected weekdays, normalization and origin date validation', () => {
  const runningDays = parseRunningDays(' monday, WED ,fri '); assert.deepEqual(runningDays, ['MON','WED','FRI']);
  assert.equal(runsOnDate({ runningDays }, '18-09-2026'), true); assert.equal(runsOnDate({ runningDays }, '19-09-2026'), false);
  assert.deepEqual(parseRunningDays('Tue,Thu,Sat'), ['TUE','THU','SAT']);
  assert.throws(() => runsOnDate({ runningDays }, '31-02-2026'));
});
for (const raw of ['Unknown','','1111111','Mon,','Holiday']) test(`reject calendar ${JSON.stringify(raw)}`, () => assert.throws(() => parseRunningDays(raw), /Unknown/));
test('valid import, metadata, optional fields and zero-based normalized days', t => {
  const db = setup(t); assert.equal(db.metadata().trainCount, 15); assert.equal(db.metadata().source, 'RAILPULL_NTES');
  assert.equal(db.train('10001').type, undefined); assert.equal(db.station('AAA')?.name, 'Synthetic AAA');
  assert.equal(db.db.prepare("SELECT day_offset FROM train_stops WHERE train_number='10006' AND sequence=2").get()?.day_offset, 1);
});
test('station enrichment is optional; absent stations derive from stops', () => {
  const data = readDataset({ ...options, stations: undefined }); assert.ok(data.stations.find(s => s.code === 'BBB'));
});
test('station enrichment may contain only a subset', t => {
  const data = readDataset(modified(t, 'stations', s => s.split(/\r?\n/).slice(0, 2).join('\n'))); assert.ok(data.stations.find(s => s.code === 'PUNE'));
});
test('lowercase station codes and short train numbers normalize consistently', t => {
  const p = modified(t, 'trains', s => s.replaceAll('10001', '1').replaceAll('AAA', 'aaa'));
  const q = modified(t, 'stops', s => s.replaceAll('10001', '1').replaceAll('AAA', 'aaa'));
  const data = readDataset({ ...p, stops: q.stops }); assert.ok(data.trains.find(t => t.number === '00001')); assert.ok(data.stops.some(s => s.stationCode === 'AAA'));
});
for (const [name, file, edit, error] of [
  ['missing header','trains',(s:string) => s.replace('source_code','unrecognized_source'), /missing header source_code/],
  ['duplicate header','trains',(s:string) => s.replace('type_label','type'), /Duplicate/],
  ['malformed row','stops',(s:string) => s + 'bad,row\n', /Record/],
  ['duplicate train','trains',(s:string) => s + s.split(/\r?\n/)[1] + '\n', /Duplicate train/],
  ['duplicate stop','stops',(s:string) => s + s.split(/\r?\n/)[1] + '\n', /Duplicate stop sequence/],
  ['unknown train','stops',(s:string) => s.replace('10001,1', '99999,1'), /Unknown train/],
  ['invalid time','stops',(s:string) => s.replace('06:00','26:00'), /Invalid time/],
  ['blank critical time','stops',(s:string) => s.replace('06:00',''), /Missing critical time/],
  ['invalid sequence','stops',(s:string) => s.replace('10001,1,','10001,1.5,'), /Invalid sequence/],
  ['sequence gap','stops',(s:string) => s.replace('10001,2,','10001,4,'), /Noncontiguous/],
  ['wrong endpoint','trains',(s:string) => s.replace('AAA,AAA,DDD','BBB,AAA,DDD'), /endpoints/],
  ['backwards day','stops',(s:string) => s.replace('DDD,Synthetic DDD,2,06:00','DDD,Synthetic DDD,1,06:00'), /Backwards/],
  ['unknown calendar','trains',(s:string) => s.replace('Daily','Unknown'), /Unknown running/],
  ['bad coordinates','stations',(s:string) => s.replace('AAA,Synthetic AAA,,','AAA,Synthetic AAA,91,'), /latitude/],
] as const) test(`import rejects ${name} without replacing prior dataset`, t => {
  const db = setup(t); const before = db.metadata();
  assert.throws(() => importRailway(db, modified(t, file, edit)), error); assert.deepEqual(db.metadata(), before);
});
test('idempotent replacement and rollback after SQL insert failure', t => {
  const db = setup(t); const count = db.metadata().stopCount; importRailway(db, options); assert.equal(db.metadata().stopCount, count);
  assert.equal(db.db.prepare('SELECT count(*) AS n FROM train_stops').get()?.n, count);
  const bad = dataset(); bad.stops[0].stationCode = 'UNKNOWN'; const before = db.metadata();
  assert.throws(() => db.replace(bad), /FOREIGN KEY/); assert.deepEqual(db.metadata(), before); assert.ok(db.station('AAA'));
});
test('SQLite persists across close/reopen', t => {
  const dir = mkdtempSync(join(tmpdir(), 'railway-db-')); const path = join(dir,'railway.sqlite');
  const db = new RailwayDatabase(path); importRailway(db, options); db.close(); const reader = new RailwayDatabase(path,true); t.after(() => {reader.close();rmSync(dir,{recursive:true,force:true});});
  assert.equal(reader.metadata().trainCount, 15); assert.ok(new LocalJourneyPlanner(reader).search(request).journeys.length);
});
test('direct forward order, weekday rejection, overnight arrival and schedule-only model', t => {
  const planner = new LocalJourneyPlanner(setup(t)); const result = planner.search({ ...request, maxChanges: 0 });
  assert.ok(result.journeys.length); assert.ok(result.journeys.every(j => j.changes === 0));
  assert.ok(!result.journeys.some(j => j.segments[0].trainNumber === '10007'));
  const overnight = result.journeys.find(j => j.segments[0].trainNumber === '10006')!;
  assert.equal(overnight.arrivalDateTime,'2026-09-19T06:00:00+05:30'); assert.equal(overnight.durationMinutes,600);
  assert.equal(planner.search({ ...request, from:'DDD',to:'AAA',maxChanges:0 }).journeys.length,0);
  assert.ok(planner.search({...request,date:'21-09-2026',maxChanges:0}).journeys.some(j => j.segments[0].trainNumber==='10007'));
  assert.ok(!JSON.stringify(result.journeys).match(/AVAILABLE|RAC|fare/));
});
test('one change works without any direct seed train', t => {
  const result = new LocalJourneyPlanner(setup(t,dataset(['10002','10003']))).search({...request,maxChanges:1});
  assert.equal(result.journeys.length,1); assert.equal(result.journeys[0].changes,1); assert.equal(result.journeys[0].connections[0].safety,'GOOD');
});
for (const [departure, arrival, allowLong, expected] of [['10:00','14:00',false,'TIGHT'],['11:00','14:00',false,'GOOD'],['16:00','18:00',false,undefined],['16:00','18:00',true,'LONG'],['09:20','12:00',false,undefined]] as const) test(`transfer ${departure} long=${allowLong}`, t => {
  const data=dataset(['10002','10003']); data.stops.find(s=>s.trainNumber==='10003'&&s.sequence===1)!.departureTime=departure; data.stops.find(s=>s.trainNumber==='10003'&&s.sequence===2)!.arrivalTime=arrival;
  const result=new LocalJourneyPlanner(setup(t,data),{timing:{allowLongConnections:allowLong}}).search({...request,maxChanges:1});
  assert.equal(result.journeys[0]?.connections[0].safety,expected); assert.equal(result.journeys.length,expected?1:0);
});
test('two changes independently discovered without a direct corridor', t => {
  const result=new LocalJourneyPlanner(setup(t,dataset(['10002','10004','10005']))).search(request);
  assert.equal(result.journeys.length,1); assert.deepEqual(result.journeys[0].segments.map(s=>s.trainNumber),['10002','10004','10005']); assert.equal(result.journeys[0].changes,2);
});
test('next-day second and third train use their correct operating date', t => {
  const planner=new LocalJourneyPlanner(setup(t,dataset(['10009','10010','10011'])));
  const result=planner.search({...request,from:'NNN',to:'PPP'}); assert.equal(result.journeys.length,1);
  assert.deepEqual(result.journeys[0].segments.map(s=>s.boardingDate),['18-09-2026','19-09-2026','19-09-2026']);
  assert.equal(result.journeys[0].arrivalDateTime,'2026-09-19T07:00:00+05:30'); assert.equal(result.journeys[0].durationMinutes,540);
  assert.equal(planner.search({...request,from:'NNN',to:'PPP',date:'19-09-2026'}).journeys.length,0);
  assert.ok(planner.search({...request,from:'NNN',to:'PPP',date:'19-09-2026'}).diagnostics.pathsCalendarPruned>0);
});
test('boarding a day-1 stop checks previous origin weekday', t => {
  const data=dataset(['10015']); const route=data.stops;
  route[0].departureTime='23:00'; route[1].dayOffset=1; route[1].arrivalTime='01:00';route[1].departureTime='02:00';route[2].dayOffset=1;route[2].arrivalTime='03:00';route[2].departureTime='03:10';route[3].dayOffset=1;route[3].arrivalTime='05:00'; data.trains[0].runningDays=['FRI'];
  const planner=new LocalJourneyPlanner(setup(t,data));
  const result=planner.search({...request,from:'BBB',date:'19-09-2026',maxChanges:0});
  assert.equal(result.journeys.length,1);assert.equal(result.journeys[0].segments[0].originDate,'18-09-2026');assert.equal(result.journeys[0].durationMinutes,180);
  assert.equal(planner.search({...request,from:'BBB',date:'18-09-2026',maxChanges:0}).journeys.length,0);
});
test('station loop across traversed stops is rejected', t => {
  const result=new LocalJourneyPlanner(setup(t,dataset(['10002','10012','10013']))).search(request);
  assert.ok(result.journeys.every(j=>!j.segments.some(s=>s.trainNumber==='10002')));assert.ok(result.diagnostics.pathsLoopPruned>0);
});
test('repeated train cannot masquerade as a transfer', t => {
  const result=new LocalJourneyPlanner(setup(t,dataset(['10015']))).search(request);
  assert.ok(result.journeys.every(j=>j.changes===0));assert.ok(result.diagnostics.pathsLoopPruned>0);
});
test('beam, candidates and train/station limits are bounded with visible truncation', t => {
  const result=new LocalJourneyPlanner(setup(t),{bounds:{beamWidth:1,maxTrainsPerExpansion:2,maxInterchangeStationsPerExpansion:1,maxCandidateJourneys:2,finalResultLimit:1}}).search(request);
  assert.ok(result.diagnostics.maxFrontier<=1);assert.ok(result.diagnostics.completedJourneys<=2);assert.ok(result.journeys.length<=1);assert.equal(result.diagnostics.truncated,true);
});
test('ranking deterministic; fewer changes precede connections', t => {
  const planner=new LocalJourneyPlanner(setup(t));const a=planner.search(request),b=planner.search(request);assert.deepEqual(a.journeys,b.journeys);
  assert.ok(a.journeys.every((j,i)=>!i||j.changes>=a.journeys[i-1].changes));
});
test('invalid request and bounds rejected', t => {
  const db=setup(t);const planner=new LocalJourneyPlanner(db);
  for(const patch of [{maxChanges:3},{maxChanges:-1},{from:'MISSING'},{from:'AAA',to:'AAA'},{date:'31-02-2026'}]) assert.throws(()=>planner.search({...request,...patch}));
  assert.throws(()=>new LocalJourneyPlanner(db,{bounds:{beamWidth:0}}).search(request));
});
test('synthetic NDLS to PUNE exercises generic station handling, not a real timetable claim', t => {
  const r=new LocalJourneyPlanner(setup(t)).search({...request,from:'NDLS',to:'PUNE'});assert.equal(r.journeys.length,1);assert.equal(r.dataset.label,'SYNTHETIC_TEST_FIXTURE');
});
test('query plans use station and train/sequence indexes', t => {
  const db=setup(t);
  const plans=[db.db.prepare('EXPLAIN QUERY PLAN '+membershipSql).all('AAA',31),db.db.prepare('EXPLAIN QUERY PLAN '+pairSql).all('AAA','DDD',31),db.db.prepare('EXPLAIN QUERY PLAN SELECT * FROM train_stops WHERE train_number=? AND sequence>? ORDER BY sequence LIMIT ?').all('10015',1,51)];
  for(const plan of plans){const text=JSON.stringify(plan);assert.match(text,/SEARCH/);assert.doesNotMatch(text,/SCAN (train_stops|a|b)\b/);}
});
test('disconnected dataset growth does not increase queried stop rows', t => {
  const small=dataset();const base=new LocalJourneyPlanner(setup(t,small)).search(request);const large=dataset();
  large.stations.push({code:'UUU',name:'Synthetic U'},{code:'VVV',name:'Synthetic V'});
  for(let i=0;i<1000;i++){const number=String(20000+i);large.trains.push({number,name:'Disconnected',sourceCode:'UUU',destinationCode:'VVV',runningDays:['FRI'],runningDaysRaw:'Fri'});large.stops.push({trainNumber:number,sequence:1,stationCode:'UUU',dayOffset:0,departureTime:'06:00'},{trainNumber:number,sequence:2,stationCode:'VVV',dayOffset:0,arrivalTime:'07:00'});}
  large.metadata.trainCount=large.trains.length;large.metadata.stopCount=large.stops.length;large.metadata.stationCount=large.stations.length;
  const result=new LocalJourneyPlanner(setup(t,large)).search(request);assert.deepEqual(result.journeys,base.journeys);assert.equal(result.diagnostics.rowsConsidered,base.diagnostics.rowsConsidered);assert.ok(Number.isFinite(result.diagnostics.queryDurationMs));
});
test('CLI import and planning work with no provider env and network denied', t => {
  const dir=mkdtempSync(join(tmpdir(),'railway-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const db=join(dir,'railway.sqlite');
  const guard=join(dir,'guard.mjs');writeFileSync(guard,`import http from 'node:http';import https from 'node:https';import net from 'node:net';const deny=()=>{throw Error('Network forbidden in local POC test')};globalThis.fetch=deny;http.request=deny;http.get=deny;https.request=deny;https.get=deny;net.Socket.prototype.connect=deny;`);
  const env={PATH:process.env.PATH!,HOME:dir};
  const run=(args:string[])=>{const p=spawnSync(process.execPath,['--import',pathToFileURL(guard).href,'--import','tsx','src/local-railway/cli.ts',...args],{env,encoding:'utf8'});assert.equal(p.status,0,p.stderr);return p.stdout;};
  run(['import','--trains',options.trains,'--stops',options.stops,'--db',db,'--label','SYNTHETIC_TEST_FIXTURE']);
  const result=JSON.parse(run(['plan','AAA','DDD','18-09-2026','--db',db,'--json']));assert.ok(result.journeys.length);assert.equal(result.kind,'SCHEDULED_CANDIDATES_ONLY');
});
test('local runtime dependency graph has no provider imports', () => {
  const visited=new Set<string>();
  const walk=(path:string)=>{if(visited.has(path))return;visited.add(path);const source=readFileSync(path,'utf8');assert.doesNotMatch(source,/from\s+['"]railkit['"]|RailKitProvider|ConnectionProviderSession|getAvailability/);
    for(const match of source.matchAll(/(?:import|export)\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/g)){if(match[1].startsWith('.'))walk(resolve(path,'..',match[1].replace(/\.js$/,'.ts')));}
  };
  for(const f of ['cli.ts','importer.ts','planner/local-journey-planner.ts'])walk(resolve('src/local-railway',f));
});
test('zero-based raw day values normalize identically to one-based export', t => {
  const changed=modified(t,'stops',s=>s.split(/\r?\n/).map((line,i)=>{if(!i||!line)return line;const fields=line.split(',');fields[4]=String(Number(fields[4])-1);return fields.join(',');}).join('\n'));
  assert.deepEqual(readDataset(changed).stops,readDataset(options).stops);
});
test('blank optional distance and missing optional columns do not invent distances', t => {
  const changed=modified(t,'stops',s=>s.split(/\r?\n/).map(line=>line?line.split(',').slice(0,-2).join(','):line).join('\n'));
  const data=readDataset(changed);assert.ok(data.stops.every(s=>s.distanceKm===undefined));
  assert.ok(new LocalJourneyPlanner(setup(t,data)).search(request).journeys.every(j=>j.totalDistanceKm===undefined));
});
test('sourceGeneratedAt and fixture provenance persist', t => {
  const data=readDataset({...options,sourceGeneratedAt:'2026-09-12T00:00:00Z'});const db=setup(t,data);assert.equal(db.metadata().sourceGeneratedAt,'2026-09-12T00:00:00Z');
  assert.throws(()=>readDataset({...options,sourceGeneratedAt:'yesterday'}),/sourceGeneratedAt/);
});
test('second-train intermediate boarding applies its origin-day calendar', t => {
  const data=dataset(['10009','10015']);
  const route=data.stops.filter(s=>s.trainNumber==='10015');route[0].departureTime='23:00';route[1].dayOffset=1;route[1].arrivalTime='01:00';route[1].departureTime='02:00';route[2].dayOffset=1;route[2].arrivalTime='03:00';route[2].departureTime='03:10';route[3].dayOffset=1;route[3].arrivalTime='05:00';data.trains.find(t=>t.number==='10015')!.runningDays=['FRI'];
  const result=new LocalJourneyPlanner(setup(t,data)).search({...request,from:'NNN',maxChanges:1});
  assert.equal(result.journeys.length,1);assert.equal(result.journeys[0].segments[1].originDate,'18-09-2026');assert.equal(result.journeys[0].segments[1].boardingDate,'19-09-2026');
});
test('calendar rejection on third leg prevents a completed two-change path', t => {
  const data=dataset(['10009','10010','10011']);data.trains.find(t=>t.number==='10011')!.runningDays=['MON'];
  const result=new LocalJourneyPlanner(setup(t,data)).search({...request,from:'NNN',to:'PPP'});assert.equal(result.journeys.length,0);assert.ok(result.diagnostics.pathsCalendarPruned>0);
});
test('transfer window crossing midnight discovers next calendar date', t => {
  const data=dataset(['10002','10003']);data.stops[0].departureTime='20:00';data.stops[1].arrivalTime='23:30';data.stops[2].departureTime='01:00';data.stops[3].arrivalTime='04:00';data.trains[1].runningDays=['SAT'];
  const result=new LocalJourneyPlanner(setup(t,data)).search({...request,maxChanges:1});assert.equal(result.journeys.length,1);assert.equal(result.journeys[0].connections[0].minutes,90);assert.equal(result.journeys[0].segments[1].boardingDate,'19-09-2026');
});
test('invalid/ambiguous midnight halt and decreasing distance reject whole import', t => {
  assert.throws(()=>readDataset(modified(t,'stops',s=>s.replace('10:30,11:30','23:30,00:30'))),/Backwards/);
  assert.throws(()=>readDataset(modified(t,'stops',s=>s.replace('14:30,,,400','14:30,,,100'))),/Decreasing distance/);
});
test('direct result limit does not depend on final result limit', t => {
  const result=new LocalJourneyPlanner(setup(t),{bounds:{maxDirectResults:1,finalResultLimit:20}}).search({...request,maxChanges:0});assert.equal(result.journeys.length,1);assert.equal(result.diagnostics.truncated,true);
});
// Real observation: RailPull 00170/SWV exports STA 23:50, STD 00:20,
// Day 2, Halt 30. The former single-day model rejected this valid midnight halt.
function midnightExport(t: TestContext, halt = '30') {
  const dir=mkdtempSync(join(tmpdir(),'railway-midnight-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  writeFileSync(join(dir,'trains.csv'),'number,name,runs_days,source_code,dest_code\n29001,Midnight regression,Fri,AAA,DDD\n29002,Connection regression,Sat,BBB,CCC\n');
  writeFileSync(join(dir,'stops.csv'),`train_number,seq,station_code,station_name,day,arrival,departure,halt_min,distance_km\n29001,1,AAA,Alpha,1,,20:00,0,0\n29001,2,BBB,,2,23:50,00:20,${halt},100\n29001,3,DDD,Delta,2,14:00,,0,400\n29002,1,BBB,,1,,00:55,0,0\n29002,2,CCC,Charlie,1,02:00,,0,100\n`);
  return {trains:join(dir,'trains.csv'),stops:join(dir,'stops.csv')};
}
test('real midnight-halt shape separates arrival and departure days and warns for blank labels', t => {
  const data=readDataset(midnightExport(t));const stop=data.stops.find(s=>s.trainNumber==='29001'&&s.stationCode==='BBB')!;
  assert.equal(stop.dayOffset,1);assert.equal(stop.arrivalDayOffset,0);assert.equal(data.stations.find(s=>s.code==='BBB')?.name,'BBB');assert.match(data.metadata.warnings![0],/BBB/);
  const db=setup(t,data);assert.equal(db.db.prepare("SELECT arrival_day_offset FROM train_stops WHERE train_number='29001' AND sequence=2").get()?.arrival_day_offset,0);
  const planner=new LocalJourneyPlanner(db);
  const arrive=planner.search({...request,to:'BBB',maxChanges:0}).journeys[0];assert.equal(arrive.arrivalDateTime,'2026-09-18T23:50:00+05:30');assert.equal(arrive.durationMinutes,230);
  const board=planner.search({...request,from:'BBB',date:'19-09-2026',maxChanges:0}).journeys[0];assert.equal(board.segments[0].originDate,'18-09-2026');assert.equal(board.departureDateTime,'2026-09-19T00:20:00+05:30');
  const change=planner.search({...request,to:'CCC',maxChanges:1}).journeys[0];assert.equal(change.connections[0].minutes,65);assert.equal(change.durationMinutes,360);
});
test('midnight day inference requires matching halt evidence', t => {
  assert.throws(()=>readDataset(midnightExport(t,'20')),/Backwards/);
  assert.throws(()=>readDataset(midnightExport(t,'')),/Backwards/);
});
test('explicit whole-train exclusion is recorded, never silently truncates a route', t => {
  const input=midnightExport(t);
  const rows=readFileSync(input.stops,'utf8').trimEnd().split('\n');
  const repeated=rows.slice(1,4).map((row,i)=>row.replace(`29001,${i+1},`,`29001,${i+4},`));
  writeFileSync(input.stops,[...rows,...repeated].join('\n')+'\n');
  assert.throws(()=>readDataset(input),/Missing critical time/);
  const data=readDataset({...input,excludedTrains:[{number:'29001',reason:'Test: identical repeated route and day reset'}]});
  assert.equal(data.metadata.trainCount,1);assert.equal(data.metadata.stopCount,2);assert.equal(data.metadata.excludedStopCount,6);assert.deepEqual(data.metadata.excludedTrains,[{number:'29001',reason:'Test: identical repeated route and day reset'}]);assert.ok(data.stops.every(s=>s.trainNumber==='29002'));
  assert.throws(()=>readDataset({...input,excludedTrains:[{number:'99999',reason:'Not in source'}]}),/not found/);
  assert.throws(()=>readDataset({...input,excludedTrains:[{number:'29001',reason:''}]}),/exclusion reason/);
});
test('schema v1 data can be read and migrates without deleting the existing dataset', t => {
  const dir=mkdtempSync(join(tmpdir(),'railway-migration-'));const path=join(dir,'old.sqlite');
  const db=new RailwayDatabase(path);db.replace(dataset());db.db.exec('ALTER TABLE train_stops DROP COLUMN arrival_day_offset; PRAGMA user_version=1;');db.close();
  const oldReader=new RailwayDatabase(path,true);assert.ok(new LocalJourneyPlanner(oldReader).search(request).journeys.length);oldReader.close();
  const migrated=new RailwayDatabase(path);t.after(()=>{migrated.close();rmSync(dir,{recursive:true,force:true});});assert.equal(migrated.metadata().trainCount,15);assert.equal(migrated.db.prepare('PRAGMA user_version').get()?.user_version,2);assert.ok(new LocalJourneyPlanner(migrated).search(request).journeys.length);
});

test('same-day halt mismatch is persisted as an aggregate and replaces atomically', t => {
  const input=midnightExport(t);
  const raw=readFileSync(input.stops,'utf8').replace('2,23:50,00:20,30','1,23:50,23:51,0');
  writeFileSync(input.stops,raw);
  const db=setup(t);
  const metadata=importRailway(db,input);
  assert.equal(metadata.haltMismatchCount,1);assert.equal(metadata.haltMismatchTrainCount,1);
  assert.equal(metadata.excludedTrainCount,0);assert.equal(metadata.excludedStopCount,0);
  assert.deepEqual(db.metadata(),JSON.parse(JSON.stringify(metadata)));assert.equal(metadata.trainCount,2);
  assert.equal(db.db.prepare('SELECT count(*) AS n FROM train_stops').get()?.n,5);
  assert.equal(db.db.prepare("SELECT arrival_time FROM train_stops WHERE train_number='29001' AND sequence=2").get()?.arrival_time,'23:50');
  assert.ok(!metadata.warnings?.some(w=>w.includes('Halt')));
  writeFileSync(input.stops,raw.replace('1,23:50,23:51,0','1,19:50,19:51,0'));
  assert.throws(()=>importRailway(db,input),/Backwards/);assert.deepEqual(db.metadata(),JSON.parse(JSON.stringify(metadata)));
  assert.equal(db.db.prepare('SELECT count(*) AS n FROM train_stops').get()?.n,5);
});
