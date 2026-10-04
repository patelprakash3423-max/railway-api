import type {RailwayDatabase} from '../../local-railway/database.js';
import type {V2Journey} from '../../local-railway/planner/v2/types.js';
import {networkFor,eventMinute} from '../../local-railway/planner/v2/network.js';
import {parseDate} from '../connection/timing.js';
/** Count both endpoints of each traversed leg; a transfer belongs to each train.
 * Match scheduled timestamps as well as codes to disambiguate repeated stations. */
export function traversedScheduledStopCount(db:RailwayDatabase,journey:Pick<V2Journey,'segments'>):number {
 const net=networkFor(db);
 return journey.segments.reduce((sum,leg)=>{
  const route=net.routes.get(leg.trainNumber)??[],origin=parseDate(leg.originDate);
  const wall=(iso:string)=>Date.parse(iso)/60000+330;
  const starts=route.map((s,i)=>({s,i})).filter(({s})=>s.stationCode===leg.fromStation&&origin+eventMinute(s,false)===wall(leg.departureDateTime));
  const ends=route.map((s,i)=>({s,i})).filter(({s})=>s.stationCode===leg.toStation&&origin+eventMinute(s,true)===wall(leg.arrivalDateTime));
  const matches=starts.flatMap(a=>ends.filter(b=>b.i>a.i).map(b=>b.i-a.i+1));
  if(matches.length!==1)throw Error('Selected leg does not match one scheduled stop range');
  return sum+matches[0];
 },0);
}
