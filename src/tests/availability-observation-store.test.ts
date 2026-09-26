import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,unlinkSync,rmdirSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {availabilityStateConfig} from '../config/availability-state.js';
import {SqliteAvailabilityObservationStore} from '../providers/observations/sqlite-store.js';
import {AvailabilityFreshnessPolicy} from '../providers/observations/freshness.js';
import {canonicalAvailabilityIdentity,makeObservation,observationKey,journeyMidnight,validateObservation,type AvailabilityIdentity} from '../providers/observations/model.js';
import {normalizeAvailability} from '../providers/railkit/railkit-normalizers.js';
import type {AvailabilityRequest} from '../domain/types/availability.js';
const date='20-09-2099',now=Date.UTC(2099,8,1),day=86400000,hour=3600000;
const request:AvailabilityRequest={trainNumber:'30001',fromStationCode:'AAA',toStationCode:'BBB',journeyDate:date,travelClass:'SL',quota:'GN'};
function observation(state='AVAILABLE',time=now,r:AvailabilityIdentity=request){return makeObservation(normalizeAvailability({success:true,data:{availability:[{date:r.journeyDate,status:state,availabilityText:state==='AVAILABLE'?'AVAILABLE 20':state==='WAITLIST'?'WL 12':state}]}},r as AvailabilityRequest),time);}
function memory(t:TestContext,patch={}){const s=new SqliteAvailabilityObservationStore({...availabilityStateConfig({}),path:':memory:',...patch},()=>now);t.after(()=>s.close());return s;}
function disk(t:TestContext){const dir=mkdtempSync(join(tmpdir(),'railway-observations-')),path=join(dir,'state.sqlite');const handles:{close:()=>void}[]=[];t.after(()=>{for(const h of handles)h.close();for(const file of [path,path+'-wal',path+'-shm',path+'-journal'])if(existsSync(file))unlinkSync(file);rmdirSync(dir);});return {path,handles};}

test('observation configuration has bounded validated defaults',()=>{
 const c=availabilityStateConfig({});assert.equal(c.path,'data/availability-state/observations.sqlite');assert.equal(c.maxRows,100000);assert.equal(c.busyTimeoutMs,25);
 for(const key of ['AVAILABILITY_STATE_MAX_ROWS','AVAILABILITY_STATE_RETENTION_MS','AVAILABILITY_STATE_BUSY_TIMEOUT_MS','AVAILABILITY_FRESHNESS_NEAR_MS'])for(const raw of ['0','-1','NaN','Infinity','1.5','invalid'])assert.throws(()=>availabilityStateConfig({[key]:raw}));
 assert.throws(()=>availabilityStateConfig({AVAILABILITY_FRESHNESS_NEAR_MS:'86400001'}));
 assert.equal(availabilityStateConfig({AVAILABILITY_FRESHNESS_NEAR_MS:'1234'}).freshnessMs.near,1234);
});

test('canonical identity normalizes formats while preserving leading train zeroes',()=>{
 const a={...request,trainNumber:' 03001 ',fromStationCode:' aaa ',toStationCode:' bbb ',journeyDate:'2099-09-20',travelClass:' sl ',quota:' gn '};
 assert.equal(observationKey(a),observationKey({...request,trainNumber:'03001'}));
 assert.equal(canonicalAvailabilityIdentity(a).journeyDate,date);
 assert.notEqual(observationKey(a),observationKey(request));
 for(const invalid of [{...request,journeyDate:'31-02-2099'},{...request,trainNumber:'3001'},{...request,travelClass:'ALL'}])assert.throws(()=>observationKey(invalid));
});

test('latest UPSERT keeps one identity, newest evidence and original created time',t=>{
 const f=disk(t),store=new SqliteAvailabilityObservationStore({...availabilityStateConfig({}),path:f.path},()=>now);f.handles.push(store);
 store.upsertLatest(observation('WAITLIST',now-100));store.upsertLatest(observation('AVAILABLE',now-50));store.upsertLatest(observation('NOT_AVAILABLE',now-75));
 store.upsertLatest(observation('WAITLIST',now-50)); // deterministic equal-timestamp tie
 assert.equal(store.getLatest(request)!.result.days[0].state,'AVAILABLE');
 const db=new DatabaseSync(f.path);f.handles.push(db);assert.equal(db.prepare('SELECT count(*) AS n FROM availability_latest').get()!.n,1);
 assert.equal(db.prepare('SELECT observed_at FROM availability_latest').get()!.observed_at,now-50);
});

test('latest evidence survives closing and reopening a separate database',t=>{
 const f=disk(t),config={...availabilityStateConfig({}),path:f.path};
 const one=new SqliteAvailabilityObservationStore(config,()=>now);one.upsertLatest(observation());one.close();
 const two=new SqliteAvailabilityObservationStore(config,()=>now);f.handles.push(two);
 assert.equal(two.getLatest(request)!.result.days[0].availableCount,20);
 assert.equal(two.getLatest({...request,fromStationCode:'aaa',travelClass:'sl',quota:'gn',journeyDate:'2099-09-20'})!.observedAt,now);
});

test('date, class, quota and route identities never collide',t=>{
 const s=memory(t),identities=[request,{...request,journeyDate:'21-09-2099'},{...request,travelClass:'3A'},{...request,quota:'TQ'},{...request,fromStationCode:'CCC'}];
 identities.forEach((r,i)=>s.upsertLatest(observation(i%2?'WAITLIST':'AVAILABLE',now-i,r)));
 identities.forEach((r,i)=>assert.equal(s.getLatest(r)!.observedAt,now-i));
 assert.equal(s.getLatest({...request,quota:'LD'}),undefined);
});

for(const state of ['AVAILABLE','RAC','WAITLIST','NOT_AVAILABLE'])test('persistent roundtrip preserves '+state+' exactly',t=>{
 const s=memory(t);s.upsertLatest(observation(state));const read=s.getLatest(request)!;
 assert.equal(read.result.days[0].state,state);assert.equal(read.result.identityEvidence!.providerIdentityValidation,'NOT_PROVIDED');
 assert.equal(read.result.days[0].canBook,undefined);if(state==='WAITLIST')assert.equal(read.result.days[0].waitlistNumber,12);
});

test('only validated inventory is stored; failures, ambiguity and false bookability are rejected',t=>{
 const s=memory(t);
 for(const payload of [{success:false,error:'failure'},{success:true,data:{availability:[{date,status:'AVAILABLE',canBook:false}]}},{success:true,data:{availability:[{date,status:'AVAILABLE'},{date,status:'WAITLIST'}]}},{success:true,data:{train:{from:'WRONG'},availability:[{date,status:'AVAILABLE'}]}}]){
  assert.throws(()=>s.upsertLatest(makeObservation(normalizeAvailability(payload,request),now)));
 }
 assert.equal(s.getLatest(request),undefined);
});

test('observation allowlist excludes secrets and unneeded raw provider payloads',t=>{
 const s=memory(t),result=normalizeAvailability({success:true,data:{train:{trainName:'secret-string'},availability:[{date,status:'AVAILABLE',availabilityText:'Authorization secret-string',rawStatus:'secret-string'}]}},request);
 const value=makeObservation({...result,providerMessage:'secret-string'},now);s.upsertLatest(value);
 assert.doesNotMatch(JSON.stringify(s.getLatest(request)),/secret-string|trainName|providerMessage/);
 assert.equal(s.getLatest(request)!.result.days[0].state,'AVAILABLE');
});

test('corrupt payloads, namespace and column mismatches are never trusted',t=>{
 const f=disk(t),s=new SqliteAvailabilityObservationStore({...availabilityStateConfig({}),path:f.path},()=>now);f.handles.push(s);s.upsertLatest(observation());
 const db=new DatabaseSync(f.path);f.handles.push(db);
 db.prepare('UPDATE availability_latest SET evidence_json=?').run('{bad json');assert.throws(()=>s.getLatest(request));
 db.prepare('UPDATE availability_latest SET evidence_json=?,class_code=?').run(JSON.stringify(observation()),'3A');assert.throws(()=>s.getLatest(request));
 assert.throws(()=>validateObservation({...observation(),namespace:'wrong'}));
 assert.throws(()=>validateObservation({...observation(),identity:{...request,toStationCode:'CCC'}}));
 assert.throws(()=>validateObservation({...observation(),observedAt:NaN}));
});

test('cleanup removes past journey/old observations and row capacity bounds growth',t=>{
 const s=memory(t,{maxRows:2,retentionMs:day});
 for(let i=0;i<3;i++)s.upsertLatest(observation('AVAILABLE',now-100+i,{...request,trainNumber:String(30001+i)}));
 assert.equal(s.getLatest(request),undefined);assert.ok(s.getLatest({...request,trainNumber:'30003'}));
 assert.equal(s.cleanup(now+day),2);assert.equal(s.getLatest({...request,trainNumber:'30003'}),undefined);
 s.upsertLatest(observation('AVAILABLE',now,request));assert.equal(s.cleanup(journeyMidnight(date)+day),1);
});

test('future observations and malformed timestamps cannot establish fresh evidence',t=>{
 assert.throws(()=>memory(t).upsertLatest(observation('AVAILABLE',now+1)));
 const policy=new AvailabilityFreshnessPolicy();assert.equal(policy.isFresh(date,now+1,now),false);assert.equal(policy.isFresh(date,NaN,now),false);
});

test('timetable path and unrelated SQLite schema are rejected without mutation',t=>{
 const f=disk(t),db=new DatabaseSync(f.path);db.exec('CREATE TABLE trains(number TEXT); PRAGMA user_version=2;');db.close();
 const before=readFileSync(f.path);
 const same=new SqliteAvailabilityObservationStore({...availabilityStateConfig({}),path:f.path},()=>now,f.path);f.handles.push(same);assert.throws(()=>same.getLatest(request));
 const copied=new SqliteAvailabilityObservationStore({...availabilityStateConfig({}),path:f.path},()=>now,join(tmpdir(),'different-timetable.sqlite'));f.handles.push(copied);assert.throws(()=>copied.getLatest(request));
 assert.deepEqual(readFileSync(f.path),before);
});

test('freshness band endpoints and exact expiry use the injected time deterministically',()=>{
 const policy=new AvailabilityFreshnessPolicy(),midnight=journeyMidnight(date);
 for(const [distance,ttl] of [[30*day+1,12*hour],[30*day,6*hour],[15*day+1,6*hour],[15*day,3*hour],[7*day+1,3*hour],[7*day,hour],[2*day,hour],[2*day-1,hour/2],[0,hour/2]] as const){
  const time=midnight-distance;assert.equal(policy.maximumAge(date,time),ttl);
  assert.equal(policy.isFresh(date,time-ttl+1,time),true);assert.equal(policy.isFresh(date,time-ttl,time),false);
 }
 assert.equal(policy.isFresh(date,midnight+day-1,midnight+day),false);
 assert.equal(midnight,Date.UTC(2099,8,19,18,30));
});

test('hydrated freshness cannot outlive an approaching shorter band',()=>{
 const p=new AvailabilityFreshnessPolicy(),boundary=journeyMidnight(date)-15*day;
 const time=boundary-100,observed=time-4*hour;
 assert.equal(p.isFresh(date,observed,time),true);assert.equal(p.freshUntil(date,observed,time),boundary);
 assert.equal(p.isFresh(date,observed,boundary),false);
 const custom=new AvailabilityFreshnessPolicy({over30:500,over15:400,over7:300,over2:200,near:100});
 assert.equal(custom.maximumAge(date,journeyMidnight(date)-day),100);
});


test('success-shaped persisted evidence carrying transport failures is rejected',()=>{
 const good=observation();
 for(const extra of [{failureCategory:'RATE_LIMITED'},{transportEvidence:{statusCode:500,failureCategory:'PROVIDER_SERVER_ERROR'}}])assert.throws(()=>validateObservation({...good,result:{...good.result,...extra}}));
});

test('SQLite write lock fails within bounded busy wait without corrupting latest evidence',t=>{
 const f=disk(t),store=new SqliteAvailabilityObservationStore({...availabilityStateConfig({}),path:f.path,busyTimeoutMs:10},()=>now);f.handles.push(store);store.upsertLatest(observation('WAITLIST',now-1));
 const blocker=new DatabaseSync(f.path);f.handles.push(blocker);blocker.exec('BEGIN IMMEDIATE');
 try{assert.throws(()=>store.upsertLatest(observation()));}finally{blocker.exec('ROLLBACK');}
 assert.equal(store.getLatest(request)!.result.days[0].state,'WAITLIST');
 store.upsertLatest(observation());assert.equal(store.getLatest(request)!.result.days[0].state,'AVAILABLE');
});

test('exactly 48 hours uses the one-hour band and the next millisecond uses 30 minutes',()=>{
 const policy=new AvailabilityFreshnessPolicy(),boundary=journeyMidnight(date)-2*day,observed=boundary-45*60000;
 assert.equal(policy.isFresh(date,observed,boundary),true);
 assert.equal(policy.freshUntil(date,observed,boundary),boundary+1);
 assert.equal(policy.isFresh(date,observed,boundary+1),false);
});


test('persisted counts must agree with the normalized status text',()=>{
 const good=observation(),day=good.result.days[0];
 for(const count of ['many',-1,999])assert.throws(()=>validateObservation({...good,result:{...good.result,days:[{...day,availableCount:count}]}}));
});
