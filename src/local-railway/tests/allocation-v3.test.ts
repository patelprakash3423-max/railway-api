import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {RailwayDatabase} from '../database.js';
import type {LocalDataset} from '../types.js';
import type {V2Journey,V2Leg} from '../planner/v2/types.js';
import type {AvailabilityRequest,AvailabilityResult} from '../../domain/types/availability.js';
import {JourneyRecoveryOrchestrator} from '../../journey/availability/journey/orchestrator.js';
const date='18-09-2026';
type State='AVAILABLE'|'RAC'|'WAITLIST'|'UNSUPPORTED';
async function trace(t:TestContext,legs:number,rule:(r:AvailabilityRequest)=>State,classes=['ALL'],count=30,extra={}){
 const db=new RailwayDatabase(':memory:');t.after(()=>db.close());
 const trains:LocalDataset['trains']=[],stops:LocalDataset['stops']=[];
 const codes=Array.from({length:legs+1},(_,i)=>`S${i}`);
 const candidates:V2Journey[]=Array.from({length:count},(_,rank)=>{
  const segments:V2Leg[]=Array.from({length:legs},(_,i)=>{
   const trainNumber=String(30000+rank*10+i),from=codes[i],to=codes[i+1],mid=`M${i}`;
   const times=[`${String(6+i*4).padStart(2,'0')}:00`,`${String(7+i*4).padStart(2,'0')}:00`,`${String(9+i*4).padStart(2,'0')}:00`];
   trains.push({number:trainNumber,name:trainNumber,sourceCode:from,destinationCode:to,runningDaysRaw:'Daily',runningDays:['MON','TUE','WED','THU','FRI','SAT','SUN']});
   [from,mid,to].forEach((stationCode,k)=>stops.push({trainNumber,stationCode,sequence:k+1,dayOffset:0,arrivalTime:k?times[k]:undefined,departureTime:k<2?times[k]:undefined,distanceKm:[0,70,100][k]}));
   return {trainNumber,trainName:trainNumber,from,to,fromStation:from,toStation:to,boardingDate:date,originDate:date,departureDateTime:`2026-09-18T${times[0]}:00+05:30`,boardingDateTime:`2026-09-18T${times[0]}:00+05:30`,arrivalDateTime:`2026-09-18T${times[2]}:00+05:30`,distanceKm:100};
  });
  return {from:codes[0],to:codes[legs],departureDateTime:segments[0].departureDateTime,arrivalDateTime:segments.at(-1)!.arrivalDateTime,durationMinutes:legs*240-60,changes:legs-1,segments,connections:[],totalDistanceKm:100*legs,interchangeTiers:[],distanceDetourPercent:0,durationDetourPercent:0};
 });
 const stations=[...codes,...Array.from({length:legs},(_,i)=>`M${i}`)].map(code=>({code,name:code}));
 db.replace({trains,stops,stations,metadata:{source:'RAILPULL_NTES',importedAt:'2026-09-14T00:00:00Z',trainCount:trains.length,stationCount:stations.length,stopCount:stops.length}});
 const calls:AvailabilityRequest[]=[];
 const result=await new JourneyRecoveryOrchestrator(db,{getAvailability:async(r):Promise<AvailabilityResult>=>{calls.push(r);const state=rule(r);return state==='UNSUPPORTED'?{request:r,provider:'railkit',providerState:'PROVIDER_ERROR',days:[],providerMessage:'Class does not exist in this train for this Train route'}:{request:r,provider:'railkit',providerState:'SUCCESS',days:[{date:r.journeyDate,state}]};}},extra).validate({source:codes[0],destination:codes[legs],journeyDate:date,requestedClasses:classes,mode:'STANDARD',plannerCandidates:candidates});
 assert.ok(calls.length<=30);
 assert.equal(result.diagnostics.wholeLegRequests+result.diagnostics.recoveryIntervalRequests,calls.length);
 return {...result,calls};
}
for(const legs of [1,2,3])test(`V3 all-negative 30 candidates, ${legs} legs: breadth exceeds old three-candidate depth`,async t=>{
 const r=await trace(t,legs,q=>q.travelClass==='SL'?'UNSUPPORTED':'WAITLIST');
 assert.ok(r.diagnostics.distinctCandidatesWithAnyWholeLegEvidence>3);
 assert.equal(r.diagnostics.recoveryReserveInitial,8);
 const firstRecovery=r.calls.findIndex(q=>q.fromStationCode.startsWith('M')||q.toStationCode.startsWith('M'));
 if(firstRecovery>=0)assert.ok(firstRecovery<=22);
 assert.equal(r.diagnostics.recoveryReserveUsed+r.diagnostics.recoveryReserveReleased,8);
 t.diagnostic(JSON.stringify({legs,calls:r.calls.length,evidence:r.diagnostics.distinctCandidatesWithAnyWholeLegEvidence,recovery:r.diagnostics.recoveryIntervalRequests}));
});
test('V3 reaches rank five 3A success before early candidates widen',async t=>{
 const r=await trace(t,1,q=>q.trainNumber==='30040'&&q.travelClass==='3A'?'AVAILABLE':'WAITLIST');
 assert.equal(r.journeys.find(j=>j.scheduleRank===5)?.journeyStatus,'FULLY_RESERVED_USABLE');
 const hit=r.calls.findIndex(q=>q.trainNumber==='30040'&&q.travelClass==='3A');
 assert.ok(hit>=0&&hit<r.calls.findIndex(q=>q.travelClass==='2A'));
 t.diagnostic(JSON.stringify({rank:5,calls:r.calls.length}));
});
test('V3 fully validates multi-leg early success',async t=>{
 const r=await trace(t,2,q=>q.travelClass==='3A'?'AVAILABLE':'WAITLIST');
 assert.equal(r.journeys[0].journeyStatus,'FULLY_RESERVED_USABLE');
 assert.equal(r.journeys[0].wholeLegValidation.legs.filter(l=>l.availabilityStatus==='AVAILABLE').length,2);
});
for(const c of ['2A','1A','EC','3E'])test(`V3 completion reaches ${c}`,async t=>{
 const r=await trace(t,1,q=>q.travelClass===c?'AVAILABLE':'WAITLIST');
 assert.equal(r.journeys.find(j=>j.scheduleRank===1)?.journeyStatus,'FULLY_RESERVED_USABLE');
 assert.ok(r.diagnostics.completionRequests>0);
 if(c!=='2A')assert.ok(r.diagnostics.deepWideningRequests>0);
});
for(const classes of [['3A'],['3A','SL'],['2A','3A']])test(`V3 explicit canonical ${classes}`,async t=>{
 const r=await trace(t,2,()=> 'WAITLIST',classes,5,{maxRecoveryRequestsPerCandidate:0});
 const order=['SL','3A','2A'].filter(c=>classes.includes(c));
 for(const train of new Set(r.calls.map(q=>q.trainNumber)))assert.deepEqual(r.calls.filter(q=>q.trainNumber===train).map(q=>q.travelClass),order);
 assert.ok(r.calls.length<=5*2*classes.length);
});
for(const state of ['AVAILABLE','RAC'] as const)test(`V3 short circuits ${state}`,async t=>{
 const r=await trace(t,2,()=>state);
 assert.ok(r.calls.every(q=>q.travelClass==='SL'));
 assert.equal(r.diagnostics.recoveryIntervalRequests,0);
});
test('V3 atomic class group cannot partially spend one call on two legs',async t=>{
 const r=await trace(t,2,()=> 'WAITLIST',['3A'],1,{budgetLimit:1,recoveryReserve:0});
 assert.equal(r.calls.length,0);assert.ok(r.diagnostics.candidatesDeferredByAtomicCost>0);
});
test('V3 recovery prefers later candidate with usable leg and one failed leg',async t=>{
 const r=await trace(t,2,q=>q.trainNumber==='30010'||q.toStationCode.startsWith('M')?'AVAILABLE':'WAITLIST',['3A'],2);
 const first=r.calls.find(q=>q.toStationCode.startsWith('M')||q.fromStationCode.startsWith('M'));
 assert.equal(first?.trainNumber,'30011');
 assert.ok(r.journeys.find(j=>j.scheduleRank===2)!.reservedCoverageRatio>=.5);
});
