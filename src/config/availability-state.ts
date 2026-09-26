export interface AvailabilityStateConfig {
 path:string;maxRows:number;retentionMs:number;busyTimeoutMs:number;
 freshnessMs:{over30:number;over15:number;over7:number;over2:number;near:number};
}
export function availabilityStateConfig(env:NodeJS.ProcessEnv=process.env):AvailabilityStateConfig {
 const integer=(name:string,fallback:number,max:number)=>{const raw=env[name]?.trim(),n=raw?Number(raw):fallback;if(!Number.isSafeInteger(n)||n<1||n>max)throw Error('Invalid '+name);return n;};
 return {path:env.AVAILABILITY_STATE_DB_PATH?.trim()||'data/availability-state/observations.sqlite',
  maxRows:integer('AVAILABILITY_STATE_MAX_ROWS',100000,1000000),retentionMs:integer('AVAILABILITY_STATE_RETENTION_MS',7*86400000,90*86400000),busyTimeoutMs:integer('AVAILABILITY_STATE_BUSY_TIMEOUT_MS',25,1000),
  freshnessMs:{over30:integer('AVAILABILITY_FRESHNESS_OVER_30_DAYS_MS',43200000,86400000),over15:integer('AVAILABILITY_FRESHNESS_OVER_15_DAYS_MS',21600000,86400000),over7:integer('AVAILABILITY_FRESHNESS_OVER_7_DAYS_MS',10800000,86400000),over2:integer('AVAILABILITY_FRESHNESS_OVER_2_DAYS_MS',3600000,86400000),near:integer('AVAILABILITY_FRESHNESS_NEAR_MS',1800000,86400000)}};
}
