export type ClientIdentityMode='ANONYMOUS'|'DIRECT_PEER';
export interface HardeningConfig {
 clientIdentityMode:ClientIdentityMode;
 providerConcurrency:number;providerCacheTtlMs:number;providerCacheEntries:number;
 rateMax:number;rateWindowMs:number;perClient:number;global:number;
 monthly:number;burst:number;burstWindowMs:number;providerTimeoutMs:number;searchTimeoutMs:number;horizonDays:number;
}
export function hardeningConfig(env:NodeJS.ProcessEnv=process.env):HardeningConfig {
 const integer=(key:string,fallback:number)=>{const raw=env[key]?.trim();const n=raw?Number(raw):fallback;if(!Number.isSafeInteger(n)||n<1)throw Error(`Invalid ${key}`);return n;};
 const clientIdentityMode=env.SEARCH_CLIENT_IDENTITY_MODE?.trim()||'ANONYMOUS';
 if(clientIdentityMode!=='ANONYMOUS'&&clientIdentityMode!=='DIRECT_PEER')throw Error('Invalid SEARCH_CLIENT_IDENTITY_MODE');
 return {clientIdentityMode,providerConcurrency:integer('RAILKIT_AVAILABILITY_MAX_CONCURRENT',2),providerCacheTtlMs:integer('RAILKIT_AVAILABILITY_CACHE_TTL_MS',15000),providerCacheEntries:integer('RAILKIT_AVAILABILITY_CACHE_MAX_ENTRIES',500),rateMax:integer('SEARCH_RATE_LIMIT_MAX',5),rateWindowMs:integer('SEARCH_RATE_LIMIT_WINDOW_MS',600000),perClient:integer('SEARCH_MAX_CONCURRENT_PER_CLIENT',1),global:integer('SEARCH_MAX_CONCURRENT_GLOBAL',3),monthly:integer('RAILKIT_MONTHLY_REQUEST_LIMIT',10000),burst:integer('RAILKIT_BURST_REQUEST_LIMIT',120),burstWindowMs:integer('RAILKIT_BURST_WINDOW_MINUTES',10)*60000,providerTimeoutMs:integer('RAILKIT_REQUEST_TIMEOUT_MS',15000),searchTimeoutMs:integer('JOURNEY_SEARCH_TIMEOUT_MS',90000),horizonDays:integer('MAX_BOOKING_HORIZON_DAYS',60)};
}
