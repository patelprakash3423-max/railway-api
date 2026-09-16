export interface HardeningConfig {
 rateMax:number;rateWindowMs:number;perClient:number;global:number;
 monthly:number;burst:number;burstWindowMs:number;providerTimeoutMs:number;searchTimeoutMs:number;horizonDays:number;
}
export function hardeningConfig(env:NodeJS.ProcessEnv=process.env):HardeningConfig {
 const integer=(key:string,fallback:number)=>{const raw=env[key]?.trim();const n=raw?Number(raw):fallback;if(!Number.isSafeInteger(n)||n<1)throw Error(`Invalid ${key}`);return n;};
 return {rateMax:integer('SEARCH_RATE_LIMIT_MAX',5),rateWindowMs:integer('SEARCH_RATE_LIMIT_WINDOW_MS',600000),perClient:integer('SEARCH_MAX_CONCURRENT_PER_CLIENT',1),global:integer('SEARCH_MAX_CONCURRENT_GLOBAL',3),monthly:integer('RAILKIT_MONTHLY_REQUEST_LIMIT',10000),burst:integer('RAILKIT_BURST_REQUEST_LIMIT',120),burstWindowMs:integer('RAILKIT_BURST_WINDOW_MINUTES',10)*60000,providerTimeoutMs:integer('RAILKIT_REQUEST_TIMEOUT_MS',15000),searchTimeoutMs:integer('JOURNEY_SEARCH_TIMEOUT_MS',90000),horizonDays:integer('MAX_BOOKING_HORIZON_DAYS',60)};
}
