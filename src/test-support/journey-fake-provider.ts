import type { RailwayDatabase } from '../local-railway/database.js';
import { networkFor } from '../local-railway/planner/v2/network.js';
import type { V2Journey } from '../local-railway/planner/v2/types.js';
import type { AvailabilityRequest, AvailabilityResult } from '../domain/types/availability.js';
/** Schedule-derived synthetic inventory, never a claim about actual seats/classes. */
export class FakeJourneyProvider {
  readonly calls: AvailabilityRequest[]=[];
  discoveryCalls=0; infoCalls=0;
  readonly supportedClassesByTrain: Record<string,string[]>={};
  private readonly rules: {train:string;from:string;to:string;kind:'NORMAL'|'SPLIT'|'PARTIAL';distance:number}[]=[];
  private readonly distances: Map<string,Map<string,number>>;
  constructor(database:RailwayDatabase,candidates: readonly V2Journey[]){
    this.distances=new Map([...networkFor(database).routes].map(([train,stops])=>[train,new Map(stops.filter(s=>s.distanceKm!==undefined).map(s=>[s.stationCode,s.distanceKm!]))]));
    for(const j of candidates)for(const l of j.segments)this.supportedClassesByTrain[l.trainNumber]=['SL','3A'];
    const pune=candidates[0]?.to==='PUNE';
    const selected=pune?candidates.filter(j=>j.changes>0).slice(0,1):candidates.slice(0,3);
    selected.forEach((j,index)=>{
      const longest=[...j.segments].sort((a,b)=>b.distanceKm-a.distanceKm)[0];
      for(const l of j.segments)this.rules.push({train:l.trainNumber,from:l.fromStation,to:l.toStation,distance:l.distanceKm,kind:pune?(l===longest?'SPLIT':'NORMAL'):index===0?'NORMAL':index===1?'SPLIT':'PARTIAL'});
    });
  }
  async searchTrainsBetweenStations():Promise<never>{this.discoveryCalls++;throw Error('Discovery forbidden');}
  async getTrainInfo():Promise<never>{this.infoCalls++;throw Error('Train info forbidden');}
  async getAvailability(r:AvailabilityRequest):Promise<AvailabilityResult>{
    this.calls.push({...r});let state:'AVAILABLE'|'RAC'|'WAITLIST'='WAITLIST';
    const km=this.distances.get(r.trainNumber),distance=(km?.get(r.toStationCode)??0)-(km?.get(r.fromStationCode)??0);
    for(const rule of this.rules.filter(x=>x.train===r.trainNumber)){
      if(rule.kind==='NORMAL'&&r.fromStationCode===rule.from&&r.toStationCode===rule.to&&r.travelClass==='SL')state='AVAILABLE';
      if(rule.kind!=='NORMAL'&&r.fromStationCode===rule.from&&r.toStationCode!==rule.to&&r.travelClass==='SL'&&(rule.kind==='SPLIT'||distance>=rule.distance*.5))state='AVAILABLE';
      if(rule.kind==='SPLIT'&&r.fromStationCode!==rule.from&&r.toStationCode===rule.to&&r.travelClass==='3A')state='RAC';
    }
    return {request:r,provider:'railkit',providerState:'SUCCESS',days:[{date:r.journeyDate,state,availabilityText:`FAKE ${state}`}],fare:state==='WAITLIST'?undefined:{currency:'INR',totalFare:Math.max(1,Math.round(distance))}};
  }
}
