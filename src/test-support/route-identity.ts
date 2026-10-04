import {createHash} from 'node:crypto';
import {LocalJourneyPlannerV2} from '../local-railway/planner/v2/planner.js';
import type {RailwayDatabase} from '../local-railway/database.js';
export function fixtureRouteId(db:RailwayDatabase,input:{from:string;to:string;date:string}){
 const j=new LocalJourneyPlannerV2(db,{},true).search(input).journeys[0];
 return createHash('sha256').update(JSON.stringify(j.segments.map(l=>[l.trainNumber,l.fromStation,l.toStation,l.departureDateTime,l.arrivalDateTime]))).digest('hex');
}
