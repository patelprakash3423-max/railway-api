import type {AvailabilityStateConfig} from '../../config/availability-state.js';
import {availabilityStateConfig} from '../../config/availability-state.js';
import {journeyMidnight} from './model.js';
export class AvailabilityFreshnessPolicy {
 constructor(private readonly ttl:AvailabilityStateConfig['freshnessMs']=availabilityStateConfig({}).freshnessMs){
  if(Object.values(ttl).some(n=>!Number.isSafeInteger(n)||n<1||n>86400000))throw Error('Invalid availability freshness policy');
 }
 maximumAge(journeyDate:string,now:number):number {
  const days=(journeyMidnight(journeyDate)-now)/86400000;
  return days>30?this.ttl.over30:days>15?this.ttl.over15:days>7?this.ttl.over7:days>=2?this.ttl.over2:this.ttl.near;
 }
 freshUntil(journeyDate:string,observedAt:number,now:number):number {
  if(!Number.isSafeInteger(now)||!Number.isSafeInteger(observedAt)||observedAt<0||observedAt>now)return 0;
  const midnight=journeyMidnight(journeyDate);
  // Crossing into a shorter band must expire hydrated hot/session evidence too.
  let until=observedAt+this.maximumAge(journeyDate,now);
  for(const [days,ttl]of [[30,this.ttl.over15],[15,this.ttl.over7],[7,this.ttl.over2],[2,this.ttl.near]] as const){const boundary=midnight-days*86400000+(days===2?1:0);if(boundary>now)until=Math.min(until,Math.max(boundary,observedAt+ttl));}
  // Same-day booking remains eligible until the end of that Indian calendar day.
  return Math.min(until,midnight+86400000);
 }
 isFresh(journeyDate:string,observedAt:number,now:number){return now<this.freshUntil(journeyDate,observedAt,now);}
}
