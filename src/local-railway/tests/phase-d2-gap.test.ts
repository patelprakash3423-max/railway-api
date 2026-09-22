import test from 'node:test';
import assert from 'node:assert/strict';
import {RailwayDatabase} from '../database.js';
import {networkFor} from '../planner/v2/network.js';
import type {LocalDataset} from '../types.js';
import type {V2Journey} from '../planner/v2/types.js';
import type {AvailabilityRequest,AvailabilityResult} from '../../domain/types/availability.js';
import {JourneyRecoveryOrchestrator} from '../../journey/availability/journey/orchestrator.js';

// Captured timetable slice, independent of the installed railway database.
// All seven intermediate stops are MAJOR in the source dataset.
const route=[
 ['SV',263,'13:40','13:45',0],['DEOS',333,'14:40','14:42',0],
 ['GKP',383,'15:50','16:00',0],['GD',536,'18:06','18:08',0],
 ['BNZ',649,'20:13','20:16',0],['ASH',658,'20:45','20:55',0],
 ['ON',713,'22:07','22:08',0],['CNB',730,'22:40','22:45',0],
 ['NDLS',1171,'05:05',undefined,1],
] as const;
for(const count of [1,3])for(const classes of [['ALL'],['SL'],['SL','3A']])test(
 'D2 gap subintervals reach later stations/classes within STANDARD: '+count+' direct, '+classes,async t=>{
 const db=new RailwayDatabase(':memory:');t.after(()=>db.close());
 const trains:LocalDataset['trains']=[{number:'12565',name:'fixture',sourceCode:'SV',destinationCode:'NDLS',runningDaysRaw:'Daily',runningDays:['MON','TUE','WED','THU','FRI','SAT','SUN']}];
 const stops:LocalDataset['stops']=route.map(([stationCode,distanceKm,arrivalTime,departureTime,dayOffset],i)=>({trainNumber:'12565',stationCode,distanceKm,arrivalTime,departureTime,dayOffset,sequence:i+1}));
 for(let i=1;i<count;i++){const number=String(12565+i);trains.push({...trains[0],number});stops.push(...stops.slice(0,route.length).map(s=>({...s,trainNumber:number})));}
 db.replace({trains,stops,stations:route.map(([code])=>({code,name:code})),metadata:{source:'RAILPULL_NTES',importedAt:'2026-09-13T16:08:49.621Z',trainCount:count,stationCount:9,stopCount:stops.length}});
 for(const metric of networkFor(db).metrics.values())metric.tier='MAJOR';
 const date='19-11-2026',departure='2026-11-19T13:45:00+05:30',arrival='2026-11-20T05:05:00+05:30';
 const candidate:V2Journey={from:'SV',to:'NDLS',departureDateTime:departure,arrivalDateTime:arrival,durationMinutes:920,changes:0,connections:[],totalDistanceKm:908,interchangeTiers:[],distanceDetourPercent:0,durationDetourPercent:0,
  segments:[{trainNumber:'12565',trainName:'fixture',from:'SV',to:'NDLS',fromStation:'SV',toStation:'NDLS',boardingDate:date,originDate:date,departureDateTime:departure,boardingDateTime:departure,arrivalDateTime:arrival,distanceKm:908}]};
 const calls:AvailabilityRequest[]=[];
 const provider={getAvailability:async(r:AvailabilityRequest):Promise<AvailabilityResult>=>{
  calls.push({...r});
  const tail=r.trainNumber==='12565'&&r.fromStationCode==='CNB'&&r.toStationCode==='NDLS'&&r.travelClass==='SL';
  const head=r.trainNumber==='12565'&&r.fromStationCode==='SV'&&r.toStationCode==='GKP'&&r.travelClass==='1A';
  return {request:r,provider:'railkit',providerState:'SUCCESS',days:[{date:r.journeyDate,state:tail||head?'AVAILABLE':'WAITLIST',availabilityText:tail?'AVL 3':head?'AVL 1':'WL 1'}]};
 }};
 const result=await new JourneyRecoveryOrchestrator(db,provider).validate({source:'SV',destination:'NDLS',journeyDate:date,requestedClasses:classes,mode:'STANDARD',plannerCandidates:Array.from({length:count},(_,i)=>({...candidate,segments:candidate.segments.map(l=>({...l,trainNumber:String(12565+i)}))}))});
 const journey=result.journeys[0];
 assert.ok(calls.length<=30);assert.equal(result.diagnostics.availabilityBudgetLimit,30);
 assert.equal(result.diagnostics.attemptedAvailabilityChecks,calls.length);
 assert.equal(new Set(calls.map(r=>JSON.stringify(r))).size,calls.length,'revisits reuse session evidence');
 assert.ok(!journey.journeyStatus.startsWith('FULLY_RESERVED'));
 if(classes[0]==='ALL'){
  assert.ok(calls.some(r=>r.fromStationCode==='SV'&&r.toStationCode==='GKP'&&r.travelClass==='1A'),JSON.stringify(calls));
  assert.equal(journey.reservedDistanceKm,561);
  assert.equal(journey.reservedCoverageRatio,561/908);
  assert.equal(journey.journeyStatus,'PARTIAL_RESERVED_RECOVERY');
  assert.equal(journey.selfManagedDistanceKm,347);
  assert.equal(journey.trainChanges,0);
  if(count===1)assert.deepEqual(calls.slice(0,8).map(r=>[r.fromStationCode,r.toStationCode]),Array.from({length:8},()=>['SV','NDLS']));
  if(count===3){
   assert.deepEqual(calls.slice(0,3).map(r=>[r.trainNumber,r.travelClass]),['12565','12566','12567'].map(n=>[n,'SL']));
   const firstRecovery=calls.findIndex(r=>r.fromStationCode!=='SV'||r.toStationCode!=='NDLS');
   assert.ok(firstRecovery<calls.findIndex(r=>r.travelClass==='2A'));
   assert.equal(result.diagnostics.directWholeLegChecks,10);
   assert.equal(result.diagnostics.recoveryIntervalRequests,20);
   assert.equal(result.diagnostics.budgetRemaining,0);
   assert.equal(calls.length,30);
   assert.deepEqual(calls.at(-1),{trainNumber:'12565',fromStationCode:'SV',toStationCode:'GKP',journeyDate:date,travelClass:'1A',quota:'GN'});
   assert.ok(result.journeys.slice(1).every(j=>j.journeyStatus==='INVENTORY_CHECK_INCOMPLETE'&&j.unknownDistanceKm===908));
   assert.ok(result.diagnostics.directExploration.slice(1).every(d=>d.state!=='EXHAUSTED_SCOPE'));
   assert.equal(result.diagnostics.directWholeLegChecks+result.diagnostics.recoveryIntervalRequests,calls.length);
   for(const [i,r] of calls.entries())if(r.fromStationCode!=='SV'||r.toStationCode!=='NDLS')
    assert.ok(calls.slice(0,i).some(exact=>exact.trainNumber===r.trainNumber&&exact.fromStationCode==='SV'&&exact.toStationCode==='NDLS'&&exact.travelClass===r.travelClass),'exact class precedes recovery');
  }
 }else{
  assert.ok(calls.every(r=>classes.includes(r.travelClass)));
  assert.equal(journey.reservedDistanceKm,441);
 }
});
