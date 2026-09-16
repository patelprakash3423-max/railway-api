import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySearchCompletion } from '../application/search-completion.js';
import { connectionDiagnostics } from '../journey/connection/types.js';
import { JourneySearchService } from '../application/journey-search-service.js';
import type { RailwayProvider } from '../providers/railway-provider.js';
import type { JourneyResult } from '../journey/types/journey-result.js';
const complete = { searchCompleted: true, partialResults: false };
const partial = { searchCompleted: false, partialResults: true };
for (const earlyStopReason of ['DIRECT_RESULTS_REDUCED_CONNECTION_LIMIT', 'ENOUGH_STRONG_DIRECT_RESULTS', 'MAX_CONNECTION_STATIONS_REACHED', 'MAX_RESULTS_REACHED', 'CANDIDATES_EXHAUSTED']) {
  test(`${earlyStopReason} completes despite noncritical candidate failures`, () => {
    assert.deepEqual(classifySearchCompletion({ ...connectionDiagnostics(), earlyStopReason,
      providerErrorCount: 4, providerUnavailableCount: 2, missingTimingCount: 10, missingRequestedDateCount: 1 }), complete);
  });
}
for (const flag of ['availabilityBudgetExhausted', 'trainDiscoveryBudgetExhausted', 'trainInfoBudgetExhausted'] as const) {
  test(`${flag} marks execution truncation`, () => {
    assert.deepEqual(classifySearchCompletion({ ...connectionDiagnostics(), [flag]: true }), partial);
  });
}
test('max results achieved on the final allowed call is complete', () => {
  assert.deepEqual(classifySearchCompletion({ ...connectionDiagnostics(), earlyStopReason: 'MAX_RESULTS_REACHED', availabilityBudgetExhausted: true }), complete);
});
test('explicit critical failure, timeout or cancellation marks truncation', () => {
  for (const interruption of ['CRITICAL_PROVIDER_FAILURE', 'TIMEOUT', 'CANCELLED'] as const) {
    assert.deepEqual(classifySearchCompletion({ ...connectionDiagnostics(), earlyStopReason: 'MAX_RESULTS_REACHED' }, interruption), partial);
  }
});
const provider: RailwayProvider = {
  async searchTrainsBetweenStations() { throw new Error('No provider calls allowed.'); },
  async getTrainInfo() { throw new Error('No provider calls allowed.'); },
  async getAvailability() { throw new Error('No provider calls allowed.'); },
};
const connection: JourneyResult = { type: 'DIFFERENT_TRAIN_CONNECTION', connectionStationCode: 'ASH', connectionMinutes: 170,
  connectionSafety: 'GOOD', totalScheduledDurationMinutes: 1050, totalLiveAvailabilityCallsUsed: 16,
  segments: [
    { trainNumber: '02564', fromStationCode: 'NDLS', toStationCode: 'ASH', journeyDate: '20-09-2099', travelClass: '3A', availabilityState: 'AVAILABLE' },
    { trainNumber: '15566', fromStationCode: 'ASH', toStationCode: 'SV', journeyDate: '21-09-2099', travelClass: '2A', availabilityState: 'AVAILABLE' },
  ] };
for (const mode of ['QUICK', 'STANDARD', 'DEEP'] as const) {
  test(`${mode} intentional breadth returns completed public connection metadata`, async () => {
    const service = new JourneySearchService(provider, { logger: () => {}, engineFactory: () => ({ async search() {
      return { results: [connection], diagnostics: { ...connectionDiagnostics(), earlyStopReason: 'DIRECT_RESULTS_REDUCED_CONNECTION_LIMIT',
        providerErrorCount: 4, missingTimingCount: 5, directPhaseSoftLimitReached: true } };
    } }) });
    const response = await service.search({ from: 'NDLS', to: 'SV', date: '20-09-2099', searchMode: mode });
    assert.deepEqual(response.meta, { resultCount: 1, searchMode: mode, ...complete, apiUsage: response.meta.apiUsage });
    assert.equal(response.meta.apiUsage?.externalCalls, 0);
  });
}
test('valid completed empty search has explicit false partial flag', async () => {
  const service = new JourneySearchService(provider, { logger: () => {}, engineFactory: () => ({ async search() {
    return { results: [], diagnostics: connectionDiagnostics() };
  } }) });
  const response = await service.search({ from: 'NDLS', to: 'SV', date: '20-09-2099' });
  assert.deepEqual(response.meta, { resultCount: 0, searchMode: 'STANDARD', ...complete, apiUsage: response.meta.apiUsage });
  assert.equal(response.meta.apiUsage?.externalCalls, 0);
});
test('existing failed discovery still produces 503', async () => {
  const service = new JourneySearchService(provider, { logger: () => {}, engineFactory: () => ({ async search() {
    return { results: [], diagnostics: { ...connectionDiagnostics(), providerUnavailableCount: 1, earlyStopReason: 'DIRECT_DISCOVERY_FAILED_NO_CONNECTION_SEEDS' } };
  } }) });
  await assert.rejects(service.search({ from: 'NDLS', to: 'SV', date: '20-09-2099' }), { status: 503, code: 'PROVIDER_UNAVAILABLE' });
});
