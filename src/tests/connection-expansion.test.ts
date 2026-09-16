import test from 'node:test';
import assert from 'node:assert/strict';
import type { RailwayProvider } from '../providers/railway-provider.js';
import type { AvailabilityRequest, AvailabilityResult } from '../domain/types/availability.js';
import type { TrainSearchRequest, TrainCandidate } from '../domain/types/train-search.js';
import { ConnectionSearchEngine } from '../journey/connection/connection-search-engine.js';
import { ConnectionBudget, connectionPolicy, connectionStationLimit, directPhaseCallLimit } from '../journey/connection/budget.js';
import { ConnectionProviderSession } from '../journey/connection/provider-session.js';
import { connectionDiagnostics } from '../journey/connection/types.js';
import { selectTrains } from '../journey/connection/candidates.js';
const input = { fromStationCode: 'AAA', toStationCode: 'ZZZ', journeyDate: '15-09-2099', classes: ['3A', 'SL', '2A'] as ('3A' | 'SL' | '2A')[], quota: 'GN' as const };
function candidate(trainNumber: string, from: string, to: string): TrainCandidate {
  return { trainNumber, trainName: 'Fixture', fromStationCode: from, toStationCode: to,
    departureTime: from === 'AAA' ? '08:00' : '14:00', arrivalTime: from === 'AAA' ? '12:00' : '20:00',
    durationMinutes: from === 'AAA' ? 240 : 360, distanceKm: from === 'AAA' ? 200 : 800 };
}
class Fake implements RailwayProvider {
  calls: AvailabilityRequest[] = [];
  routeCalls = 0;
  discoveryCalls = 0;
  directCount = 4;
  answer: (r: AvailabilityRequest) => AvailabilityResult = (r) => ({ request: r, provider: 'railkit', providerState: 'SUCCESS', days: [{ date: r.journeyDate, state: 'WAITLIST' }] });
  async searchTrainsBetweenStations(r: TrainSearchRequest) {
    this.discoveryCalls += 1;
    const trains = r.fromStationCode === 'AAA' && r.toStationCode === 'ZZZ' ? Array.from({ length: this.directCount }, (_, i) => candidate(String(10000 + i), 'AAA', 'ZZZ')) :
      Array.from({ length: 4 }, (_, i) => candidate(String((r.fromStationCode === 'AAA' ? 20000 : 30000) + i), r.fromStationCode, r.toStationCode));
    return { provider: 'fake', providerState: 'SUCCESS' as const, trains };
  }
  async getTrainInfo(trainNumber: string) {
    this.routeCalls += 1;
    return { trainNumber, trainName: 'Fixture', sourceStationCode: 'AAA', sourceStationName: 'AAA', destinationStationCode: 'ZZZ', destinationStationName: 'ZZZ',
      sourceDepartureTime: '08:00', destinationArrivalTime: '20:00',
      route: ['AAA', 'XXX', 'YYY', 'WWW', 'ZZZ'].map((stationCode, i) => ({ stationCode, stationName: stationCode,
        arrivalTime: '12:00', departureTime: '14:00', distanceKm: i * 200, dayNumber: 1, haltMinutes: 2 })) };
  }
  async getAvailability(r: AvailabilityRequest) { this.calls.push(r); return this.answer(r); }
}
const available = (r: AvailabilityRequest): AvailabilityResult => ({ request: r, provider: 'railkit', providerState: 'SUCCESS', days: [{ date: r.journeyDate, state: 'AVAILABLE' }] });
const isDirect = (r: AvailabilityRequest) => r.fromStationCode === 'AAA' && r.toStationCode === 'ZZZ';

test('preferred class crosses all direct trains before subsequent widening rounds', async () => {
  const p = new Fake();
  const result = await new ConnectionSearchEngine(p).search(input, { budget: { maxConnectionStations: 0 } });
  assert.deepEqual(p.calls.map((r) => r.travelClass), ['3A','3A','3A','3A','SL','SL','SL','SL','2A','2A','2A','2A']);
  assert.equal(result.diagnostics.directSearchRounds, 3);
});
test('one preferred AVAILABLE avoids redundant classes and stops direct widening after the round', async () => {
  const p = new Fake(); const base = p.answer;
  p.answer = (r) => r.trainNumber === '10000' ? available(r) : base(r);
  const result = await new ConnectionSearchEngine(p).search(input);
  assert.equal(p.calls.filter(isDirect).length, 4);
  assert.equal(p.calls.filter((r) => r.trainNumber === '10000').length, 1);
  assert.equal(result.diagnostics.directChecksSkippedAfterStrongResult, 2);
  assert.equal(result.diagnostics.directSearchRounds, 1);
});
for (const [availableResults, expected] of [[0,3], [1,2], [2,1], [3,0]]) {
  test(`${availableResults} direct AVAILABLE results allow ${expected} connection stations`, () => {
    assert.equal(connectionStationLimit({ availableResults, racResults: 0 }, 3, connectionPolicy()), expected);
    assert.ok(connectionStationLimit({ availableResults, racResults: 0 }, 1, connectionPolicy()) <= 1);
  });
}
test('three strong direct results skip route and connection discovery', async () => {
  const p = new Fake(); p.answer = available;
  const result = await new ConnectionSearchEngine(p).search(input);
  assert.equal(p.routeCalls, 0);
  assert.equal(p.discoveryCalls, 1);
  assert.equal(result.diagnostics.connectionSearchSkippedReason, 'ENOUGH_STRONG_DIRECT_RESULTS');
});
test('RAC alone retains fallback breadth and is summarized separately', async () => {
  const p = new Fake(); p.directCount = 1; const base = p.answer;
  p.answer = (r) => isDirect(r) ? { ...available(r), days: [{ date: r.journeyDate, state: 'RAC' }] } : base(r);
  const result = await new ConnectionSearchEngine(p).search(input);
  assert.equal(result.diagnostics.directSearchQuality.availableResults, 0);
  assert.equal(result.diagnostics.directSearchQuality.racResults, 2);
  assert.equal(result.diagnostics.effectiveConnectionStationLimit, 3);
});
test('direct soft limit reserves calls and records per-phase totals', async () => {
  const p = new Fake();
  const result = await new ConnectionSearchEngine(p).search(input, { budget: { maxAvailabilityCalls: 10 } });
  assert.equal(result.diagnostics.directAvailabilityChecks, 4);
  assert.equal(result.diagnostics.directPhaseSoftLimitReached, true);
  assert.ok(result.diagnostics.availabilityCallsByPhase.connection > 0);
  assert.equal(result.diagnostics.availabilityCallsByPhase.direct + result.diagnostics.availabilityCallsByPhase.connection, result.diagnostics.availabilityCalls);
});
test('global hard availability limit holds for tiny and large budgets', async () => {
  for (const maxAvailabilityCalls of [0,1,2,5,10,30]) {
    const p = new Fake();
    const result = await new ConnectionSearchEngine(p).search(input, { budget: { maxAvailabilityCalls } });
    assert.ok(p.calls.length <= maxAvailabilityCalls);
    assert.equal(result.diagnostics.availabilityCalls, p.calls.length);
  }
});
test('each connection station stays under its configured soft call cap', async () => {
  const p = new Fake();
  const result = await new ConnectionSearchEngine(p).search(input, { policy: { maxAvailabilityCallsPerConnectionStation: 2 } });
  const counts = Object.values(result.diagnostics.availabilityCallsByConnectionStation);
  assert.ok(counts.length > 1);
  assert.ok(counts.every((n) => n <= 2));
  assert.equal(counts.reduce((a,b) => a+b, 0), result.diagnostics.availabilityCallsByPhase.connection);
});
test('cache successes and failures consume no phase or station allowance at the cap', async () => {
  for (const fail of [false, true]) {
    const p = new Fake(); if (fail) p.answer = () => { throw new Error('offline'); }; else p.answer = available;
    const d = connectionDiagnostics();
    const session = new ConnectionProviderSession(p, new ConnectionBudget(), d, 3);
    const r: AvailabilityRequest = { ...input, trainNumber: '10000', travelClass: '3A' };
    const scope = { directLimit: 1, stationLimit: 1, stationCode: 'XXX' };
    await session.availability(r, false, scope);
    await session.availability(r, false, scope);
    await session.availability({ ...r, travelClass: 'SL' }, false, scope);
    assert.equal(p.calls.length, 1);
    assert.equal(d.availabilityCacheHits, 1);
    assert.equal(d.availabilityCallsByConnectionStation.XXX, 1);
    assert.equal(d.availabilityCallsByPhase.connection, 1);
  }
});
test('direct-only searches can use the whole budget; fractional policies are validated', () => {
  const b = new ConnectionBudget({ maxAvailabilityCalls: 10, maxConnectionStations: 0 });
  assert.equal(directPhaseCallLimit(b.config, connectionPolicy()), 10);
  for (const fraction of [0, -1, 2, NaN]) assert.throws(() => connectionPolicy({ directAvailabilityBudgetFraction: fraction }));
});
test('explicit broader class preference allows lower classes within the soft budget', async () => {
  const p = new Fake(); p.directCount = 1; p.answer = available;
  const result = await new ConnectionSearchEngine(p).search(input, { budget: { maxConnectionStations: 0 }, policy: { broadenDirectClassAlternatives: true } });
  assert.deepEqual(p.calls.map((r) => r.travelClass), ['3A', 'SL']);
  assert.equal(result.results.length, 2);
});
test('known class priority and halt counts rank candidates without route reads', () => {
  const trains: TrainCandidate[] = [{ ...candidate('10000','AAA','ZZZ'), availableClasses: ['SL'] },
    { ...candidate('10001','AAA','ZZZ'), haltCount: 5 }, { ...candidate('10002','AAA','ZZZ'), haltCount: 1 }];
  const result = selectTrains({ provider: 'fake', providerState: 'SUCCESS', trains }, input, input.classes, 4);
  assert.deepEqual(result.map((r) => r.trainNumber), ['10002','10001','10000']);
});
test('timing rejection still precedes connection availability', async () => {
  const p = new Fake(); const base = p.searchTrainsBetweenStations.bind(p);
  p.searchTrainsBetweenStations = async (r) => {
    const result = await base(r);
    return r.fromStationCode === 'AAA' ? result : { ...result, trains: result.trains.map((t) => ({ ...t, departureTime: '12:30', arrivalTime: '18:30' })) };
  };
  const result = await new ConnectionSearchEngine(p).search(input);
  assert.equal(result.diagnostics.availabilityCallsByPhase.connection, 0);
  assert.ok(result.diagnostics.trainPairsRejectedByTiming > 0);
});
