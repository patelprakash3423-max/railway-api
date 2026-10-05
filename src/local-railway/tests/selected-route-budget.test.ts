import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {selectedRouteBudgetPolicy,calculateSelectedRouteBudget} from '../../config/selected-route-budget.js';
import {hardeningConfig} from '../../config/hardening.js';
import {RailwayDatabase} from '../database.js';
import {JourneyV2ApiService} from '../../api/services/journey-v2-service.js';
import {traversedScheduledStopCount} from '../../journey/availability/selected-route-budget.js';
import {LocalJourneyPlannerV2} from '../planner/v2/planner.js';
import type {AvailabilityRequest,AvailabilityResult} from '../../domain/types/availability.js';
const policy=selectedRouteBudgetPolicy({}),date='18-09-2099';
for(const [stops,budget] of [[5,60],[10,80],[30,200],[50,320],[70,440],[100,500]])test(`${stops} scheduled stops calculate ${budget} calls`,()=>assert.equal(calculateSelectedRouteBudget(stops,policy).calculatedDynamicBudget,budget));
function fixture(t:TestContext,n=10,available=true,options:ConstructorParameters<typeof JourneyV2ApiService>[2]={}){
 const db=new RailwayDatabase(':memory:');t.after(()=>db.close());const codes=Array.from({length:n},(_,i)=>`S${i}`);
 db.replace({stations:codes.map(code=>({code,name:code})),trains:[{number:'15565',name:'Test',sourceCode:codes[0],destinationCode:codes.at(-1)!,runningDaysRaw:'Daily',runningDays:['MON','TUE','WED','THU','FRI','SAT','SUN']}],stops:codes.map((stationCode,i)=>{const m=360+i*10,time=`${String(Math.floor(m/60)%24).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;return {trainNumber:'15565',stationCode,sequence:i+1,dayOffset:Math.floor(m/1440),arrivalTime:i?time:undefined,departureTime:i<n-1?time:undefined,distanceKm:i*100};}),metadata:{source:'RAILPULL_NTES',importedAt:'2099-09-01T00:00:00Z',trainCount:1,stationCount:n,stopCount:n}});
 const calls:AvailabilityRequest[]=[],cache=new Map<string,AvailabilityResult>();
 const service=new JourneyV2ApiService(db,{getCachedAvailability:async r=>cache.get(JSON.stringify(r)),getAvailability:async r=>{calls.push(r);return {request:r,provider:'railkit',providerState:'SUCCESS',days:[{date:r.journeyDate,state:available?'AVAILABLE':'WAITLIST'}]};}},{diagnostics:true,selectedRouteBudgetPolicy:policy,...options});
 const input={from:codes[0],to:codes.at(-1)!,date,classes:['SL']};
 const check=async()=>{const route=(await service.search(input)).results[0];return service.checkAvailability({...input,routeId:route.id});};
 return {db,codes,calls,cache,service,input,check};
}
for(const [stops,budget] of [[10,80],[30,200],[50,320],[70,440],[150,500]])test(`${stops}-stop effective allowance is ${budget} and full coverage stops at one call`,async t=>{
 const h=fixture(t,stops);await h.service.search(h.input);assert.equal(h.calls.length,0);
 const d=(await h.check()).diagnostics!.selectedRoute!;
 assert.equal(d.traversedScheduledStopCount,stops);assert.equal(d.dynamicBudgetBase,20);assert.equal(d.callsPerStop,6);assert.equal(d.calculatedDynamicBudget,budget);assert.equal(d.configuredMaximumBudget,500);assert.equal(d.configuredGlobalProviderCallLimit,500);assert.equal(d.effectiveProviderCallLimit,budget);assert.equal(d.newProviderCallsUsed,1);assert.equal(d.budgetRemaining,budget-1);assert.equal(d.finalSearchStopReason,'FULL_COVERAGE_FOUND');
});
test('partial train journey counts only selected stops and multi-leg sums traversed stops once per leg',async t=>{
 const h=fixture(t,30);h.input.from='S10';h.input.to='S19';
 const candidate=new LocalJourneyPlannerV2(h.db,{},true).search(h.input).journeys[0];
 assert.equal(traversedScheduledStopCount(h.db,candidate),10);
 const other=new LocalJourneyPlannerV2(h.db,{},true).search({...h.input,from:'S19',to:'S29'}).journeys[0];
 const total=traversedScheduledStopCount(h.db,{segments:[...candidate.segments,...other.segments]});
 assert.equal(total,21);assert.equal(calculateSelectedRouteBudget(total,policy).selectedLimit,146);
 const d=(await h.check()).diagnostics!.selectedRoute!;assert.equal(d.traversedScheduledStopCount,10);assert.equal(d.effectiveProviderCallLimit,80);
});
test('explicit 40 override remains enforced and stricter global ceiling wins',async t=>{
 const h=fixture(t,30,false,{selectedRouteProviderCallBudgetLimit:40});const d=(await h.check()).diagnostics!.selectedRoute!;
 assert.equal(d.calculatedDynamicBudget,200);assert.equal(d.explicitBudgetOverride,40);assert.equal(h.calls.length,40);assert.equal(d.finalSearchStopReason,'SELECTED_ROUTE_BUDGET_EXHAUSTED');
 const g=fixture(t,30,false,{providerCallBudgetLimit:3});const gd=(await g.check()).diagnostics!.selectedRoute!;assert.equal(g.calls.length,3);assert.equal(gd.finalSearchStopReason,'GLOBAL_PROVIDER_LIMIT_REACHED');
});
test('exhausted scope with unaged negative evidence stops without spending remaining dynamic budget',async t=>{
 const h=fixture(t,2,false);const d=(await h.check()).diagnostics!.selectedRoute!;assert.equal(h.calls.length,1);assert.equal(d.effectiveProviderCallLimit,60);assert.equal(d.budgetRemaining,59);assert.equal(d.finalSearchStopReason,'SEARCH_EXHAUSTED');assert.equal(d.negativeRefreshAttempts,0);
});
test('cache-only evidence costs zero new calls under dynamic policy',async t=>{
 const h=fixture(t);const request={trainNumber:'15565',fromStationCode:'S0',toStationCode:'S9',journeyDate:date,travelClass:'SL',quota:'GN' as const};
 h.cache.set(JSON.stringify(request),{request,provider:'railkit',providerState:'SUCCESS',days:[{date,state:'AVAILABLE'}]});
 // Whole-leg lookup also uses the provider gateway in production. Inject free reuse there.
 const service=new JourneyV2ApiService(h.db,{providerCallAccounting:'SCOPED',getAvailability:async()=>h.cache.get(JSON.stringify(request))!,getCachedAvailability:async()=>h.cache.get(JSON.stringify(request))!},{diagnostics:true,selectedRouteBudgetPolicy:policy});
 const route=(await service.search(h.input)).results[0];const d=(await service.checkAvailability({...h.input,routeId:route.id})).diagnostics!.selectedRoute!;
 assert.equal(d.newProviderCallsUsed,0);assert.equal(d.budgetRemaining,80);assert.equal(d.finalSearchStopReason,'FULL_COVERAGE_FOUND');
});
test('policy configuration validates bounds and preserves optional benchmark override',()=>{
 assert.equal(hardeningConfig({}).selectedRouteProviderCallBudgetLimit,undefined);
 assert.equal(hardeningConfig({SELECTED_ROUTE_AVAILABILITY_PROVIDER_CALL_LIMIT:'40'}).selectedRouteProviderCallBudgetLimit,40);
 const p=selectedRouteBudgetPolicy({SELECTED_ROUTE_PROVIDER_CALL_BASE:'10',SELECTED_ROUTE_PROVIDER_CALLS_PER_STOP:'3',SELECTED_ROUTE_PROVIDER_CALL_MIN:'20',SELECTED_ROUTE_PROVIDER_CALL_MAX:'100'});
 assert.equal(calculateSelectedRouteBudget(10,p).selectedLimit,40);assert.equal(calculateSelectedRouteBudget(70,p,200).selectedLimit,100);
 for(const key of ['SELECTED_ROUTE_PROVIDER_CALL_BASE','SELECTED_ROUTE_PROVIDER_CALLS_PER_STOP','SELECTED_ROUTE_PROVIDER_CALL_MIN','SELECTED_ROUTE_PROVIDER_CALL_MAX'])for(const value of ['0','-1','NaN','Infinity','1.5','501'])assert.throws(()=>selectedRouteBudgetPolicy({[key]:value}));
 assert.throws(()=>selectedRouteBudgetPolicy({SELECTED_ROUTE_PROVIDER_CALL_MIN:'100',SELECTED_ROUTE_PROVIDER_CALL_MAX:'60'}));
 for(const value of [0,-1,1.5,501,Infinity])assert.throws(()=>calculateSelectedRouteBudget(10,policy,value));
});
