import {PublicError} from '../application/errors.js';
import type {HardeningConfig} from '../config/hardening.js';
import {ProviderQuota} from '../providers/provider-quota.js';
import {isAnonymousClient} from './client-identity.js';
export {clientIdentity} from './client-identity.js';
const denied=()=>new PublicError('RATE_LIMITED','Search capacity is temporarily unavailable. Please try again later.',429);
export class AdmissionError extends PublicError {
 constructor(readonly failureCategory:string,readonly counters:Record<string,number>){
  super('RATE_LIMITED','Search capacity is temporarily unavailable. Please try again later.',429);
 }
}
/** Search admission is independent of actual provider quota. */
export class SearchProtection {
 private clients=new Map<string,{started:number[];active:number}>();
 private active=0;
 private readonly quota:ProviderQuota;
 constructor(private readonly config:HardeningConfig,private readonly now:()=>number=Date.now,quota?:ProviderQuota){this.quota=quota??new ProviderQuota(config,now);}
 snapshot(client:string):Record<string,number>{
  const now=this.now(),state=this.clients.get(client),c=this.config;
  return {clientSearches:state?.started.filter(t=>t>now-c.rateWindowMs).length??0,clientActive:state?.active??0,globalActive:this.active,
   ...this.quota.snapshot(),rateMax:c.rateMax,rateWindowMs:c.rateWindowMs,perClientLimit:c.perClient,globalLimit:c.global,monthlyLimit:c.monthly,burstLimit:c.burst,burstWindowMs:c.burstWindowMs};
 }
 acquire(client:string,maxCalls:number){
  const now=this.now(),c=this.config;
  const unidentified=isAnonymousClient(client);
  for(const [key,state]of this.clients){state.started=state.started.filter(t=>t>now-c.rateWindowMs);if(!state.active&&!state.started.length)this.clients.delete(key);}
  const state=this.clients.get(client)??{started:[],active:0};
  const reject=(category:string):never=>{throw new AdmissionError(category,{...this.snapshot(client),requestedReservation:0});};
  // Unauthenticated forwarded traffic cannot support a per-user restriction.
  // Its global concurrency and actual provider quota still apply, even to forged XFF.
  if(!unidentified&&state.started.length>=c.rateMax)reject('CLIENT_SEARCH_RATE');
  if(!unidentified&&state.active>=c.perClient)reject('CLIENT_CONCURRENCY');
  if(this.active>=c.global)reject('GLOBAL_CONCURRENCY');
  if(!unidentified&&!this.clients.has(client)&&this.clients.size>=10000)reject('CLIENT_CAPACITY');
  // Anonymous requests never enter a shared per-client bucket.
  if(!unidentified){state.started.push(now);state.active++;this.clients.set(client,state);}
  this.active++;
  let remaining=maxCalls,released=false;
  return {
   // Compatibility for injected providers without an SDK boundary.
   consume:()=>{if(released||remaining<1)throw denied();this.quota.consume();remaining--;},
   release:()=>{if(released)return;released=true;remaining=0;this.active--;if(!unidentified)state.active--;}
  };
 }
}
