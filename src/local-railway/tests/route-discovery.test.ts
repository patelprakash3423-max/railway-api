import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {RailwayDatabase} from '../database.js';
import type {LocalDataset} from '../types.js';
import {JourneyV2ApiService} from '../../api/services/journey-v2-service.js';
import {createRouter} from '../../api/router.js';
import type {AvailabilityRequest,AvailabilityResult} from '../../domain/types/availability.js';
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

test('normal search uses zero inventory calls, even without configured provider',async t=>{
 const h=setup(t);const service=new JourneyV2ApiService(h.db,{assertConfigured(){throw Error('No credentials');},getAvailability:async()=>{throw Error('Forbidden');}});
 const r=await service.search(h.input);assert.ok(r.results.length);assert.equal(r.results[0].status,'NOT_CHECKED');assert.equal(r.results[0].legs[0].segments.length,0);assert.equal(h.calls.length,0);
});
test('selected route checks only selected train and preserves route identity',async t=>{
 const h=setup(t);h.data.trains.push({...h.data.trains[0],number:'30002'});h.data.stops.push(...h.data.stops.map(s=>({...s,trainNumber:'30002'})));h.data.metadata.trainCount=2;h.data.metadata.stopCount=6;h.db.replace(h.data);
 const routes=await h.service.search(h.input);assert.equal(routes.results.length,2);
 const chosen=routes.results[1];const r=await h.service.checkAvailability({...h.input,routeId:chosen.id});assert.equal(r.results.length,1);assert.equal(r.results[0].id,chosen.id);assert.ok(h.calls.length);assert.ok(h.calls.every(c=>c.trainNumber===chosen.legs[0].trainNumber));
});
test('selected train discovers useful prefix when whole journey has no seats',async t=>{
 const h=setup(t,r=>r.toStationCode==='BBB'?'AVAILABLE':'WAITLIST');const route=(await h.service.search(h.input)).results[0];
 const r=await h.service.checkAvailability({...h.input,routeId:route.id});assert.ok(r.results[0].legs[0].segments.some(s=>s.type==='RESERVED'&&s.toStation==='BBB'));assert.ok(h.calls.some(c=>c.toStationCode==='CCC'));
});
test('invalid selected route never invokes provider',async t=>{const h=setup(t);await assert.rejects(h.service.checkAvailability({...h.input,routeId:'a'.repeat(64)}));assert.equal(h.calls.length,0);});
test('selected route retains hard provider budget',async t=>{const h=setup(t,()=> 'WAITLIST');const route=(await h.service.search(h.input)).results[0];const service=new JourneyV2ApiService(h.db,{getAvailability:async r=>{h.calls.push(r);return {request:r,provider:'railkit',providerState:'SUCCESS',days:[{date:r.journeyDate,state:'WAITLIST'}]};}},{providerCallBudgetLimit:2,diagnostics:true});const result=await service.checkAvailability({...h.input,routeId:route.id});assert.ok(h.calls.length<=2);assert.equal(result.diagnostics?.providerCallBudgetLimit,2);});

test('15565 SV to NDLS keeps useful SV to GKP coverage below old 50 percent threshold',async t=>{
 const h=setup(t,r=>r.toStationCode==='GKP'?'AVAILABLE':'WAITLIST');
 const codes:Record<string,string>={AAA:'SV',BBB:'GKP',CCC:'NDLS'};
 h.data.stations=h.data.stations.map(s=>({...s,code:codes[s.code]}));
 h.data.trains=h.data.trains.map(t=>({...t,number:'15565',name:'VAISHALI EXP',sourceCode:'SV',destinationCode:'NDLS'}));
 h.data.stops=h.data.stops.map(s=>({...s,trainNumber:'15565',stationCode:codes[s.stationCode]}));h.data.stops[1].distanceKm=120;h.db.replace(h.data);
 const input={...h.input,from:'SV',to:'NDLS'};const route=(await h.service.search(input)).results[0];const r=await h.service.checkAvailability({...input,routeId:route.id});
 assert.ok(r.results[0].legs[0].segments.some(s=>s.type==='RESERVED'&&s.fromStation==='SV'&&s.toStation==='GKP'));assert.equal(r.results[0].reservedCoverageRatio,.2);
});
test('discovery retains ranked direct and sensible connecting trains without live inventory',async t=>{
 const h=setup(t);h.data.trains.push({...h.data.trains[0],number:'30002',destinationCode:'BBB'},{...h.data.trains[0],number:'30003',sourceCode:'BBB'});
 h.data.stops.push({trainNumber:'30002',stationCode:'AAA',sequence:1,dayOffset:0,departureTime:'06:30',distanceKm:0},{trainNumber:'30002',stationCode:'BBB',sequence:2,dayOffset:0,arrivalTime:'08:30',distanceKm:420},{trainNumber:'30003',stationCode:'BBB',sequence:1,dayOffset:0,departureTime:'09:00',distanceKm:0},{trainNumber:'30003',stationCode:'CCC',sequence:2,dayOffset:0,arrivalTime:'11:00',distanceKm:180});h.db.replace(h.data);
 const r=await h.service.search(h.input);assert.ok(r.results.some(j=>j.trainChanges===0));assert.ok(r.results.some(j=>j.trainChanges===1));assert.equal(h.calls.length,0);assert.deepEqual(r.results.map(j=>j.presentation.displayRank),r.results.map((_,i)=>i+1));
 const selected=r.results.find(j=>j.trainChanges===1)!;
 const checked=await h.service.checkAvailability({...h.input,routeId:selected.id});
 assert.equal(checked.results.length,1);assert.equal(checked.results[0].reservedCoverageRatio,1);
 assert.ok(h.calls.every(c=>selected.legs.some(l=>l.trainNumber===c.trainNumber)));
 assert.equal(checked.diagnostics!.selectedRoute!.traversedScheduledStopCount,4);
 assert.equal(checked.diagnostics!.selectedRoute!.calculatedDynamicBudget,60);
 const calls:AvailabilityRequest[]=[];
 const limited=new JourneyV2ApiService(h.db,{getAvailability:async request=>{calls.push(request);return {request,provider:'railkit',providerState:'SUCCESS',days:[{date:request.journeyDate,state:'WAITLIST'}]};}},{diagnostics:true,selectedRouteBudgetPolicy:{base:1,callsPerStop:1,minimum:1,maximum:500},providerCallBudgetLimit:3});
 const result=await limited.checkAvailability({...h.input,routeId:selected.id});
 assert.equal(result.diagnostics!.selectedRoute!.calculatedDynamicBudget,5);
 assert.equal(result.diagnostics!.selectedRoute!.effectiveProviderCallLimit,3);
 assert.equal(calls.length,3); // One journey-wide allowance, never three per train.
});
