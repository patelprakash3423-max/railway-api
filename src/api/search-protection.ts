import {PublicError} from '../application/errors.js';
import type {HardeningConfig} from '../config/hardening.js';
const denied=()=>new PublicError('RATE_LIMITED','Search capacity is temporarily unavailable. Please try again later.',429);
/** Single-process beta limiter. Untrusted proxy headers are never identities. */
export class SearchProtection {
 private clients=new Map<string,{started:number[];active:number}>();
 private active=0;
 private month='';private monthlyUsed=0;
 private calls:number[]=[];private reserved=0;
 constructor(private readonly config:HardeningConfig,private readonly now:()=>number=Date.now){}
 acquire(client:string,maxCalls:number){
  const now=this.now(),month=new Date(now).toISOString().slice(0,7),c=this.config;
  if(this.month!==month){this.month=month;this.monthlyUsed=0;}
  this.calls=this.calls.filter(t=>t>now-c.burstWindowMs);
  for(const [key,state]of this.clients){state.started=state.started.filter(t=>t>now-c.rateWindowMs);if(!state.active&&!state.started.length)this.clients.delete(key);}
  const state=this.clients.get(client)??{started:[],active:0};
  if(state.started.length>=c.rateMax||state.active>=c.perClient||this.active>=c.global)throw denied();
  if(this.monthlyUsed+this.reserved+maxCalls>c.monthly||this.calls.length+this.reserved+maxCalls>c.burst)throw denied();
  // Bound identity memory even if deployed directly with many distinct peers.
  if(!this.clients.has(client)&&this.clients.size>=10000)throw denied();
  state.started.push(now);state.active++;this.clients.set(client,state);this.active++;this.reserved+=maxCalls;
  let remaining=maxCalls,released=false;
  return {
   consume:()=>{if(released||remaining<1)throw denied();const time=this.now(),currentMonth=new Date(time).toISOString().slice(0,7);if(currentMonth!==this.month){this.month=currentMonth;this.monthlyUsed=0;}remaining--;this.reserved--;this.monthlyUsed++;this.calls.push(time);},
   release:()=>{if(released)return;released=true;this.reserved-=remaining;remaining=0;this.active--;state.active--;}
  };
 }
}
export function clientIdentity(remoteAddress:string|undefined,forwarded:unknown):string {
 // Render's proxy chain is not authenticated by this plain HTTP listener.
 // Any forwarded request shares one conservative bucket; spoofing XFF cannot
 // create additional identities. Direct deployments use the socket peer.
 return forwarded!==undefined?'proxy-clients':remoteAddress??'unknown-client';
}
