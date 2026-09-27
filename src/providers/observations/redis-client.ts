import {createClient} from 'redis';
import {availabilityRedisConfig,type AvailabilityRedisConfig} from '../../config/availability-redis.js';
import {RedisAvailabilityCache,type AvailabilityRedisAdapter} from './redis-cache.js';

// Atomic latest-write protection; equal timestamps keep the existing observation.
// PXAT (Redis >=6.2) keeps expiration anchored even when a command arrives late.
export const putLatestObservationScript=`
local previous = redis.call('GET', KEYS[1])
if previous then
 local ok, value = pcall(cjson.decode, previous)
 if ok and type(value) == 'table' and type(value.observedAt) == 'number' and value.observedAt >= tonumber(ARGV[2]) then
  return 0
 end
end
redis.call('SET', KEYS[1], ARGV[1], 'PXAT', ARGV[3])
return 1`;

type Client=ReturnType<typeof createClient>;
/** Lazy, no offline queue/reconnect loop; demand retries only after a cooldown. */
export class NodeRedisAvailabilityAdapter implements AvailabilityRedisAdapter {
 private client?:Client;
 private connecting?:Promise<unknown>;
 private retryAt=0;
 private closed=false;
 constructor(private readonly config:AvailabilityRedisConfig,private readonly now=Date.now,private readonly factory=createClient){}
 private discard(client:Client){
  if(this.client===client){this.client=undefined;this.connecting=undefined;this.retryAt=this.now()+this.config.retryCooldownMs;}
  if(client.isOpen)client.destroy();
 }
 private async run<T>(signal:AbortSignal,work:(client:Client)=>Promise<T>):Promise<T>{
  signal.throwIfAborted();
  if(this.closed||this.now()<this.retryAt)throw Error('Redis unavailable');
  if(!this.client){
   const client=this.factory({url:this.config.url,disableOfflineQueue:true,commandsQueueMaxLength:64,
    socket:{connectTimeout:this.config.operationTimeoutMs,reconnectStrategy:false}});
   // Always consume error events without logging connection strings or payloads.
   client.on('error',()=>{});this.client=client;
   this.connecting=client.connect();
  }
  const client=this.client,abort=()=>this.discard(client);
  signal.addEventListener('abort',abort,{once:true});
  try{
   await this.connecting;signal.throwIfAborted();
   if(!client.isReady)throw Error('Redis unavailable');
   return await work(client);
  }catch{this.discard(client);throw Error('Redis unavailable');}
  finally{signal.removeEventListener('abort',abort);}
 }
 get(key:string,signal:AbortSignal){return this.run(signal,client=>client.get(key));}
 async putIfNewer(key:string,value:string,observedAt:number,expiresAt:number,signal:AbortSignal){
  await this.run(signal,client=>client.eval(putLatestObservationScript,{keys:[key],arguments:[value,String(observedAt),String(expiresAt)]}));
 }
 close(){this.closed=true;if(this.client)this.discard(this.client);}
}
export function configuredRedisAvailabilityCache(config=availabilityRedisConfig()){
 return config.enabled?new RedisAvailabilityCache(new NodeRedisAvailabilityAdapter(config),config.operationTimeoutMs):undefined;
}
