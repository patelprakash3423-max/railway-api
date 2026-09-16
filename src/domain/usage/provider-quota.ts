export interface ProviderQuotaSnapshot {
  source: 'PROVIDER' | 'CONFIGURED_LIMIT'; monthlyLimit?: number; monthlyUsed?: number; monthlyRemaining?: number;
  burstWindowMinutes?: number; burstLimit?: number; observedAt?: string;
}
/** No account usage endpoint/headers are exposed by the current adapter. */
export function configuredProviderQuota(env: NodeJS.ProcessEnv): ProviderQuotaSnapshot | undefined {
  const read = (key: string) => {
    if (!env[key]) return undefined;
    const value = Number(env[key]); if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${key}`); return value;
  };
  const monthlyLimit = read('RAILKIT_MONTHLY_REQUEST_LIMIT'), burstLimit = read('RAILKIT_BURST_REQUEST_LIMIT'), burstWindowMinutes = read('RAILKIT_BURST_WINDOW_MINUTES');
  if (monthlyLimit === undefined && burstLimit === undefined && burstWindowMinutes === undefined) return undefined;
  return { source: 'CONFIGURED_LIMIT', monthlyLimit, burstLimit, burstWindowMinutes };
}
/** A configured plan can never assert live account usage. */
export function publicProviderQuota(p:ProviderQuotaSnapshot):ProviderQuotaSnapshot {
 return {source:p.source,monthlyLimit:p.monthlyLimit,burstLimit:p.burstLimit,burstWindowMinutes:p.burstWindowMinutes,
 ...(p.source==='PROVIDER'?{monthlyUsed:p.monthlyUsed,monthlyRemaining:p.monthlyRemaining,observedAt:p.observedAt}:{})};
}
