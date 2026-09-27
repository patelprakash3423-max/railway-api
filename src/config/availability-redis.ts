export interface AvailabilityRedisConfig {
 enabled:boolean;url?:string;operationTimeoutMs:number;retryCooldownMs:number;
}
export function availabilityRedisConfig(env:NodeJS.ProcessEnv=process.env):AvailabilityRedisConfig {
 const flag=env.REDIS_ENABLED?.trim()||'false';
 if(flag!=='true'&&flag!=='false')throw Error('Invalid REDIS_ENABLED');
 const integer=(key:string,fallback:number,max:number)=>{
  const raw=env[key]?.trim(),n=raw?Number(raw):fallback;
  if(!Number.isSafeInteger(n)||n<1||n>max)throw Error('Invalid '+key);
  return n;
 };
 const enabled=flag==='true',url=env.REDIS_URL?.trim();
 if(enabled){
  try{const parsed=new URL(url??'');if(!['redis:','rediss:'].includes(parsed.protocol)||!parsed.hostname)throw Error();}
  catch{throw Error('Invalid REDIS_URL');}
 }
 return {enabled,url,operationTimeoutMs:integer('REDIS_OPERATION_TIMEOUT_MS',150,1000),retryCooldownMs:integer('REDIS_RETRY_COOLDOWN_MS',1000,60000)};
}
