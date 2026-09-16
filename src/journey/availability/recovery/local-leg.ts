import type { RailwayDatabase } from '../../../local-railway/database.js';
import { networkFor,eventMinute } from '../../../local-railway/planner/v2/network.js';
import { stationCode } from '../../../local-railway/station-code.js';
import { parseDate } from '../../connection/timing.js';
import type { RecoveryInput } from './types.js';
const datetime=(m:number)=>new Date(m*60000).toISOString().slice(0,16)+':00+05:30';
/** CLI adapter: resolve exact schedule timestamps using only local stops. */
export function localRecoveryLeg(database:RailwayDatabase,number:string,from:string,to:string,date:string,requestedClasses:string[]):RecoveryInput{
  if(!/^\d{1,5}$/.test(number))throw new Error('Invalid train number');
  const trainNumber=number.padStart(5,'0'),source=stationCode(from),destination=stationCode(to),day=parseDate(date),route=networkFor(database).routes.get(trainNumber);
  if(!route)throw new Error('Train missing from local dataset');
  const found:RecoveryInput[]=[];
  for(const board of route)if(board.stationCode===source&&board.departureTime)for(const end of route)if(end.stationCode===destination&&end.sequence>board.sequence&&end.arrivalTime){
    if(board.distanceKm===undefined||end.distanceKm===undefined)throw new Error('Endpoint distances unknown');
    const origin=day-board.dayOffset*1440;
    found.push({trainNumber,fromStation:source,toStation:destination,boardingDateTime:datetime(origin+eventMinute(board,false)),arrivalDateTime:datetime(origin+eventMinute(end,true)),distanceKm:end.distanceKm-board.distanceKm,requestedClasses,quota:'GN'});
  }
  if(found.length!==1)throw new Error('Requested stations do not identify one local train leg');return found[0];
}
