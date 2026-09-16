export interface ConnectionSearchBudgetConfig {
  maxTrainDiscoveryCalls: number;
  maxTrainInfoCalls: number;
  maxAvailabilityCalls: number;
  maxConnectionStations: number;
  maxTrainsPerLeg: number;
  maxTrainPairsPerConnection: number;
  maxResults: number;
}
export const defaultConnectionBudget: Readonly<ConnectionSearchBudgetConfig> = Object.freeze({
  maxTrainDiscoveryCalls: 8, maxTrainInfoCalls: 8, maxAvailabilityCalls: 30,
  maxConnectionStations: 3, maxTrainsPerLeg: 4, maxTrainPairsPerConnection: 6, maxResults: 5,
});
export type CallKind = 'discovery' | 'info' | 'availability';
export class ConnectionBudget {
  readonly config: Readonly<ConnectionSearchBudgetConfig>;
  readonly used = { discovery: 0, info: 0, availability: 0 };
  constructor(input: Partial<ConnectionSearchBudgetConfig> = {}) {
    this.config = Object.freeze({ ...defaultConnectionBudget, ...input });
    if (Object.values(this.config).some((n) => !Number.isSafeInteger(n) || n < 0)) throw new Error('Connection budgets must be nonnegative safe integers.');
  }
  canCall(kind: CallKind): boolean {
    const limits = { discovery: this.config.maxTrainDiscoveryCalls, info: this.config.maxTrainInfoCalls, availability: this.config.maxAvailabilityCalls };
    return this.used[kind] < limits[kind];
  }
  consume(kind: CallKind): void {
    if (!this.canCall(kind)) throw new Error(`${kind} budget exhausted.`);
    this.used[kind] += 1;
  }
}
export interface ConnectionSearchPolicy {
  providerUnavailableThreshold: number;
  directOptionsPerTrain: number;
  strongDirectSkipThreshold: number;
  strongDirectReduceThreshold: number;
  directAvailabilityBudgetFraction: number;
  maxAvailabilityCallsPerConnectionStation: number;
  directAvailableWideningTarget: number;
  broadenDirectClassAlternatives: boolean;
}
export const defaultConnectionPolicy: Readonly<ConnectionSearchPolicy> = Object.freeze({
  providerUnavailableThreshold: 3, directOptionsPerTrain: 2,
  strongDirectSkipThreshold: 3, strongDirectReduceThreshold: 2,
  directAvailabilityBudgetFraction: 0.4, maxAvailabilityCallsPerConnectionStation: 6,
  directAvailableWideningTarget: 1, broadenDirectClassAlternatives: false,
});
export function connectionPolicy(input: Partial<ConnectionSearchPolicy> = {}): ConnectionSearchPolicy {
  const policy = { ...defaultConnectionPolicy, ...input };
  if ([policy.providerUnavailableThreshold, policy.directOptionsPerTrain, policy.strongDirectSkipThreshold, policy.strongDirectReduceThreshold, policy.maxAvailabilityCallsPerConnectionStation, policy.directAvailableWideningTarget].some((n) => !Number.isSafeInteger(n) || n < 1)) throw new Error('Policy thresholds must be positive integers.');
  if (!Number.isFinite(policy.directAvailabilityBudgetFraction) || policy.directAvailabilityBudgetFraction <= 0 || policy.directAvailabilityBudgetFraction > 1) throw new Error('Direct budget fraction must be in (0, 1].');
  if (typeof policy.broadenDirectClassAlternatives !== 'boolean') throw new Error('Class widening preference must be boolean.');
  return policy;
}
export interface DirectSearchQuality { availableResults: number; racResults: number }
export function connectionStationLimit(quality: DirectSearchQuality, limit: number, policy: ConnectionSearchPolicy): number {
  if (quality.availableResults >= policy.strongDirectSkipThreshold) return 0;
  if (quality.availableResults >= policy.strongDirectReduceThreshold) return Math.min(1, limit);
  // RAC does not reduce fallback breadth: it is weaker than an AVAILABLE result.
  return quality.availableResults > 0 ? Math.min(2, limit) : limit;
}
export function directPhaseCallLimit(budget: Readonly<ConnectionSearchBudgetConfig>, policy: ConnectionSearchPolicy): number {
  const directOnly = budget.maxConnectionStations === 0 || budget.maxTrainPairsPerConnection === 0;
  return directOnly ? budget.maxAvailabilityCalls : Math.min(budget.maxAvailabilityCalls,
    Math.max(1, Math.floor(budget.maxAvailabilityCalls * policy.directAvailabilityBudgetFraction)));
}
