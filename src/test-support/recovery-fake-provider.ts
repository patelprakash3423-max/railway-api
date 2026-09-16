import type { AvailabilityRequest,AvailabilityResult } from '../domain/types/availability.js';
import type { RailwayDatabase } from '../local-railway/database.js';
import { networkFor } from '../local-railway/planner/v2/network.js';
import type { RecoveryInput } from '../journey/availability/recovery/types.js';
/** Synthetic inventory rules for exercising local real timetables, NOT live seats. */
export class FakeRecoveryProvider {
  readonly calls:AvailabilityRequest[]=[];discoveryCalls=0;infoCalls=0;
  private readonly distances:Map<string,number>;
  constructor(database:RailwayDatabase,private readonly input:RecoveryInput,private readonly scenario:'SPLIT'|'PARTIAL'){
    this.distances=new Map(networkFor(database).routes.get(input.trainNumber)!.filter(s=>s.distanceKm!==undefined).map(s=>[s.stationCode,s.distanceKm!]));
  }
  async getTrainInfo():Promise<never>{this.infoCalls++;throw new Error('Train info forbidden');}
  async searchTrainsBetweenStations():Promise<never>{this.discoveryCalls++;throw new Error('Discovery forbidden');}
  async getAvailability(r:AvailabilityRequest):Promise<AvailabilityResult>{
    this.calls.push({...r});let state:'AVAILABLE'|'RAC'|'WAITLIST'='WAITLIST';
    if(this.scenario==='SPLIT'){
      if(r.fromStationCode===this.input.fromStation&&r.toStationCode!==this.input.toStation&&r.travelClass==='SL')state='AVAILABLE';
      if(r.fromStationCode!==this.input.fromStation&&r.toStationCode===this.input.toStation&&r.travelClass==='3A')state='RAC';
    }else if(r.fromStationCode===this.input.fromStation&&r.toStationCode!==this.input.toStation&&r.travelClass==='SL'&&this.distances.get(r.toStationCode)!-this.distances.get(r.fromStationCode)!>=this.input.distanceKm*.5)state='AVAILABLE';
    return{request:{...r},provider:'railkit',providerState:'SUCCESS',days:[{date:r.journeyDate,state,availabilityText:`FAKE ${state}`}],fare:state==='WAITLIST'?undefined:{currency:'INR',totalFare:Math.round((this.distances.get(r.toStationCode)!-this.distances.get(r.fromStationCode)!)*2)}};
  }
}
