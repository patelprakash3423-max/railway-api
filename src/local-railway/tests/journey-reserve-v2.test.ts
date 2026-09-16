import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {RailwayDatabase} from '../database.js';
import type {LocalDataset} from '../types.js';
import {LocalJourneyPlannerV2} from '../planner/v2/planner.js';
import {JourneyRecoveryOrchestrator} from '../../journey/availability/journey/orchestrator.js';
import {AvailabilitySession} from '../../journey/availability/session.js';
import {normalizeInventory,errorCategory} from '../../journey/availability/inventory.js';
import type {AvailabilityRequest,AvailabilityResult} from '../../domain/types/availability.js';
import type {SearchMode} from '../../application/search-mode.js';
const date='18-09-2026';
const unsupported='Class does not exist in this train for this Train route';
function setup(t:TestContext){
 const db=new RailwayDatabase(':memory:');t.after(()=>db.close());
 const trains:LocalDataset['trains']=Array.from({length:12},(_,i)=>({number:String(30001+i),name:`Train ${i}`,sourceCode:'AAA',destinationCode:'CCC',runningDaysRaw:'Daily',runningDays:['MON','TUE','WED','THU','FRI','SAT','SUN']}));
 db.replace({stations:['AAA','BBB','CCC'].map(code=>({code,name:code})),trains,stops:trains.flatMap(train=>['AAA','BBB','CCC'].map((stationCode,i)=>({trainNumber:train.number,stationCode,sequence:i+1,dayOffset:0,arrivalTime:i?['06:00','09:00','12:00'][i]:undefined,departureTime:i<2?['06:00','09:00','12:00'][i]:undefined,distanceKm:[0,420,600][i]}))),metadata:{source:'RAILPULL_NTES',importedAt:'2026-09-14T00:00:00Z',trainCount:12,stationCount:3,stopCount:36}});
 const planner=new LocalJourneyPlannerV2(db).search({from:'AAA',to:'CCC',date});
 return {db,input:{source:'AAA',destination:'CCC',journeyDate:date,requestedClasses:['ALL'],plannerCandidates:planner.journeys,plannerDiagnostics:planner.diagnostics}};
}
function provider(rule:(r:AvailabilityRequest)=>'AVAILABLE'|'WAITLIST'|string){
 const calls:AvailabilityRequest[]=[];let discovery=0,info=0;
 return {calls,counts:()=>({discovery,info}),getAvailability:async(r:AvailabilityRequest):Promise<AvailabilityResult>=>{calls.push(r);const state=rule(r);return state==='AVAILABLE'||state==='WAITLIST'?{request:r,provider:'railkit',providerState:'SUCCESS',days:[{date:r.journeyDate,state}]}:{request:r,provider:'railkit',providerState:'PROVIDER_ERROR',days:[],providerMessage:state};},searchTrainBetweenStations:async()=>{discovery++;throw Error('Forbidden');},searchTrainsBetweenStations:async()=>{discovery++;throw Error('Forbidden');},getTrainInfo:async()=>{info++;throw Error('Forbidden');}};
}
test('protected STANDARD capacity reaches a later recoverable candidate after early WAITLIST',async t=>{
 const {db,input}=setup(t);const train=input.plannerCandidates[1].segments[0].trainNumber;
 const p=provider(r=>r.trainNumber===train&&r.toStationCode==='BBB'&&r.travelClass==='SL'?'AVAILABLE':'WAITLIST');
 const r=await new JourneyRecoveryOrchestrator(db,p).validate({...input,mode:'STANDARD'}),d=r.diagnostics;
 const firstInterval=p.calls.findIndex(c=>c.fromStationCode==='BBB'||c.toStationCode==='BBB');
 assert.ok(firstInterval>=0&&firstInterval<=22);assert.ok(d.recoveryIntervalRequests>0);assert.ok(d.availabilityRequestsUsed<=30);assert.equal(d.recoveryReserveInitial,8);assert.ok(d.recoveryReserveUsed>0);
 assert.ok(r.journeys.some(j=>j.scheduleCandidate.segments[0].trainNumber===train&&j.journeyStatus==='PARTIAL_RESERVED_RECOVERY'));
 assert.deepEqual(p.counts(),{discovery:0,info:0});assert.equal(d.wholeLegRequests+d.recoveryIntervalRequests,p.calls.length);
});
test('early whole-leg success is retained without recovery',async t=>{
 const {db,input}=setup(t),p=provider(()=> 'AVAILABLE');const r=await new JourneyRecoveryOrchestrator(db,p,{usableTarget:1}).validate(input);
 assert.equal(r.journeys[0].journeyStatus,'FULLY_RESERVED_USABLE');assert.equal(r.diagnostics.recoveryIntervalRequests,0);assert.ok(p.calls.length<=22);
});
test('unused reserve releases to complete deferred whole-leg validation',async t=>{
 const {db,input}=setup(t),p=provider(r=>r.travelClass==='1A'?'AVAILABLE':'WAITLIST');
 const r=await new JourneyRecoveryOrchestrator(db,p,{usableTarget:6}).validate(input),d=r.diagnostics;
 assert.ok(d.recoveryReserveReleased>0);assert.ok(d.releasedReserveCalls>0);assert.equal(d.recoveryIntervalRequests,0);assert.ok(d.wholeLegRequests>22);assert.ok(d.availabilityRequestsUsed<=30);assert.ok(d.fullReservedJourneys>=3);
});
for(const [mode,limit,reserve]of [['QUICK',12,3],['STANDARD',30,8],['DEEP',40,10]]as const)test(`${mode} reserve and shared global hard limit`,async t=>{
 const {db,input}=setup(t),p=provider(()=> 'WAITLIST');const r=await new JourneyRecoveryOrchestrator(db,p).validate({...input,mode:mode as SearchMode}),d=r.diagnostics;
 assert.equal(d.availabilityBudgetLimit,limit);assert.equal(d.recoveryReserveInitial,reserve);assert.ok(p.calls.length<=limit);assert.equal(d.wholeLegRequests+d.recoveryIntervalRequests,p.calls.length);assert.equal(d.budgetRemaining,limit-p.calls.length);assert.equal(d.recoveryReserveUsed+d.recoveryReserveReleased,reserve);assert.deepEqual(p.counts(),{discovery:0,info:0});
});
const request:AvailabilityRequest={trainNumber:'30001',fromStationCode:'AAA',toStationCode:'CCC',journeyDate:date,travelClass:'SL',quota:'GN'};
test('route unsupported phrase has an explicit category and exact concurrent cache',async()=>{
 const p=provider(()=>unsupported),session=new AvailabilitySession(p,30);
 const [a,b]=await Promise.all([session.get(request),session.get({...request})]);
 assert.equal(a.status,'UNSUPPORTED_CLASS');assert.equal(a.errorCategory,'UNSUPPORTED_CLASS');assert.deepEqual(a,b);assert.equal(p.calls.length,1);assert.equal(session.statistics().unsupportedClassResponses,1);assert.equal(session.statistics().providerErrors,0);assert.equal(session.statistics().providerErrorCategories.UNKNOWN_PROVIDER_ERROR,undefined);
 await session.get({...request,toStationCode:'BBB'});assert.equal(p.calls.length,2);assert.equal(session.unsupported.size,0);
});
test('unsupported class allows another class to succeed in Journey V2',async t=>{
 const {db,input}=setup(t),p=provider(r=>r.travelClass==='SL'?unsupported:'AVAILABLE');const r=await new JourneyRecoveryOrchestrator(db,p,{usableTarget:1}).validate(input);
 assert.equal(r.journeys[0].journeyStatus,'FULLY_RESERVED_USABLE');assert.equal(r.journeys[0].legs[0].segments[0].type,'RESERVED');assert.ok(r.diagnostics.unsupportedClassResponses>0);assert.equal(r.diagnostics.providerErrors,0);
});
test('unsupported detection stays narrow and cannot override rate limits or outages',()=>{
 assert.equal(errorCategory({status:429,providerMessage:unsupported}),'RATE_LIMITED');assert.equal(errorCategory({providerState:'PROVIDER_UNAVAILABLE',providerMessage:unsupported}),'PROVIDER_UNAVAILABLE');
 for(const providerMessage of ['Class lookup failed','Class does not exist because the service failed','Server error'])assert.equal(normalizeInventory(request,{request,provider:'railkit',providerState:'PROVIDER_ERROR',days:[],providerMessage}).errorCategory,'UNKNOWN_PROVIDER_ERROR');
});
test('thrown route unsupported phrase is also scoped to the exact request',async()=>{
 let calls=0;const session=new AvailabilitySession({getAvailability:async()=>{calls++;throw Error(unsupported);}},3);
 const a=await session.get(request);await session.get({...request});await session.get({...request,journeyDate:'19-09-2026'});
 assert.equal(a.status,'UNSUPPORTED_CLASS');assert.equal(calls,2);assert.equal(session.unsupported.size,0);assert.equal(session.statistics().providerErrors,0);assert.equal(session.statistics().unsupportedClassResponses,2);
});
test('protected whole-leg atomic groups never partially consume their allowance',async t=>{
 const {db,input}=setup(t),p=provider(()=> 'WAITLIST');
 const r=await new JourneyRecoveryOrchestrator(db,p,{recoveryReserve:29,usableTarget:20}).validate(input);
 // Only one call is available during the protected pass. V3 can check SL
 // atomically, but cannot establish failure across all classes for recovery.
 assert.equal(r.diagnostics.recoveryReserveUsed,0);assert.equal(r.diagnostics.recoveryReserveReleased,29);assert.ok(r.diagnostics.releasedReserveCalls>0);assert.ok(p.calls.length<=30);
});
