import type { RailwayProvider } from '../../providers/railway-provider.js';
import type { AvailabilityRequest, AvailabilityResult } from '../../domain/types/availability.js';
import { SearchBudget } from './search-budget.js';
import type { SearchDiagnostics } from './search-diagnostics.js';
/** One instance per search. Caches failures too; never retries a query. */
export class SearchAvailability {
  private readonly cache = new Map<string, AvailabilityResult | null>();
  constructor(private readonly provider: RailwayProvider, private readonly budget: SearchBudget,
    private readonly diagnostics: SearchDiagnostics) {}
  async get(request: AvailabilityRequest, kind: 'direct' | 'split', stationCode?: string): Promise<AvailabilityResult | null> {
    const key = JSON.stringify([request.trainNumber, request.fromStationCode, request.toStationCode,
      request.journeyDate, request.travelClass, request.quota]);
    if (this.cache.has(key)) {
      this.diagnostics.cacheHits += 1;
      return this.cache.get(key) ?? null;
    }
    if (!this.budget.canCall()) return null;
    this.budget.consumeCall();
    this.diagnostics.availabilityCalls += 1;
    if (kind === 'direct') this.diagnostics.directChecks += 1;
    else this.diagnostics.splitChecks += 1;
    if (stationCode && !this.diagnostics.intermediateStationsQueried.includes(stationCode)) {
      this.diagnostics.intermediateStationsQueried.push(stationCode);
    }
    try {
      const result = await this.provider.getAvailability({ ...request });
      this.cache.set(key, result);
      if (result.providerState === 'PROVIDER_UNAVAILABLE') this.diagnostics.providerUnavailableCount += 1;
      else if (result.providerState === 'PROVIDER_ERROR') this.diagnostics.providerErrorCount += 1;
      return result;
    } catch {
      this.diagnostics.providerErrorCount += 1;
      this.cache.set(key, null);
      return null;
    }
  }
}
