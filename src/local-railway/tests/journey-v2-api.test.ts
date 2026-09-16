import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RailwayDatabase} from '../database.js';
import type {LocalDataset} from '../types.js';
import {JourneyV2ApiService,openProductionRailwayDatabase} from '../../api/services/journey-v2-service.js';
import {createRouter} from '../../api/router.js';
import {createHttpHandler} from '../../api/server.js';
import type {AvailabilityRequest,AvailabilityResult} from '../../domain/types/availability.js';
import type {IncomingMessage,ServerResponse} from 'node:http';
const date='18-09-2026';
function setup(t:TestContext,rule:(r:AvailabilityRequest)=>string=()=> 'AVAILABLE'){
 const db=new RailwayDatabase(':memory:');t.after(()=>db.close());
 const data:LocalDataset={stations:['AAA','BBB','CCC'].map(code=>({code,name:code})),trains:[{number:'30001',name:'Test train',sourceCode:'AAA',destinationCode:'CCC',runningDaysRaw:'Daily',runningDays:['MON','TUE','WED','THU','FRI','SAT','SUN']}],stops:['AAA','BBB','CCC'].map((stationCode,i)=>({trainNumber:'30001',stationCode,sequence:i+1,dayOffset:0,arrivalTime:i?['06:00','09:00','12:00'][i]:undefined,departureTime:i<2?['06:00','09:00','12:00'][i]:undefined,distanceKm:[0,420,600][i]})),metadata:{source:'RAILPULL_NTES',importedAt:'2026-09-14T00:00:00Z',trainCount:1,stationCount:3,stopCount:3,label:'SYNTHETIC_TEST_FIXTURE'}};
 db.replace(data);const calls:AvailabilityRequest[]=[],logs:Record<string,unknown>[]=[];let discovery=0,info=0,legacy=0;
 const provider={getAvailability:async(r:AvailabilityRequest):Promise<AvailabilityResult>=>{calls.push(r);const state=rule(r);return state==='AVAILABLE'||state==='WAITLIST'||state==='RAC'?{request:r,provider:'railkit',providerState:'SUCCESS',days:[{date:r.journeyDate,state}],fare:state==='WAITLIST'?undefined:{currency:'INR',totalFare:100}}:{request:r,provider:'railkit',providerState:'PROVIDER_ERROR',days:[],providerMessage:state};},getTrainInfo:async()=>{info++;throw Error('Forbidden info');},searchTrainBetweenStations:async()=>{discovery++;throw Error('Forbidden discovery');},searchTrainsBetweenStations:async()=>{discovery++;throw Error('Forbidden discovery');}};
 const service=new JourneyV2ApiService(db,provider,{diagnostics:true,logger:r=>logs.push(r)});
 const old={search:async():Promise<never>=>{legacy++;throw Error('Legacy forbidden');}};
 const router=createRouter(old,{journeyV2:service,corsOrigin:'http://localhost:3000',logger:()=>{}});
 const input={from:'AAA',to:'CCC',date,classes:['SL','3A'],mode:'STANDARD'};
 const request=(body:unknown=input)=>router({method:'POST',path:'/api/journeys/v2/search',contentType:'application/json',body:JSON.stringify(body),origin:'http://localhost:3000'});
 return {db,data,calls,logs,service,old,router,input,request,counts:()=>({discovery,info,legacy})};
}
test('production V2 route uses local planner and only availability; compact full result',async t=>{
 const h=setup(t),reply=await h.request(),r=JSON.parse(reply.body);assert.equal(reply.status,200);assert.equal(reply.headers['Access-Control-Allow-Origin'],'http://localhost:3000');assert.equal(r.results[0].status,'FULLY_RESERVED_USABLE');assert.equal(r.results[0].totalFare.amount,100);assert.equal(r.results[0].reservedCoverageRatio,1);assert.equal(r.diagnostics.budgetLimit,30);assert.equal(r.diagnostics.recoveryReserveInitial,8);assert.deepEqual(h.counts(),{discovery:0,info:0,legacy:0});
 assert.equal(r.presentation.version,1);assert.equal(r.presentation.initialVisibleCount,5);
 assert.equal(r.presentation.summary.totalJourneys,r.results.length);
 for(const [i,j] of r.results.entries()){
  assert.equal(j.presentation.displayRank,i+1);assert.ok(j.presentation.engineRank>=1);
  assert.ok(['RECOMMENDED','RECOVERY','OTHER'].includes(j.presentation.group));
  assert.ok(Array.isArray(j.presentation.badges));assert.equal(j.presentation.variantGroupId,j.presentation.journeySignature);
  assert.equal(typeof j.presentation.isPrimaryVariant,'boolean');assert.equal(typeof j.presentation.alternateVariantCount,'number');
  assert.ok(j.legs.length);assert.ok(j.departureDateTime);assert.ok(j.totalFare);
 }
 assert.equal(r.results[0].presentation.badges[0],'BEST_OPTION');
 assert.doesNotMatch(reply.body,/rawDetails|wholeLegValidation|scheduleCandidate|RAILKIT_API_KEY|providerMessage/);assert.deepEqual(h.logs.map(l=>l.event),['journey_v2_search_started','journey_v2_search_completed']);
});
test('production V2 split class preserves RAC and interval order',async t=>{
 const h=setup(t,r=>r.toStationCode==='BBB'&&r.travelClass==='SL'?'AVAILABLE':r.fromStationCode==='BBB'&&r.travelClass==='3A'?'RAC':'WAITLIST');
 const reply=await h.request(),r=JSON.parse(reply.body);assert.equal(reply.status,200);const j=r.results[0];assert.equal(j.status,'FULLY_RESERVED_WITH_SPLIT_CLASS');assert.equal(j.trainChanges,0);assert.equal(j.classChanges,1);assert.deepEqual(j.legs[0].segments.map((s:{selectedClass:string})=>s.selectedClass),['SL','3A']);assert.equal(j.legs[0].segments[1].availabilityStatus,'RAC');
});
test('production V2 partial recovery preserves SELF_MANAGED and incomplete fare',async t=>{
 const h=setup(t,r=>r.toStationCode==='BBB'&&r.travelClass==='SL'?'AVAILABLE':'WAITLIST');const reply=await h.request(),j=JSON.parse(reply.body).results[0];assert.equal(j.status,'PARTIAL_RESERVED_RECOVERY');assert.equal(j.reservedCoverageRatio,.7);assert.equal(j.totalFare.status,'PARTIAL');assert.equal(j.legs[0].segments[1].type,'SELF_MANAGED');assert.ok(!('fare'in j.legs[0].segments[1]));assert.ok(h.calls.length<=30);
});
test('production V2 provider failures retain scheduled incomplete results',async t=>{
 const h=setup(t,()=> 'Provider offline');const reply=await h.request(),r=JSON.parse(reply.body);assert.equal(reply.status,200);assert.ok(r.results.length);assert.equal(r.results[0].status,'INVENTORY_CHECK_INCOMPLETE');assert.equal(r.summary.inventoryIncomplete,1);
});
test('production V2 unsupported class continues other classes without generic 500',async t=>{
 const h=setup(t,r=>r.travelClass==='SL'?'Class does not exist in this train for this Train route':'AVAILABLE');const reply=await h.request(),r=JSON.parse(reply.body);assert.equal(reply.status,200);assert.equal(r.results[0].status,'FULLY_RESERVED_USABLE');assert.equal(r.diagnostics.unsupportedClassResponses,1);assert.equal(r.diagnostics.providerErrors,0);
});
for(const patch of [{from:''},{from:'ZZZZZ'},{to:'AAA'},{date:'31-02-2026'},{date:'2026-09-18'},{classes:[]},{classes:['BAD']},{classes:['ALL','SL']},{mode:'INVALID'},{quota:'TQ'}])test(`production V2 validates ${JSON.stringify(patch)}`,async t=>{const h=setup(t);const reply=await h.request({...h.input,...patch});assert.equal(reply.status,400);assert.equal(h.calls.length,0);});
for(const [mode,limit,reserve]of [['QUICK',12,3],['STANDARD',30,8],['DEEP',40,10]])test(`API preserves ${mode} global budget/reserve and request-local cache`,async t=>{
 const h=setup(t,()=> 'WAITLIST');const a=JSON.parse((await h.request({...h.input,mode,classes:'ALL'})).body),used=h.calls.length;assert.ok(used<=Number(limit));assert.equal(a.diagnostics.budgetLimit,Number(limit));assert.equal(a.diagnostics.recoveryReserveInitial,Number(reserve));assert.equal(a.diagnostics.wholeLegCalls+a.diagnostics.recoveryCalls,used);assert.ok(a.diagnostics.cacheHits>0);await h.request({...h.input,mode,classes:'ALL'});assert.equal(h.calls.length,used*2);assert.deepEqual(h.counts(),{discovery:0,info:0,legacy:0});
});
test('V2 preflight retains explicit-origin CORS without invoking any service',async t=>{const h=setup(t);const reply=await h.router({method:'OPTIONS',path:'/api/journeys/v2/search',origin:'http://localhost:3000'});assert.equal(reply.status,204);assert.equal(reply.headers['Access-Control-Allow-Origin'],'http://localhost:3000');const denied=await h.router({method:'OPTIONS',path:'/api/journeys/v2/search',origin:'https://untrusted.example'});assert.equal(denied.headers['Access-Control-Allow-Origin'],undefined);assert.equal(h.calls.length,0);});
test('HTTP handler reads V2 POST body without opening network sockets',async t=>{
 const h=setup(t);let status=0,body='';const request={once:()=>{},removeListener:()=>{},socket:{remoteAddress:'127.0.0.1'},method:'POST',url:'/api/journeys/v2/search',headers:{'content-type':'application/json'},iterator:async function*(){yield Buffer.from(JSON.stringify(h.input));}} as unknown as IncomingMessage;
 const response={once:()=>{},removeListener:()=>{},writeHead:(s:number)=>{status=s;},end:(b:string)=>{body=b;}} as unknown as ServerResponse;
 await createHttpHandler(h.old,{journeyV2:h.service,logger:()=>{}})(request,response);assert.equal(status,200);assert.equal(JSON.parse(body).results[0].status,'FULLY_RESERVED_USABLE');assert.equal(h.counts().legacy,0);
});
test('production dataset rejects missing and synthetic files, accepts valid imported metadata',t=>{
 const h=setup(t),dir=mkdtempSync(join(tmpdir(),'v2-db-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));assert.throws(()=>openProductionRailwayDatabase(join(dir,'missing.sqlite')),/dataset/);
 const path=join(dir,'data.sqlite'),db=new RailwayDatabase(path);db.replace(h.data);db.close();assert.throws(()=>openProductionRailwayDatabase(path),/test fixture/);
 const real=new RailwayDatabase(path);real.replace({...h.data,metadata:{...h.data.metadata,label:'REAL_RAILPULL_EXPORT'}});real.close();const opened=openProductionRailwayDatabase(path);assert.equal(opened.readOnly,true);opened.close();
});
test('diagnostics are opt-in and defaults are STANDARD GN',async t=>{const h=setup(t);const r=await new JourneyV2ApiService(h.db,{getAvailability:async r=>({request:r,provider:'railkit',providerState:'SUCCESS',days:[{date:r.journeyDate,state:'AVAILABLE'}]})}).search({from:'AAA',to:'CCC',date,classes:'ALL'});assert.equal(r.search.mode,'STANDARD');assert.equal(r.search.quota,'GN');assert.equal(r.diagnostics,undefined);});
test('V2 endpoint returns display order after engine output, retaining train data and provider budget',async t=>{
 const h=setup(t,r=>r.trainNumber==='30001'?'RAC':'AVAILABLE');
 h.db.replace({...h.data,trains:[...h.data.trains,{...h.data.trains[0],number:'30002',name:'Available train'}],stops:[...h.data.stops,...h.data.stops.map(s=>({...s,trainNumber:'30002'}))]});
 const reply=await h.request(),r=JSON.parse(reply.body);
 assert.equal(reply.status,200);assert.equal(r.results.length,2);
 assert.deepEqual(r.results.map((j:{legs:{trainNumber:string}[]})=>j.legs[0].trainNumber),['30002','30001']);
 assert.deepEqual(r.results.map((j:{presentation:{displayRank:number}})=>j.presentation.displayRank),[1,2]);
 assert.equal(r.results[0].legs[0].trainName,'Available train');assert.equal(r.results[1].legs[0].segments[0].availabilityStatus,'RAC');
 assert.equal(r.presentation.summary.primaryJourneys,2);assert.equal(r.diagnostics.budgetLimit,30);assert.equal(r.diagnostics.recoveryReserveInitial,8);
 assert.equal(r.diagnostics.availabilityCalls,h.calls.length);assert.ok(h.calls.length<=30);assert.deepEqual(h.counts(),{discovery:0,info:0,legacy:0});
});
