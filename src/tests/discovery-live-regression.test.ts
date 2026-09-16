import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTrainSearch } from '../providers/railkit/railkit-discovery.js';
import type { RailKitTrainSearchResponse } from '../providers/railkit/railkit-types.js';
import { selectTrains } from '../journey/connection/candidates.js';
import { ConnectionSearchEngine } from '../journey/connection/connection-search-engine.js';
import type { RailwayProvider } from '../providers/railway-provider.js';
import type { TrainSearchResult } from '../domain/types/train-search.js';

// Exact two records supplied by the user, not a reconstruction of the seven-train response.
const observed = { success: true, data: [
  { train_no: '15910', train_name: 'AVADH ASSAM EXP', source_stn_name: 'Lalgarh Jn', source_stn_code: 'LGH',
    dstn_stn_name: 'Dibrugarh', dstn_stn_code: 'DBRG', from_stn_name: 'Delhi', from_stn_code: 'DLI',
    to_stn_name: 'Siwan Jn', to_stn_code: 'SV', from_time: '07:22', to_time: '02:10', travel_time: '18:48 hrs',
    running_days: '1111111', distance: '876', halts: 21 },
  { train_no: '02570', train_name: 'NDLS DBG SF SPL', source_stn_name: 'New Delhi', source_stn_code: 'NDLS',
    dstn_stn_name: 'Darbhanga Jn', dstn_stn_code: 'DBG', from_stn_name: 'New Delhi', from_stn_code: 'NDLS',
    to_stn_name: 'Siwan Jn', to_stn_code: 'SV', from_time: '12:15', to_time: '02:40', travel_time: '14:25 hrs',
    running_days: '1111111', distance: '906', halts: 5 },
] } satisfies RailKitTrainSearchResponse;
const request = { fromStationCode: 'NDLS', toStationCode: 'SV', journeyDate: '15-09-2099' };

test('observed snake_case payload succeeds and preserves mapped values', () => {
  const result = normalizeTrainSearch(observed, request);
  assert.equal(result.providerState, 'SUCCESS');
  assert.equal(result.trains.length, 2);
  const exact = result.trains[1];
  assert.equal(exact.trainNumber, '02570');
  assert.equal(exact.trainName, 'NDLS DBG SF SPL');
  assert.equal(exact.distanceKm, 906);
  assert.equal(exact.haltCount, 5);
  assert.equal(exact.travelTimeText, '14:25 hrs');
  assert.equal(exact.durationMinutes, 865);
  assert.equal(exact.departureTime, '12:15');
  assert.equal(exact.arrivalTime, '02:40');
  assert.equal(exact.runningDays, '1111111');
  assert.equal(exact.sourceDayNumber, undefined);
  assert.equal(exact.destinationDayNumber, undefined);
  assert.ok(!('journeyDate' in exact));
});
test('train origin/final destination are separate from boarding/drop stations', () => {
  const train = normalizeTrainSearch(observed, request).trains[0];
  assert.equal(train.sourceStationCode, 'LGH');
  assert.equal(train.sourceStationName, 'Lalgarh Jn');
  assert.equal(train.destinationStationCode, 'DBRG');
  assert.equal(train.destinationStationName, 'Dibrugarh');
  assert.equal(train.fromStationCode, 'DLI');
  assert.equal(train.fromStationName, 'Delhi');
  assert.equal(train.toStationCode, 'SV');
  assert.equal(train.toStationName, 'Siwan Jn');
});
test('DLI and synthetic ANVT variant remain normalized but are not exact NDLS candidates', () => {
  // The user observed ANVT too but did not supply its full record; this variant is synthetic.
  const payload = { ...observed, data: [...observed.data, { ...observed.data[0], train_no: '99999', from_stn_code: 'ANVT', from_stn_name: 'Anand Vihar' }] };
  const before = JSON.stringify(payload);
  const result = normalizeTrainSearch(payload, request);
  assert.deepEqual(result.trains.map((t) => t.fromStationCode), ['DLI', 'NDLS', 'ANVT']);
  assert.deepEqual(selectTrains(result, request, ['3A'], 4).map((t) => t.trainNumber), ['02570']);
  assert.equal(result.trains.length, 3);
  assert.equal(JSON.stringify(payload), before);
});
test('alternate-only success stays SUCCESS even when exact selection is empty', () => {
  const result = normalizeTrainSearch({ ...observed, data: [observed.data[0]] }, request);
  assert.equal(result.providerState, 'SUCCESS');
  assert.equal(result.trains.length, 1);
  assert.deepEqual(selectTrains(result, request, ['3A'], 4), []);
});
test('travel duration parsing is defensive and keeps original text', () => {
  for (const text of ['unknown', '14:99 hrs', '99999999999999999999:25 hrs']) {
    const result = normalizeTrainSearch({ success: true, data: [{ ...observed.data[1], travel_time: text }] }, request);
    assert.equal(result.providerState, 'SUCCESS');
    assert.equal(result.trains[0].travelTimeText, text);
    assert.equal(result.trains[0].durationMinutes, undefined);
  }
});
test('missing optional observed fields do not acquire invented values', () => {
  const result = normalizeTrainSearch({ success: true, data: [{ train_no: '02570', train_name: 'Train', from_stn_code: 'NDLS', to_stn_code: 'SV' }] }, request);
  assert.equal(result.providerState, 'SUCCESS');
  assert.equal(result.trains[0].haltCount, undefined);
  assert.equal(result.trains[0].distanceKm, undefined);
  assert.equal(result.trains[0].travelTimeText, undefined);
});
test('malformed discovery structures remain controlled provider errors', () => {
  for (const payload of [null, { success: true, data: {} }, { success: true, data: [null] },
    { success: true, data: [{ ...observed.data[0], from_stn_code: null }] }]) {
    assert.equal(normalizeTrainSearch(payload, request).providerState, 'PROVIDER_ERROR');
  }
});
function fake(discovery: TrainSearchResult, calls: string[]): RailwayProvider {
  return {
    async searchTrainsBetweenStations() { return discovery; },
    async getTrainInfo() { throw new Error('No route required for this test.'); },
    async getAvailability(r) { calls.push(`${r.trainNumber}:${r.fromStationCode}:${r.toStationCode}`);
      return { request: r, provider: 'railkit', providerState: 'SUCCESS', days: [{ date: r.journeyDate, state: 'AVAILABLE' }] }; },
  };
}
test('connection search counts exact discoveries and checks only exact endpoints', async () => {
  const calls: string[] = [];
  const result = await new ConnectionSearchEngine(fake(normalizeTrainSearch(observed, request), calls))
    .search({ ...request, classes: ['3A'], quota: 'GN' }, { budget: { maxResults: 1 } });
  assert.equal(result.diagnostics.providerErrorCount, 0);
  assert.equal(result.diagnostics.directTrainsDiscovered, 1);
  assert.deepEqual(calls, ['02570:NDLS:SV']);
  assert.equal(result.results[0].type, 'DIRECT');
});
test('alternate-only connection discovery is not a provider error', async () => {
  const calls: string[] = [];
  const result = await new ConnectionSearchEngine(fake(normalizeTrainSearch({ ...observed, data: [observed.data[0]] }, request), calls))
    .search({ ...request, classes: ['3A'], quota: 'GN' });
  assert.equal(result.diagnostics.providerErrorCount, 0);
  assert.equal(result.diagnostics.directTrainsDiscovered, 0);
  assert.deepEqual(calls, []);
});
test('failed direct discovery reports the explicit missing-seed reason', async () => {
  const calls: string[] = [];
  const result = await new ConnectionSearchEngine(fake({ provider: 'railkit', providerState: 'PROVIDER_ERROR', trains: [] }, calls))
    .search({ ...request, classes: ['3A'], quota: 'GN' });
  assert.equal(result.diagnostics.providerErrorCount, 1);
  assert.equal(result.diagnostics.earlyStopReason, 'DIRECT_DISCOVERY_FAILED_NO_CONNECTION_SEEDS');
  assert.deepEqual(calls, []);
});
