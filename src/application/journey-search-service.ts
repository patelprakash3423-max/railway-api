import { SearchDiagnosticObserver, buildSearchDebug } from './search-debug-diagnostics.js';
import { searchApiUsage } from '../domain/usage/search-api-usage.js';
import { publicProviderQuota, type ProviderQuotaSnapshot } from '../domain/usage/provider-quota.js';
import { serializeMulti, rankPublicJourneys } from './multi-serialization.js';
import { randomUUID } from 'node:crypto';
import type { RailwayProvider } from '../providers/railway-provider.js';
import { ConnectionSearchEngine, type ConnectionSearchOptions } from '../journey/connection/connection-search-engine.js';
import type { ConnectionSearchRequest, ConnectionSearchResponse } from '../journey/connection/types.js';
import type { NormalizedPublicSearch, PublicJourneySearchResponse } from './public-models.js';
import { validatePublicSearch } from './validation.js';
import { searchModeConfig } from './search-mode.js';
import { serializeJourney, serializeRecovery } from './serializers.js';
import { classifySearchCompletion } from './search-completion.js';
import { PublicError, safeError } from './errors.js';
import { redact } from '../utils/errors.js';
import {jsonLogger,type SearchLogger} from '../utils/logger.js';
export {jsonLogger,type SearchLogger} from '../utils/logger.js';
export interface SearchRunner { search(request: ConnectionSearchRequest, options: ConnectionSearchOptions): Promise<ConnectionSearchResponse> }
export interface ServiceOptions {
  enableDiagnostics?: boolean;
  exposeSearchDiagnostics?: boolean;
  providerQuota?: ProviderQuotaSnapshot;
  logger?: SearchLogger;
  engineFactory?: (provider: RailwayProvider) => SearchRunner;
}
export class JourneySearchService {
  constructor(private readonly provider: RailwayProvider, private readonly options: ServiceOptions = {}) {}
  async search(input: unknown, requestId: string = randomUUID()): Promise<PublicJourneySearchResponse> {
    const start = performance.now();
    let search: NormalizedPublicSearch | undefined;
    let calls = 0; let availabilityAttempts = 0; let availabilitySuccesses = 0; let resultCount = 0;
    const observer = this.options.exposeSearchDiagnostics ? new SearchDiagnosticObserver() : undefined;
    const callsByType = { discovery: 0, trainInfo: 0, availability: 0 };
    let failure: string | undefined;
    // Per-request wrapper: never reset or read the SDK's process-global counter.
    const provider: RailwayProvider = {
      searchTrainsBetweenStations: async (r) => { calls += 1; callsByType.discovery++; observer?.discoveryStarted(); try { const result = await this.provider.searchTrainsBetweenStations(r); observer?.observeDiscovery(r, result); return result; } catch (e) { observer?.observeFailure(e); throw e; } },
      getTrainInfo: async (n) => { calls += 1; callsByType.trainInfo++; try { const result = await this.provider.getTrainInfo(n); observer?.observeInfo(result); return result; } catch (e) { observer?.observeFailure(e); throw e; } },
      getAvailability: async (r) => { calls += 1; callsByType.availability++; availabilityAttempts += 1;
        try {
        const result = await this.provider.getAvailability(r);
        observer?.observeAvailability(r, result);
        if (result.providerState === 'SUCCESS') availabilitySuccesses += 1;
        return result; } catch (error) { observer?.observeAvailabilityError(error); throw error; } },
    };
    try {
      search = validatePublicSearch(input);
      const engine = this.options.engineFactory?.(provider) ?? new ConnectionSearchEngine(provider);
      const modeConfig = searchModeConfig(search.mode);
      const response = await engine.search({ fromStationCode: search.from, toStationCode: search.to,
        journeyDate: search.date, classes: search.classes, quota: search.quota }, modeConfig);
      const d = response.diagnostics;
      const failed = d.providerErrorCount + d.providerUnavailableCount > 0;
      if (!response.results.length && !response.recovery?.candidates.length && !response.multi?.candidates.length && (d.earlyStopReason === 'DIRECT_DISCOVERY_FAILED_NO_CONNECTION_SEEDS' ||
        (failed && availabilityAttempts > 0 && availabilitySuccesses === 0))) {
        throw new PublicError('PROVIDER_UNAVAILABLE', 'The provider could not complete a meaningful search. Please try again later.', 503);
      }
      const publicResults = rankPublicJourneys([...response.results.map(serializeJourney), ...(response.recovery?.candidates ?? []).map(serializeRecovery), ...(response.multi?.candidates ?? []).map(serializeMulti)]).slice(0, modeConfig.budget!.maxResults);
      resultCount = publicResults.length;
      const result: PublicJourneySearchResponse = { requestId, search, results: publicResults,
        meta: { resultCount, searchMode: search.mode, ...classifySearchCompletion(d),
          apiUsage: searchApiUsage(callsByType, d.availabilityCacheHits + d.trainDiscoveryCacheHits + d.trainInfoCacheHits, modeConfig.budget!.maxAvailabilityCalls!, search.mode),
          ...(this.options.providerQuota ? { providerQuota: publicProviderQuota(this.options.providerQuota) } : {}) } };
      if (observer) result.meta.debugDiagnostics = buildSearchDebug(response, observer, modeConfig, resultCount, callsByType);
      if (this.options.enableDiagnostics) result.debug = { providerCalls: calls, availabilityCalls: d.availabilityCalls,
        cacheHits: d.availabilityCacheHits + d.trainDiscoveryCacheHits + d.trainInfoCacheHits, earlyStopReason: d.earlyStopReason, ...(response.multi ? { multi: response.multi.diagnostics } : {}), ...(response.recovery ? { recovery: response.recovery.diagnostics } : {}) };
      // Defense in depth for provider strings as well as public search echoes.
      return JSON.parse(redact(JSON.stringify(result))) as PublicJourneySearchResponse;
    } catch (error: unknown) { const publicError = safeError(error); failure = publicError.code; throw publicError; }
    finally {
      const record = { level: failure ? 'error' : 'info', event: 'journey_search_completed', requestId,
        from: search?.from, to: search?.to, date: search?.date, searchMode: search?.mode,
        resultCount, elapsedMs: Math.round(performance.now() - start), externalCallCount: calls, availabilityCallCount: callsByType.availability,
        success: failure === undefined, errorCode: failure };
      try { (this.options.logger ?? jsonLogger)(JSON.parse(redact(JSON.stringify(record))) as Record<string, unknown>); } catch { /* Logging cannot change a search response. */ }
    }
  }
}
