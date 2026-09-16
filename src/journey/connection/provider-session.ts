import type { SearchBudgetOrchestrator, SearchStage } from '../../application/search-budget-orchestrator.js';
import type { RailwayProvider } from '../../providers/railway-provider.js';
import type { TrainSearchRequest, TrainSearchResult } from '../../domain/types/train-search.js';
import type { TrainDetails } from '../../domain/types/train.js';
import type { AvailabilityRequest, AvailabilityResult } from '../../domain/types/availability.js';
import { ConnectionBudget, type CallKind } from './budget.js';
import type { ConnectionSearchDiagnostics } from './types.js';
/** Serialized request-local provider gateway. No retries; failures are cached too. */
export class ConnectionProviderSession {
  private readonly discoveries = new Map<string, TrainSearchResult | null>();
  private readonly routes = new Map<string, TrainDetails | null>();
  private readonly seats = new Map<string, AvailabilityResult | null>();
  private readonly unsupported = new Map<string, Set<string>>();
  constructor(private readonly provider: RailwayProvider, readonly budget: ConnectionBudget,
    readonly diagnostics: ConnectionSearchDiagnostics, private readonly threshold: number, readonly orchestrator?: SearchBudgetOrchestrator) {}
  private failure(value: unknown): void {
    if (typeof value === 'object' && value !== null && 'providerState' in value && value.providerState === 'PROVIDER_UNAVAILABLE') this.diagnostics.providerUnavailableCount += 1;
    else this.diagnostics.providerErrorCount += 1;
  }
  private consume(kind: CallKind): boolean {
    if (!this.budget.canCall(kind)) return false;
    this.budget.consume(kind);
    this.diagnostics.totalExternalApiCalls += 1;
    if (kind === 'discovery') this.diagnostics.trainDiscoveryCalls += 1;
    if (kind === 'info') this.diagnostics.trainInfoCalls += 1;
    if (kind === 'availability') this.diagnostics.availabilityCalls += 1;
    return true;
  }
  async discover(request: TrainSearchRequest, limit = Infinity): Promise<TrainSearchResult | null> {
    const key = JSON.stringify([request.fromStationCode, request.toStationCode, request.journeyDate]);
    if (this.discoveries.has(key)) { this.diagnostics.trainDiscoveryCacheHits += 1; return this.discoveries.get(key) ?? null; }
    if (this.budget.used.discovery >= limit) return null;
    if (!this.consume('discovery')) return null;
    try {
      const result = await this.provider.searchTrainsBetweenStations({ ...request });
      this.discoveries.set(key, result);
      if (result.providerState !== 'SUCCESS') this.failure(result);
      return result;
    } catch (error: unknown) { this.failure(error); this.discoveries.set(key, null); return null; }
  }
  async info(trainNumber: string, limit = Infinity): Promise<TrainDetails | null> {
    if (this.routes.has(trainNumber)) { this.diagnostics.trainInfoCacheHits += 1; return this.routes.get(trainNumber) ?? null; }
    if (this.budget.used.info >= limit) return null;
    if (!this.consume('info')) return null;
    try {
      const result = await this.provider.getTrainInfo(trainNumber);
      if (result.trainNumber !== trainNumber) throw new Error('Mismatched train route.');
      this.routes.set(trainNumber, result);
      return result;
    } catch (error: unknown) { this.failure(error); this.routes.set(trainNumber, null); return null; }
  }
  private availabilityKey(request: AvailabilityRequest) { return JSON.stringify([request.trainNumber, request.fromStationCode, request.toStationCode, request.journeyDate, request.travelClass, request.quota]); }
  hasAvailability(request: AvailabilityRequest) { return this.seats.has(this.availabilityKey(request)); }
  estimatedUncachedAvailabilityCost(requests: AvailabilityRequest[]) { return new Set(requests.filter(r=>!this.hasAvailability(r)).map(r=>this.availabilityKey(r))).size; }
  canValidate(stage: SearchStage, requests: AvailabilityRequest[], additionalCost = 0, allowance = Infinity) {
    const cost = this.estimatedUncachedAvailabilityCost(requests) + additionalCost;
    const allowed = this.orchestrator ? this.orchestrator.canSpend(stage, cost, true) : cost <= this.budget.config.maxAvailabilityCalls - this.budget.used.availability;
    if (!allowed) return false;
    if (cost > allowance) { if (this.orchestrator) this.orchestrator.preventedByAtomicCost++; return false; }
    return true;
  }
  async availability(request: AvailabilityRequest, direct = false, scope?: { directLimit: number; stationCode?: string; stationLimit: number; recoveryLimit?: number; multiLimit?: number }): Promise<AvailabilityResult | null> {
    const key = this.availabilityKey(request);
    const stage: SearchStage = scope?.multiLimit !== undefined ? 'multiInterchange' : scope?.recoveryLimit !== undefined ? 'sameTrainRecovery' : direct ? 'direct' : 'oneChange';
    this.orchestrator?.start(stage);
    if (this.seats.has(key)) { this.orchestrator?.recordCacheHit(stage); this.diagnostics.availabilityCacheHits += 1; return this.seats.get(key) ?? null; }
    const trainDate = JSON.stringify([request.trainNumber, request.journeyDate]);
    if ((this.unsupported.get(trainDate)?.size ?? 0) >= this.threshold) {
      this.diagnostics.providerCircuitBreakerSkips += 1;
      return null;
    }
    // Cache and breaker checks precede soft budgets: neither consumes phase allowance.
    if (scope && direct && this.diagnostics.availabilityCallsByPhase.direct >= scope.directLimit) {
      this.diagnostics.directPhaseSoftLimitReached = true;
      return null;
    }
    if (scope?.stationCode && (this.diagnostics.availabilityCallsByConnectionStation[scope.stationCode] ?? 0) >= scope.stationLimit) return null;
    if (scope?.recoveryLimit !== undefined && this.diagnostics.availabilityCalls >= scope.recoveryLimit) { this.orchestrator?.defer(stage); return null; }
    if (scope?.multiLimit !== undefined && this.diagnostics.availabilityCalls >= scope.multiLimit) return null;
    if (this.orchestrator && !this.orchestrator.canSpend(stage, 1)) return null;
    if (!this.consume('availability')) return null;
    this.orchestrator?.recordSpend(stage);
    if (stage === 'direct' || stage === 'sameTrainRecovery') this.orchestrator?.markMeaningfulAttempt(stage);
    if (scope?.multiLimit !== undefined) this.diagnostics.availabilityCallsByPhase.multi = (this.diagnostics.availabilityCallsByPhase.multi ?? 0) + 1;
    else if (scope?.recoveryLimit !== undefined) this.diagnostics.availabilityCallsByPhase.recovery = (this.diagnostics.availabilityCallsByPhase.recovery ?? 0) + 1;
    else this.diagnostics.availabilityCallsByPhase[direct ? 'direct' : 'connection'] += 1;
    if (scope?.stationCode) this.diagnostics.availabilityCallsByConnectionStation[scope.stationCode] = (this.diagnostics.availabilityCallsByConnectionStation[scope.stationCode] ?? 0) + 1;
    if (direct) this.diagnostics.directAvailabilityChecks += 1;
    if (direct && scope && scope.directLimit < this.budget.config.maxAvailabilityCalls && this.diagnostics.availabilityCallsByPhase.direct >= scope.directLimit) this.diagnostics.directPhaseSoftLimitReached = true;
    try {
      const result = await this.provider.getAvailability({ ...request });
      this.seats.set(key, result);
      if (result.providerState !== 'SUCCESS') this.failure(result);
      if (result.providerState === 'PROVIDER_UNAVAILABLE') this.recordUnsupported(request, trainDate, key);
      return result;
    } catch (error: unknown) {
      this.failure(error);
      if (typeof error === 'object' && error !== null && 'providerState' in error && error.providerState === 'PROVIDER_UNAVAILABLE') this.recordUnsupported(request, trainDate, key);
      this.seats.set(key, null);
      return null;
    }
  }
  private recordUnsupported(request: AvailabilityRequest, trainDate: string, key: string): void {
    const failures = this.unsupported.get(trainDate) ?? new Set<string>();
    failures.add(key);
    this.unsupported.set(trainDate, failures);
    if (failures.size === this.threshold) this.diagnostics.likelyProviderUnsupported.push({ trainNumber: request.trainNumber, journeyDate: request.journeyDate });
  }

}
