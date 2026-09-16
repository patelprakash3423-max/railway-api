import type { MultiTrainJourneyCandidate } from '../domain/planner/types.js';
import type { PublicMultiResult, PublicJourneySearchResponse } from './public-models.js';
export function serializeMulti(c:MultiTrainJourneyCandidate):PublicMultiResult {
 return { type:c.type,requestedFrom:{code:c.requestedFrom.code},requestedTo:{code:c.requestedTo.code},
 segments:c.segments.map(s=>({type:s.type,trainNumber:s.trainNumber,trainName:s.trainName,from:{code:s.from.code},to:{code:s.to.code},journeyDate:s.journeyDate,classCode:s.classCode,quota:s.quota,availability:s.availability,fare:s.fare})),
 reservedCoverage:{ratio:c.reservedCoverage.ratio,percentage:c.reservedCoverage.percentage,method:c.reservedCoverage.method},reservedSegmentCount:c.reservedSegmentCount,trainChangeCount:c.trainChangeCount,classChangeCount:c.classChangeCount,totalReservedFare:c.totalReservedFare,totalScheduledDurationMinutes:c.totalScheduledDurationMinutes,connectionCount:c.connectionCount,
 connections:c.connections.map(s=>({station:{code:s.station.code},minutes:s.minutes,safety:s.safety})),quality:c.quality,warnings:[...c.warnings],explanation:c.explanation };
}
export function rankPublicJourneys(results:PublicJourneySearchResponse['results']):PublicJourneySearchResponse['results'] {
 const score=(r:typeof results[number])=>{
  if(r.type==='JOURNEY_RECOVERY')return 1000*r.reservedCoverage.ratio**2+(r.segments.some(s=>s.type==='RESERVED_TRAIN'&&s.availability==='RAC')?120:200)-60*r.selfManagedSegmentCount;
  if(r.type==='MULTI_TRAIN_JOURNEY')return 1000+(r.segments.every(s=>s.availability==='AVAILABLE')?200:100)-180+r.connections.reduce((n,c)=>n+(c.safety==='GOOD'?40:c.safety==='TIGHT'?-40:10),0)-100*r.totalScheduledDurationMinutes/(1440+r.totalScheduledDurationMinutes);
  return 1000+(r.segments.every(s=>s.availabilityState==='AVAILABLE')?200:60)-(r.type==='DIFFERENT_TRAIN_CONNECTION'?80:0)+(r.connection?.safety==='GOOD'?40:r.connection?.safety==='TIGHT'?-40:0);
 };
 return results.map((r,i)=>({r,i})).sort((a,b)=>score(b.r)-score(a.r)||a.i-b.i).map(x=>x.r);
}
