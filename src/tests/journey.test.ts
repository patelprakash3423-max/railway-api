import test from 'node:test';
import assert from 'node:assert/strict';
import type { RailwayProvider } from '../providers/railway-provider.js';
import type { TrainDetails } from '../domain/types/train.js';
import type { TrainStop } from '../domain/types/station.js';
import type { AvailabilityRequest, AvailabilityResult, AvailabilityDay } from '../domain/types/availability.js';
import type { JourneySearchRequest } from '../journey/types/journey-search.js';
import { SameTrainSearchEngine } from '../journey/engine/same-train-search-engine.js';
import { SearchBudget } from '../journey/utils/search-budget.js';
import { SearchAvailability } from '../journey/utils/search-availability.js';
import { createSearchDiagnostics, JourneySearchError } from '../journey/utils/search-diagnostics.js';
import { junctionScore } from '../journey/scoring/junction-score.js';
import { rankResults, resultIdentity } from '../journey/scoring/result-ranking.js';
import { getApiCallCount, resetApiCallCount } from '../utils/api-call-counter.js';

const input: JourneySearchRequest = { trainNumber: '12345', fromStationCode: 'AAA', toStationCode: 'ZZZ',
  journeyDate: '15-09-2099', classes: ['3A'], quota: 'GN' };
function stop(stationCode: string, distanceKm: number, haltMinutes = 2, dayNumber = 1): TrainStop {
  return { stationCode, stationName: stationCode, distanceKm, haltMinutes, dayNumber,
    arrivalTime: '12:00', departureTime: '12:05' };
}
const route = [stop('AAA', 0), stop('XXX', 200, 10), stop('YYY', 600), stop('ZZZ', 1000)];
type Answer = (request: AvailabilityRequest) => AvailabilityResult;
function response(request: AvailabilityRequest, state: AvailabilityDay['state'] = 'WAITLIST', fare?: number): AvailabilityResult {
  return { request, provider: 'railkit', providerState: 'SUCCESS', days: [{ date: request.journeyDate, state }],
    fare: fare === undefined ? undefined : { totalFare: fare, currency: 'INR' } };
}
function direct(request: AvailabilityRequest): boolean {
  return request.fromStationCode === 'AAA' && request.toStationCode === 'ZZZ';
}
class FakeProvider implements RailwayProvider {
  async searchTrainsBetweenStations() { return { provider: 'fake', providerState: 'SUCCESS' as const, trains: [] }; }
  trainCalls = 0;
  calls: AvailabilityRequest[] = [];
  constructor(readonly answer: Answer = (r) => response(r), readonly stops = route) {}
  async getTrainInfo(trainNumber: string): Promise<TrainDetails> {
    this.trainCalls += 1;
    return { trainNumber, trainName: 'Fake train', sourceStationCode: 'AAA', sourceStationName: 'AAA',
      destinationStationCode: 'ZZZ', destinationStationName: 'ZZZ', sourceDepartureTime: '12:00',
      destinationArrivalTime: '12:00', route: this.stops };
  }
  async getAvailability(request: AvailabilityRequest): Promise<AvailabilityResult> {
    this.calls.push({ ...request });
    return this.answer(request);
  }
}

test('direct AVAILABLE and RAC results are usable and all priority classes are checked', async () => {
  const provider = new FakeProvider((r) => response(r, r.travelClass === 'SL' ? 'RAC' : 'AVAILABLE', 100));
  const result = await new SameTrainSearchEngine(provider).search({ ...input, classes: ['SL', '3A'] }, { maxIntermediateStations: 0 });
  assert.equal(provider.trainCalls, 1);
  assert.deepEqual(provider.calls.map((r) => r.travelClass), ['SL', '3A']);
  assert.deepEqual(result.results.map((r) => r.segments[0].availabilityState), ['AVAILABLE', 'RAC']);
  assert.equal(result.results[0].totalFare, 100);
  assert.equal(result.results[0].totalLiveAvailabilityCallsUsed, 2);
});
test('WAITLIST is diagnostic only, never a journey result', async () => {
  const provider = new FakeProvider();
  const result = await new SameTrainSearchEngine(provider).search(input);
  assert.deepEqual(result.results, []);
  assert.equal(result.diagnostics.waitlistCount, provider.calls.length);
});
test('provider unavailable/error remain distinct from seat unavailability and search continues', async () => {
  const provider = new FakeProvider((r) => ({ ...response(r), providerState: r.travelClass === 'SL' ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_ERROR', days: [] }));
  const result = await new SameTrainSearchEngine(provider).search({ ...input, classes: ['SL', '3A'] });
  assert.equal(result.results.length, 0);
  assert.equal(result.diagnostics.providerUnavailableCount, 3);
  assert.equal(result.diagnostics.providerErrorCount, 3);
  assert.equal(result.diagnostics.notAvailableCount, 0);
});
test('scored candidates are limited and longer half is queried first', async () => {
  const provider = new FakeProvider();
  const result = await new SameTrainSearchEngine(provider).search(input, { maxIntermediateStations: 1 });
  assert.equal(result.diagnostics.intermediateStationsConsidered, 2);
  assert.deepEqual(result.diagnostics.intermediateStationsQueried, ['XXX']);
  assert.equal(provider.calls[1].fromStationCode, 'XXX');
  assert.equal(provider.calls[1].toStationCode, 'ZZZ');
  assert.equal(provider.calls.length, 2); // Failed harder half never triggers the easier half.
});
test('progressive widening stops at maxResults without touching the next station', async () => {
  const provider = new FakeProvider((r) => response(r, direct(r) ? 'WAITLIST' : 'AVAILABLE'));
  const result = await new SameTrainSearchEngine(provider).search(input, { maxResults: 1 });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].splitStationCode, 'XXX');
  assert.deepEqual(result.diagnostics.intermediateStationsQueried, ['XXX']);
  assert.equal(result.diagnostics.earlyStopReason, 'MAX_RESULTS_REACHED');
  assert.equal(provider.calls.length, 3);
});
test('widens to the next station when the first has no viable harder-half class', async () => {
  const provider = new FakeProvider((r) => response(r, r.fromStationCode === 'XXX' || direct(r) ? 'WAITLIST' : 'AVAILABLE'));
  const result = await new SameTrainSearchEngine(provider).search(input, { maxResults: 1 });
  assert.deepEqual(result.diagnostics.intermediateStationsQueried, ['XXX', 'YYY']);
  assert.equal(result.results[0].splitStationCode, 'YYY');
  assert.ok(!provider.calls.some((r) => r.fromStationCode === 'AAA' && r.toStationCode === 'XXX'));
});
test('strict budget holds across many stations/classes, successes, failures and throws', async () => {
  const many = [stop('AAA', 0), ...['BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH'].map((code, i) => stop(code, (i + 1) * 100, i + 1)), stop('ZZZ', 1000)];
  for (const mode of ['WAITLIST', 'AVAILABLE', 'THROW'] as const) {
    for (const classes of [['SL', '3A'], ['SL', '3A', '2A', '1A', '3E']] as const) {
    for (let maxAvailabilityCalls = 0; maxAvailabilityCalls <= 5; maxAvailabilityCalls += 1) {
      const provider = new FakeProvider((r) => {
        if (mode === 'THROW') throw new Error('offline provider failure');
        return response(r, mode);
      }, many);
      const result = await new SameTrainSearchEngine(provider).search({ ...input, classes: [...classes] },
        { maxAvailabilityCalls, maxIntermediateStations: 7, maxResults: 50 });
      assert.ok(provider.calls.length <= maxAvailabilityCalls);
      assert.equal(result.diagnostics.availabilityCalls, provider.calls.length);
      assert.equal(provider.trainCalls, 1);
      assert.equal(result.diagnostics.directChecks + result.diagnostics.splitChecks, provider.calls.length);
    }
    }
  }
});
test('request-local cache reuses exact queries including after budget exhaustion', async () => {
  resetApiCallCount();
  const provider = new FakeProvider((r) => response(r, 'AVAILABLE'));
  const budget = new SearchBudget({ maxAvailabilityCalls: 1 });
  const diagnostics = createSearchDiagnostics();
  const cache = new SearchAvailability(provider, budget, diagnostics);
  const request: AvailabilityRequest = { ...input, travelClass: '3A' };
  const first = await cache.get(request, 'direct');
  assert.equal(await cache.get({ ...request }, 'split', 'XXX'), first);
  assert.equal(await cache.get({ ...request, travelClass: 'SL' }, 'direct'), null);
  assert.equal(provider.calls.length, 1);
  assert.equal(budget.callsUsed, 1);
  assert.equal(diagnostics.cacheHits, 1);
  assert.equal(getApiCallCount(), 0);
});
test('cache includes every query dimension and does not cross search instances', async () => {
  const provider = new FakeProvider();
  const diagnostics = createSearchDiagnostics();
  const cache = new SearchAvailability(provider, new SearchBudget(), diagnostics);
  const request: AvailabilityRequest = { ...input, travelClass: '3A' };
  for (const changed of [request, { ...request, trainNumber: '54321' }, { ...request, fromStationCode: 'XXX' },
    { ...request, toStationCode: 'YYY' }, { ...request, journeyDate: '16-09-2099' }, { ...request, travelClass: 'SL' }]) {
    await cache.get(changed, 'direct');
  }
  assert.equal(provider.calls.length, 6);
  const otherCache = new SearchAvailability(provider, new SearchBudget(), createSearchDiagnostics());
  await otherCache.get(request, 'direct');
  assert.equal(provider.calls.length, 7);
});
test('thrown provider failures are cached without retries', async () => {
  const provider = new FakeProvider(() => { throw new Error('offline'); });
  const diagnostics = createSearchDiagnostics();
  const cache = new SearchAvailability(provider, new SearchBudget(), diagnostics);
  const request: AvailabilityRequest = { ...input, travelClass: 'SL' };
  await cache.get(request, 'direct');
  await cache.get(request, 'direct');
  assert.equal(provider.calls.length, 1);
  assert.equal(diagnostics.providerErrorCount, 1);
  assert.equal(diagnostics.cacheHits, 1);
});
test('mixed classes work without Cartesian querying and both known fares sum', async () => {
  const provider = new FakeProvider((r) => {
    const usable = (r.fromStationCode === 'XXX' && r.travelClass === 'SL') || (r.toStationCode === 'XXX' && r.travelClass === '3A');
    return response(r, usable ? 'AVAILABLE' : 'WAITLIST', r.fromStationCode === 'XXX' ? 200 : 100);
  });
  const result = await new SameTrainSearchEngine(provider).search({ ...input, classes: ['3A', 'SL'] }, { maxResults: 1 });
  assert.equal(result.results[0].type, 'SAME_TRAIN_SPLIT');
  assert.deepEqual(result.results[0].segments.map((s) => s.travelClass), ['3A', 'SL']);
  assert.equal(result.results[0].totalFare, 300);
  assert.equal(provider.calls.length, 5);
});
test('missing fare on either half leaves split total undefined', async () => {
  const provider = new FakeProvider((r) => response(r, direct(r) ? 'WAITLIST' : 'AVAILABLE', r.fromStationCode === 'XXX' ? 200 : undefined));
  const result = await new SameTrainSearchEngine(provider).search(input, { maxResults: 1 });
  assert.equal(result.results[0].totalFare, undefined);
});
test('invalid or reversed route endpoints fail before availability', async () => {
  for (const request of [{ ...input, fromStationCode: 'BAD' }, { ...input, fromStationCode: 'ZZZ', toStationCode: 'AAA' }]) {
    const provider = new FakeProvider();
    await assert.rejects(new SameTrainSearchEngine(provider).search(request), JourneySearchError);
    assert.equal(provider.trainCalls, 1);
    assert.equal(provider.calls.length, 0);
  }
});
test('duplicate input classes do not duplicate calls or journey results', async () => {
  const provider = new FakeProvider((r) => response(r, 'AVAILABLE'));
  const result = await new SameTrainSearchEngine(provider).search({ ...input, classes: ['3A', '3A', 'SL'] });
  const identities = result.results.map(resultIdentity);
  assert.equal(new Set(identities).size, identities.length);
  const queries = provider.calls.map((r) => JSON.stringify(r));
  assert.equal(new Set(queries).size, queries.length);
});
test('ranking places direct AVAILABLE, direct RAC, split AVAILABLE, split RAC in order', async () => {
  const provider = new FakeProvider((r) => response(r, r.travelClass === 'SL' ? 'RAC' : 'AVAILABLE'));
  const { results } = await new SameTrainSearchEngine(provider).search({ ...input, classes: ['SL', '3A'] });
  const rank = (r: typeof results[number]) => (r.type === 'DIRECT' ? 0 : 2) + Number(r.segments.some((s) => s.availabilityState === 'RAC'));
  const reversed = rankResults([...results].reverse());
  assert.deepEqual(reversed.map(rank), [...reversed.map(rank)].sort((a, b) => a - b));
  assert.equal(reversed[0].type, 'DIRECT');
  assert.equal(reversed[0].segments[0].availabilityState, 'AVAILABLE');
});
test('two direct AVAILABLE results reduce split exploration to one station', async () => {
  const provider = new FakeProvider((r) => response(r, direct(r) ? 'AVAILABLE' : 'WAITLIST'));
  const result = await new SameTrainSearchEngine(provider).search({ ...input, classes: ['3A', 'SL'] });
  assert.deepEqual(result.diagnostics.intermediateStationsQueried, ['XXX']);
  assert.equal(result.diagnostics.earlyStopReason, 'DIRECT_RESULTS_REDUCED_SPLIT_LIMIT');
});
test('date selection ignores availability on other dates and rejects canBook false', async () => {
  for (const change of ['date', 'booking']) {
    const provider = new FakeProvider((r) => {
      const result = response(r, 'AVAILABLE');
      if (change === 'date') result.days[0].date = '16-09-2099';
      else result.days[0].canBook = false;
      return result;
    });
    const result = await new SameTrainSearchEngine(provider).search(input, { maxIntermediateStations: 0 });
    assert.equal(result.results.length, 0);
    assert.equal(change === 'date' ? result.diagnostics.missingRequestedDateCount : result.diagnostics.unbookableCount, 1);
  }
});
test('overnight splits shift boarding dates by route day offset across year boundaries', async () => {
  const provider = new FakeProvider((r) => response(r, direct(r) ? 'WAITLIST' : 'AVAILABLE'),
    [stop('AAA', 0, 2, 2), stop('XXX', 200, 10, 3), stop('ZZZ', 1000, 2, 3)]);
  const result = await new SameTrainSearchEngine(provider).search({ ...input, journeyDate: '31-12-2099' }, { maxResults: 1 });
  assert.equal(provider.calls[1].journeyDate, '01-01-2100');
  assert.deepEqual(result.results[0].segments.map((s) => s.journeyDate), ['31-12-2099', '01-01-2100']);
});
test('junction heuristic uses halt, modest name and position bonuses, not platform size', () => {
  const source = stop('AAA', 0); const destination = stop('ZZZ', 1000);
  const middle = stop('XXX', 500, 10);
  assert.ok(junctionScore(middle, source, destination) > junctionScore(stop('YYY', 10, 2), source, destination));
  assert.equal(junctionScore({ ...middle, platform: '1' }, source, destination), junctionScore({ ...middle, platform: '20' }, source, destination));
  assert.equal(junctionScore({ ...middle, stationName: 'Example Junction' }, source, destination), junctionScore(middle, source, destination) + 2);
});
test('zero maxResults makes no availability requests; invalid budgets reject', async () => {
  const provider = new FakeProvider();
  const result = await new SameTrainSearchEngine(provider).search(input, { maxResults: 0 });
  assert.equal(provider.calls.length, 0);
  assert.equal(result.diagnostics.earlyStopReason, 'MAX_RESULTS_REACHED');
  for (const value of [-1, 0.5, NaN, Infinity]) assert.throws(() => new SearchBudget({ maxAvailabilityCalls: value }));
});
test('budgets and caches are isolated when the same engine runs multiple searches', async () => {
  const provider = new FakeProvider((r) => response(r, 'AVAILABLE'));
  const engine = new SameTrainSearchEngine(provider);
  const results = await Promise.all([engine.search(input, { maxAvailabilityCalls: 1 }), engine.search(input, { maxAvailabilityCalls: 1 })]);
  assert.equal(provider.trainCalls, 2);
  assert.equal(provider.calls.length, 2);
  for (const result of results) assert.equal(result.diagnostics.availabilityCalls, 1);
});
