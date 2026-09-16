import test from 'node:test';
import assert from 'node:assert/strict';
import type { RailwayProvider } from '../providers/railway-provider.js';
import type { TrainSearchRequest, TrainSearchResult, TrainCandidate } from '../domain/types/train-search.js';
import type { TrainDetails } from '../domain/types/train.js';
import type { AvailabilityRequest, AvailabilityResult, AvailabilityDay } from '../domain/types/availability.js';
import type { DifferentTrainJourneyResult, JourneyResult } from '../journey/types/journey-result.js';
import { ConnectionSearchEngine } from '../journey/connection/connection-search-engine.js';
import { ConnectionProviderSession } from '../journey/connection/provider-session.js';
import { ConnectionBudget } from '../journey/connection/budget.js';
import { connectionDiagnostics, type ConnectionSearchRequest } from '../journey/connection/types.js';
import { parseDate, addDays, clockMinutes, scheduledRun, connectionTimes, connectionSafety, departureDates } from '../journey/connection/timing.js';
import { compatiblePairs, firstLegIsBottleneck } from '../journey/connection/pairs.js';
import { rankResults, resultIdentity } from '../journey/scoring/result-ranking.js';
import { normalizeTrainSearch } from '../providers/railkit/railkit-discovery.js';
import type { RailKitTrainSearchResponse } from '../providers/railkit/railkit-types.js';

const input: ConnectionSearchRequest = { fromStationCode: 'AAA', toStationCode: 'ZZZ', journeyDate: '15-09-2099', classes: ['3A'], quota: 'GN' };
function candidate(number: string, from: string, to: string, departure = '20:00', arrival = '02:00', duration = 360, distance = 200): TrainCandidate {
  return { trainNumber: number, trainName: `Fixture ${number}`, fromStationCode: from, toStationCode: to,
    departureTime: departure, arrivalTime: arrival, durationMinutes: duration, distanceKm: distance };
}
function success(trains: TrainCandidate[]): TrainSearchResult { return { provider: 'fake', providerState: 'SUCCESS', trains }; }
function seats(request: AvailabilityRequest, state: AvailabilityDay['state'] = 'AVAILABLE', fare?: number): AvailabilityResult {
  return { request, provider: 'railkit', providerState: 'SUCCESS', days: [{ date: request.journeyDate, state }],
    fare: fare === undefined ? undefined : { totalFare: fare, currency: 'INR' } };
}
const directTrain = candidate('11111', 'AAA', 'ZZZ', '20:00', '10:00', 840, 1000);
const incoming = candidate('22222', 'AAA', 'XXX');
const outgoing = candidate('33333', 'XXX', 'ZZZ', '04:00', '10:00', 360, 800);
class FakeProvider implements RailwayProvider {
  discoveryCalls: TrainSearchRequest[] = [];
  infoCalls: string[] = [];
  availabilityCalls: AvailabilityRequest[] = [];
  discover: (r: TrainSearchRequest) => TrainSearchResult = (r) => {
    if (r.fromStationCode === 'AAA' && r.toStationCode === 'ZZZ') return success([directTrain]);
    if (r.toStationCode === 'XXX') return success([incoming]);
    if (r.fromStationCode === 'XXX') return success([outgoing]);
    return success([]);
  };
  answer: (r: AvailabilityRequest) => AvailabilityResult = (r) => seats(r, r.trainNumber === '11111' ? 'WAITLIST' : 'AVAILABLE', r.trainNumber === '22222' ? 100 : 200);
  route: TrainDetails = { trainNumber: '11111', trainName: 'Seed', sourceStationCode: 'AAA', sourceStationName: 'AAA',
    destinationStationCode: 'ZZZ', destinationStationName: 'ZZZ', sourceDepartureTime: '20:00', destinationArrivalTime: '10:00',
    route: [ ['AAA', 0, 0, 1], ['XXX', 200, 10, 2], ['YYY', 600, 2, 2], ['ZZZ', 1000, 0, 2] ].map(([code, distance, halt, day]) => ({
      stationCode: String(code), stationName: String(code), distanceKm: Number(distance), haltMinutes: Number(halt), dayNumber: Number(day),
      arrivalTime: '02:00', departureTime: '02:05' })) };
  async searchTrainsBetweenStations(r: TrainSearchRequest) { this.discoveryCalls.push({ ...r }); return this.discover(r); }
  async getTrainInfo(n: string) { this.infoCalls.push(n); return { ...this.route, trainNumber: n }; }
  async getAvailability(r: AvailabilityRequest) { this.availabilityCalls.push({ ...r }); return this.answer(r); }
}
async function search(provider = new FakeProvider(), maxResults = 1) {
  return new ConnectionSearchEngine(provider).search(input, { budget: { maxResults } });
}
function session(provider: FakeProvider, threshold = 3, budget = new ConnectionBudget()) {
  return new ConnectionProviderSession(provider, budget, connectionDiagnostics(), threshold);
}
const availabilityRequest: AvailabilityRequest = { trainNumber: '22222', fromStationCode: 'AAA', toStationCode: 'XXX', journeyDate: input.journeyDate, travelClass: '3A', quota: 'GN' };

test('discovery normalizes documented fields and leaves unsupported fields unset', () => {
  const raw = { success: true, data: [{ train_no: '12345', train_name: 'Fixture', from_stn_code: 'AAA', to_stn_code: 'ZZZ',
    from_time: '16:55', to_time: '08:35', travel_time: '15:40 hrs', distance: '1384', running_days: '1111111' }] } satisfies RailKitTrainSearchResponse;
  const result = normalizeTrainSearch(raw, input);
  assert.equal(result.providerState, 'SUCCESS');
  assert.equal(result.trains[0].durationMinutes, 940);
  assert.equal(result.trains[0].distanceKm, 1384);
  assert.equal(result.trains[0].availableClasses, undefined);
  assert.equal(result.trains[0].sourceDayNumber, undefined);
});
test('discovery accepts explicit empty success but preserves malformed/failure as error', () => {
  assert.equal(normalizeTrainSearch({ success: true, data: [] }, input).providerState, 'SUCCESS');
  for (const raw of [{ success: false, error: 'coverage issue' }, { success: true }, null]) assert.equal(normalizeTrainSearch(raw, input).providerState, 'PROVIDER_ERROR');
});
test('direct discovery and direct AVAILABLE journey work without route calls', async () => {
  const provider = new FakeProvider(); provider.answer = (r) => seats(r);
  const result = await search(provider);
  assert.equal(result.diagnostics.directTrainsDiscovered, 1);
  assert.equal(result.results[0].type, 'DIRECT');
  assert.equal(provider.infoCalls.length, 0);
});
test('direct WAITLIST widens into a different-train scheduled connection', async () => {
  const result = await search();
  assert.equal(result.diagnostics.waitlistCount, 1);
  assert.equal(result.results[0].type, 'DIFFERENT_TRAIN_CONNECTION');
  assert.deepEqual(result.results[0].segments.map((s) => s.trainNumber), ['22222', '33333']);
});
test('same train numbers on both legs never become a different-train result', async () => {
  const provider = new FakeProvider(); const base = provider.discover;
  provider.discover = (r) => r.fromStationCode === 'XXX' ? success([{ ...outgoing, trainNumber: '22222' }]) : base(r);
  const result = await search(provider);
  assert.equal(result.results.length, 0);
  assert.equal(result.diagnostics.sameTrainPairsRejected, 1);
  assert.equal(provider.availabilityCalls.length, 1);
});
test('below-minimum transfer is rejected before any connection availability calls', async () => {
  const provider = new FakeProvider(); const base = provider.discover;
  provider.discover = (r) => r.fromStationCode === 'XXX' ? success([{ ...outgoing, departureTime: '02:30', arrivalTime: '08:30' }]) : base(r);
  const result = await search(provider);
  assert.equal(result.results.length, 0);
  assert.equal(result.diagnostics.trainPairsRejectedByTiming, 1);
  assert.equal(provider.availabilityCalls.length, 1);
});
test('GOOD window is accepted with scheduled duration and layover metadata', async () => {
  const result = await search(); const journey = result.results[0];
  assert.equal(journey.type, 'DIFFERENT_TRAIN_CONNECTION');
  if (journey.type !== 'DIFFERENT_TRAIN_CONNECTION') return;
  assert.equal(journey.connectionMinutes, 120);
  assert.equal(journey.connectionSafety, 'GOOD');
  assert.equal(journey.totalScheduledDurationMinutes, 840);
});
test('overnight discovery and second-leg availability use actual next boarding date', async () => {
  const provider = new FakeProvider(); const result = await search(provider);
  assert.equal(provider.discoveryCalls.find((r) => r.fromStationCode === 'XXX')?.journeyDate, '16-09-2099');
  assert.equal(provider.availabilityCalls.find((r) => r.trainNumber === '33333')?.journeyDate, '16-09-2099');
  assert.deepEqual(result.results[0].segments.map((s) => s.journeyDate), ['15-09-2099', '16-09-2099']);
});
test('pure midnight/day rollover utilities are timezone-independent and reject invalid dates', () => {
  assert.equal(clockMinutes('23:50'), 1430);
  assert.equal(clockMinutes('00:40'), 40);
  assert.equal(parseDate('02-01-2099') + 40 - (parseDate('01-01-2099') + 1430), 50);
  assert.equal(addDays('31-12-2099', 1), '01-01-2100');
  assert.equal(addDays('28-02-2100', 1), '01-03-2100');
  assert.throws(() => parseDate('31-02-2099'));
  assert.equal(clockMinutes('24:00'), undefined);
});
test('unknown timing is not guessed from clocks alone', () => {
  assert.equal(scheduledRun({ ...incoming, durationMinutes: undefined }, input.journeyDate), undefined);
  const run = scheduledRun({ ...incoming, durationMinutes: undefined, sourceDayNumber: 2, destinationDayNumber: 3 }, input.journeyDate);
  assert.equal(run?.arrival, parseDate('16-09-2099') + 120);
});
test('long connections require explicit permission and have a finite cap', () => {
  assert.equal(connectionSafety(30, connectionTimes()), undefined);
  assert.equal(connectionSafety(60, connectionTimes()), 'TIGHT');
  assert.equal(connectionSafety(120, connectionTimes()), 'GOOD');
  assert.equal(connectionSafety(400, connectionTimes()), undefined);
  assert.equal(connectionSafety(400, connectionTimes({ allowLongConnections: true })), 'LONG');
  assert.equal(connectionSafety(800, connectionTimes({ allowLongConnections: true })), undefined);
});
test('max trains per leg caps direct checks and route inspection', async () => {
  const provider = new FakeProvider();
  provider.discover = () => success(Array.from({ length: 10 }, (_, i) => ({ ...directTrain, trainNumber: String(10000 + i) })));
  provider.answer = (r) => seats(r, 'WAITLIST');
  const result = await new ConnectionSearchEngine(provider).search(input, { budget: { maxTrainsPerLeg: 2, maxConnectionStations: 0 } });
  assert.equal(result.diagnostics.directAvailabilityChecks, 2);
  assert.equal(provider.availabilityCalls.length, 2);
});
test('max pairs per connection caps availability exploration', async () => {
  const provider = new FakeProvider(); const base = provider.discover;
  provider.discover = (r) => r.toStationCode === 'XXX' ? success([incoming, { ...incoming, trainNumber: '22223' }]) :
    r.fromStationCode === 'XXX' ? success([outgoing, { ...outgoing, trainNumber: '33334' }]) : base(r);
  provider.answer = (r) => seats(r, 'WAITLIST');
  const result = await new ConnectionSearchEngine(provider).search(input, { budget: { maxTrainPairsPerConnection: 1 } });
  assert.equal(result.diagnostics.trainPairsGenerated, 4);
  assert.equal(result.diagnostics.trainPairsCheckedForAvailability, 1);
});
test('max connection stations limits progressive discovery', async () => {
  const provider = new FakeProvider(); provider.answer = (r) => seats(r, 'WAITLIST');
  const result = await new ConnectionSearchEngine(provider).search(input, { budget: { maxConnectionStations: 1 } });
  assert.deepEqual(result.diagnostics.connectionStationsQueried, ['XXX']);
});
test('all three call budgets are independently enforced on success and failure paths', async () => {
  for (let limit = 0; limit <= 5; limit += 1) {
    for (const fail of [false, true]) {
      const provider = new FakeProvider();
      if (fail) provider.answer = () => { throw new Error('offline failure'); };
      const result = await new ConnectionSearchEngine(provider).search({ ...input, classes: ['3A', 'SL', '2A'] }, {
        budget: { maxTrainDiscoveryCalls: limit, maxTrainInfoCalls: limit, maxAvailabilityCalls: limit, maxResults: 20 } });
      assert.ok(provider.discoveryCalls.length <= limit);
      assert.ok(provider.infoCalls.length <= limit);
      assert.ok(provider.availabilityCalls.length <= limit);
      assert.equal(result.diagnostics.totalExternalApiCalls, provider.discoveryCalls.length + provider.infoCalls.length + provider.availabilityCalls.length);
    }
  }
});
test('longer distance bottleneck is queried first', async () => {
  const provider = new FakeProvider(); await search(provider);
  assert.equal(provider.availabilityCalls[1].trainNumber, '33333');
});
test('bottleneck uses duration fallback then second leg on a tie', () => {
  const first = scheduledRun({ ...incoming, distanceKm: undefined }, input.journeyDate)!;
  const second = scheduledRun({ ...outgoing, distanceKm: undefined }, '16-09-2099')!;
  const pair = compatiblePairs([first], [second], connectionTimes(), 1, connectionDiagnostics())[0];
  assert.equal(firstLegIsBottleneck(pair), false);
  assert.equal(firstLegIsBottleneck({ ...pair, first: { ...first, arrival: first.arrival + 60 } }), true);
});
test('failed bottleneck skips the other leg', async () => {
  const provider = new FakeProvider(); provider.answer = (r) => seats(r, 'WAITLIST');
  await search(provider);
  assert.ok(!provider.availabilityCalls.some((r) => r.trainNumber === '22222'));
});
test('mixed classes across trains work without Cartesian calls', async () => {
  const provider = new FakeProvider();
  provider.answer = (r) => seats(r, (r.trainNumber === '22222' && r.travelClass === '3A') || (r.trainNumber === '33333' && r.travelClass === 'SL') ? 'AVAILABLE' : 'WAITLIST');
  const result = await new ConnectionSearchEngine(provider).search({ ...input, classes: ['3A', 'SL'] }, { budget: { maxResults: 1 } });
  assert.deepEqual(result.results[0].segments.map((s) => s.travelClass), ['3A', 'SL']);
  assert.equal(provider.availabilityCalls.length, 5);
});
test('both fares are summed; a missing segment fare leaves total undefined', async () => {
  assert.equal((await search()).results[0].totalFare, 300);
  const provider = new FakeProvider(); const base = provider.answer;
  provider.answer = (r) => ({ ...base(r), fare: r.trainNumber === '22222' ? undefined : { totalFare: 200, currency: 'INR' } });
  assert.equal((await search(provider)).results[0].totalFare, undefined);
});
test('discovery, route and availability caches reuse exact requests for zero budget', async () => {
  const provider = new FakeProvider(); const local = session(provider);
  for (let i = 0; i < 2; i += 1) {
    await local.discover(input); await local.info('11111'); await local.availability(availabilityRequest);
  }
  assert.equal(provider.discoveryCalls.length, 1); assert.equal(provider.infoCalls.length, 1); assert.equal(provider.availabilityCalls.length, 1);
  assert.equal(local.diagnostics.trainDiscoveryCacheHits, 1); assert.equal(local.diagnostics.trainInfoCacheHits, 1); assert.equal(local.diagnostics.availabilityCacheHits, 1);
});
test('cache successes/failures are request-local and caches include date', async () => {
  const provider = new FakeProvider(); provider.discover = () => { throw new Error('offline'); };
  const local = session(provider);
  await local.discover(input); await local.discover(input);
  await local.discover({ ...input, journeyDate: '16-09-2099' });
  await session(provider).discover(input);
  assert.equal(provider.discoveryCalls.length, 3);
  assert.equal(local.diagnostics.providerErrorCount, 2);
});
test('provider unavailable remains distinct and counts toward coverage breaker', async () => {
  const provider = new FakeProvider(); provider.answer = (r) => ({ ...seats(r), providerState: 'PROVIDER_UNAVAILABLE', days: [] });
  const local = session(provider);
  for (const travelClass of ['SL', '3A', '2A', '1A', '3E']) await local.availability({ ...availabilityRequest, travelClass });
  assert.equal(provider.availabilityCalls.length, 3);
  assert.equal(local.diagnostics.providerUnavailableCount, 3);
  assert.equal(local.diagnostics.providerCircuitBreakerSkips, 2);
  assert.equal(local.diagnostics.likelyProviderUnsupported.length, 1);
});
test('circuit breaker uses distinct requests, configurable threshold and train/date isolation', async () => {
  const provider = new FakeProvider(); provider.answer = (r) => ({ ...seats(r), providerState: 'PROVIDER_UNAVAILABLE', days: [] });
  const local = session(provider, 2);
  await local.availability(availabilityRequest); await local.availability(availabilityRequest);
  await local.availability({ ...availabilityRequest, travelClass: 'SL' });
  await local.availability({ ...availabilityRequest, travelClass: '2A' });
  await local.availability({ ...availabilityRequest, journeyDate: '16-09-2099' });
  await local.availability({ ...availabilityRequest, trainNumber: '44444' });
  assert.equal(provider.availabilityCalls.length, 4);
  assert.equal(local.diagnostics.providerCircuitBreakerSkips, 1);
  assert.equal(local.diagnostics.availabilityCacheHits, 1);
});
test('breaker never activates for WAITLIST, RAC, AVAILABLE, NOT_AVAILABLE or PROVIDER_ERROR', async () => {
  for (const status of ['WAITLIST', 'RAC', 'AVAILABLE', 'NOT_AVAILABLE', 'PROVIDER_ERROR'] as const) {
    const provider = new FakeProvider(); provider.answer = (r) => status === 'PROVIDER_ERROR' ? { ...seats(r), providerState: status, days: [] } : seats(r, status);
    const local = session(provider, 1);
    for (const travelClass of ['3A', 'SL', '2A']) await local.availability({ ...availabilityRequest, travelClass });
    assert.equal(provider.availabilityCalls.length, 3); assert.equal(local.diagnostics.providerCircuitBreakerSkips, 0);
  }
});
test('discovery provider error at one station allows progressive search at the next', async () => {
  const provider = new FakeProvider(); const base = provider.discover;
  provider.discover = (r) => r.toStationCode === 'XXX' ? { provider: 'fake', providerState: 'PROVIDER_ERROR', trains: [] } : base(r);
  const result = await search(provider);
  assert.deepEqual(result.diagnostics.connectionStationsQueried, ['XXX', 'YYY']);
  assert.equal(result.diagnostics.providerErrorCount, 1);
});
test('empty first leg rejects station without onward discovery or seat calls', async () => {
  const provider = new FakeProvider(); const base = provider.discover;
  provider.discover = (r) => r.toStationCode === 'XXX' ? success([]) : base(r);
  await search(provider);
  assert.ok(!provider.discoveryCalls.some((r) => r.fromStationCode === 'XXX'));
  assert.equal(provider.availabilityCalls.length, 1);
});
test('direct results rank above different-train journeys', async () => {
  const connection = (await search()).results[0];
  const direct: JourneyResult = { type: 'DIRECT', trainNumber: '99999', segments: [{ ...connection.segments[0], availabilityState: 'RAC' }], totalLiveAvailabilityCallsUsed: 1 };
  assert.equal(rankResults([connection, direct])[0].type, 'DIRECT');
});
test('GOOD safety outranks cheaper TIGHT or LONG connections', async () => {
  const result = (await search()).results[0] as DifferentTrainJourneyResult;
  const good = { ...result, totalFare: 1000 };
  const tight = { ...result, connectionSafety: 'TIGHT' as const, connectionMinutes: 60, totalFare: 1 };
  const long = { ...result, connectionSafety: 'LONG' as const, connectionMinutes: 400, totalFare: 0 };
  assert.deepEqual(rankResults([long, tight, good]).map((r) => r.connectionSafety), ['GOOD', 'TIGHT', 'LONG']);
});
test('duplicate discovery trains and classes do not duplicate journey results', async () => {
  const provider = new FakeProvider(); const base = provider.discover;
  provider.discover = (r) => { const result = base(r); return { ...result, trains: [...result.trains, ...result.trains] }; };
  const result = await new ConnectionSearchEngine(provider).search({ ...input, classes: ['3A', '3A'] });
  const identities = result.results.map(resultIdentity);
  assert.equal(new Set(identities).size, identities.length);
  assert.equal(result.results.length, 1);
});
test('strong direct options stop connection work before route discovery', async () => {
  const provider = new FakeProvider(); provider.discover = () => success([directTrain, { ...directTrain, trainNumber: '44444' }]);
  provider.answer = (r) => seats(r);
  const result = await new ConnectionSearchEngine(provider).search({ ...input, classes: ['3A', 'SL'] }, { policy: { broadenDirectClassAlternatives: true } });
  assert.equal(result.diagnostics.earlyStopReason, 'ENOUGH_STRONG_DIRECT_RESULTS');
  assert.equal(provider.infoCalls.length, 0);
});
test('no route seeds returns an explicit limitation without guessing interchanges', async () => {
  const provider = new FakeProvider(); provider.discover = () => success([]);
  const result = await search(provider);
  assert.equal(result.diagnostics.earlyStopReason, 'NO_ROUTE_DERIVED_CONNECTION_STATIONS');
  assert.equal(provider.infoCalls.length, 0);
});
test('cache reads still work at exhausted budget', async () => {
  const provider = new FakeProvider(); const local = session(provider, 3, new ConnectionBudget({ maxTrainDiscoveryCalls: 1, maxTrainInfoCalls: 1, maxAvailabilityCalls: 1 }));
  await local.discover(input); await local.info('11111'); await local.availability(availabilityRequest);
  assert.ok(await local.discover(input)); assert.ok(await local.info('11111')); assert.ok(await local.availability(availabilityRequest));
  assert.equal(local.diagnostics.totalExternalApiCalls, 3);
});
test('departure dates include both days when the safe window crosses midnight', () => {
  assert.deepEqual(departureDates(parseDate('31-12-2099') + 20 * 60, connectionTimes()), ['31-12-2099', '01-01-2100']);
});

test('same-day incompatible trains do not hide a next-day safe connection', async () => {
  const provider = new FakeProvider(); const base = provider.discover;
  provider.discover = (r) => {
    if (r.toStationCode === 'XXX') return success([candidate('22222', 'AAA', 'XXX', '14:00', '20:00', 360)]);
    if (r.fromStationCode === 'XXX') return success([candidate('33333', 'XXX', 'ZZZ', '01:00', '07:00', 360, 800)]);
    return base(r);
  };
  const result = await new ConnectionSearchEngine(provider).search(input, { budget: { maxResults: 1, maxTrainsPerLeg: 1 } });
  assert.equal(result.results[0].type, 'DIFFERENT_TRAIN_CONNECTION');
  assert.equal(result.results[0].segments[1].journeyDate, '16-09-2099');
  assert.equal(provider.discoveryCalls.filter((r) => r.fromStationCode === 'XXX').length, 2);
});
test('train info fallback is bounded and cached when discovery omits timing', async () => {
  const provider = new FakeProvider(); const base = provider.discover;
  provider.discover = (r) => {
    const result = base(r);
    return { ...result, trains: result.trains.map((train) => ({ ...train, durationMinutes: undefined })) };
  };
  const result = await new ConnectionSearchEngine(provider).search(input, { budget: { maxTrainInfoCalls: 1 } });
  assert.equal(provider.infoCalls.length, 1);
  assert.ok(result.diagnostics.missingTimingCount > 0);
  assert.equal(result.results.length, 0);
});
test('leg limits apply before pair generation even with many discovered incoming/outgoing trains', async () => {
  const provider = new FakeProvider(); const base = provider.discover;
  provider.discover = (r) => r.toStationCode === 'XXX' ? success(Array.from({ length: 20 }, (_, i) => ({ ...incoming, trainNumber: String(22000 + i) }))) :
    r.fromStationCode === 'XXX' ? success(Array.from({ length: 20 }, (_, i) => ({ ...outgoing, trainNumber: String(33000 + i) }))) : base(r);
  provider.answer = (r) => seats(r, 'WAITLIST');
  const result = await new ConnectionSearchEngine(provider).search(input, { budget: { maxTrainsPerLeg: 2, maxTrainPairsPerConnection: 20 } });
  assert.equal(result.diagnostics.trainPairsGenerated, 4);
  assert.equal(result.diagnostics.trainPairsCheckedForAvailability, 4);
});
test('route/discovery/availability failure caches never retry and do not cross sessions', async () => {
  const provider = new FakeProvider();
  provider.getTrainInfo = async (n) => { provider.infoCalls.push(n); throw new Error('offline route failure'); };
  provider.answer = () => { throw new Error('offline seat failure'); };
  const local = session(provider);
  await local.info('11111'); await local.info('11111');
  await local.availability(availabilityRequest); await local.availability(availabilityRequest);
  assert.equal(provider.infoCalls.length, 1);
  assert.equal(provider.availabilityCalls.length, 1);
  await session(provider).availability(availabilityRequest);
  assert.equal(provider.availabilityCalls.length, 2);
});
test('thrown provider-unavailable participates in the configurable breaker', async () => {
  const provider = new FakeProvider(); provider.answer = () => { throw { providerState: 'PROVIDER_UNAVAILABLE' }; };
  const local = session(provider, 1);
  await local.availability(availabilityRequest);
  await local.availability({ ...availabilityRequest, travelClass: 'SL' });
  assert.equal(local.diagnostics.providerCircuitBreakerSkips, 1);
});
