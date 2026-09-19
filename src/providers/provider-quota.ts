import {PublicError} from '../application/errors.js';
import type {HardeningConfig} from '../config/hardening.js';
/** Synchronous check-and-charge: no await can race the single-process limit. */
export class ProviderQuota {
 private month=''; private used=0; private calls:number[]=[];
 constructor(private readonly config:HardeningConfig,private readonly now=Date.now){}
 snapshot(){
  const time=this.now(),month=new Date(time).toISOString().slice(0,7);
  if(month!==this.month){this.month=month;this.used=0;}
  this.calls=this.calls.filter(t=>t>time-this.config.burstWindowMs);
  return {monthlyUsed:this.used,burstUsed:this.calls.length,reservedProviderCalls:0};
 }
 consume(){
  const s=this.snapshot();
  if(s.monthlyUsed>=this.config.monthly||s.burstUsed>=this.config.burst)
   throw new PublicError('RATE_LIMITED','Availability provider capacity is temporarily unavailable.',429);
  this.used++;this.calls.push(this.now());
 }
}
