import {RailwayDatabase} from '../../local-railway/database.js';
import {LocalJourneyPlannerV2} from '../../local-railway/planner/v2/planner.js';
import {JourneyRecoveryOrchestrator,type JourneyOptions} from '../../journey/availability/journey/orchestrator.js';
import {AvailabilityScheduler} from '../../providers/railkit/availability-scheduler.js';
import {availabilityFailure,normalizeAvailability} from '../../providers/railkit/railkit-normalizers.js';
import {invokeAvailabilityProvider} from '../../providers/availability-provider-budget.js';
import {availabilitySdkInvoked} from '../../providers/availability-observation.js';
import {availabilitySignal,inAvailabilityScope} from '../../providers/railkit/availability-abort.js';
import {hardeningConfig} from '../../config/hardening.js';
import type {AvailabilityRequest} from '../../domain/types/availability.js';
import type {AvailabilityProvider} from '../../journey/availability/types.js';

export type FakeState='AVAILABLE'|'RAC'|'WAITLIST'|'UNSUPPORTED';
/** No SDK or network implementation: actual scheduler, quota and normalization. */
export function directConcurrencyFixture(options:{count?:number;classes?:string[];schedulerConcurrency?:number;
 rule?:(r:AvailabilityRequest)=>FakeState;wait?:(r:AvailabilityRequest,signal:AbortSignal)=>Promise<void>;signal?:AbortSignal}={}){
 const db=new RailwayDatabase(':memory:'),date='19-10-2099',codes=['A','X','B'];
 const trains=Array.from({length:options.count??4},(_,i)=>({number:String(43001+i),name:`Train ${i}`,sourceCode:'A',destinationCode:'B',runningDaysRaw:'Daily',runningDays:['MON','TUE','WED','THU','FRI','SAT','SUN'] as const}));
 const stops=trains.flatMap(t=>codes.map((stationCode,i)=>({trainNumber:t.number,stationCode,sequence:i+1,dayOffset:0,arrivalTime:i?['06:00','08:00','10:00'][i]:undefined,departureTime:i<2?['06:00','08:00','10:00'][i]:undefined,distanceKm:i*200})));
 db.replace({stations:codes.map(code=>({code,name:code})),trains:trains.map(t=>({...t,runningDays:[...t.runningDays]})),stops,metadata:{source:'RAILPULL_NTES',importedAt:'2099-09-01T00:00:00Z',trainCount:trains.length,stationCount:3,stopCount:stops.length}});
 const candidates=new LocalJourneyPlannerV2(db,{},true).search({from:'A',to:'B',date}).journeys;
 const scheduler=new AvailabilityScheduler({...hardeningConfig({}),providerConcurrency:options.schedulerConcurrency??2});
 const signal=options.signal??new AbortController().signal;
 const calls:AvailabilityRequest[]=[];let active=0,maxActive=0,maxRecoveryActive=0;
 const provider:AvailabilityProvider={providerCallAccounting:'SCOPED',assertActive:()=>signal.throwIfAborted(),
  getAvailability:async request=>{
   try{
    const raw=await inAvailabilityScope(signal,()=>scheduler.execute(request,()=>invokeAvailabilityProvider(()=>scheduler.quota.consume(),async()=>{
     availabilitySdkInvoked();calls.push({...request});active++;maxActive=Math.max(maxActive,active);
     if(request.fromStationCode!=='A'||request.toStationCode!=='B')maxRecoveryActive=Math.max(maxRecoveryActive,active);
     try{
      await options.wait?.(request,availabilitySignal()!);
      const state=options.rule?.(request)??'AVAILABLE';
      return state==='UNSUPPORTED'?{success:false,error:'Class does not exist in this train for this train route'}:{success:true,data:{availability:[{date:request.journeyDate,status:state}]}};
     }finally{active--;}
    })));
    return normalizeAvailability(raw,request);
   }catch(error){return availabilityFailure(request,error);}
  }};
 return {db,calls,scheduler,counts:()=>({active,maxActive,maxRecoveryActive}),
  run:(settings:JourneyOptions={})=>new JourneyRecoveryOrchestrator(db,provider,settings).validate({source:'A',destination:'B',journeyDate:date,requestedClasses:options.classes??['ALL'],mode:'STANDARD',plannerCandidates:candidates})};
}
