import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAvailability, normalizeTrainInfo, normalizeFare } from '../providers/railkit/railkit-normalizers.js';
import type { RailKitAvailabilityResponse, RailKitTrainInfoResponse } from '../providers/railkit/railkit-types.js';
import type { AvailabilityRequest } from '../domain/types/availability.js';
import { getApiCallCount, resetApiCallCount } from '../utils/api-call-counter.js';
import { ProviderError, redact } from '../utils/errors.js';

const request: AvailabilityRequest = {
  trainNumber: '12904', fromStationCode: 'NZM', toStationCode: 'BDTS',
  journeyDate: '15-09-2026', travelClass: '3A', quota: 'GN',
};
const availability = {
  success: true,
  data: {
    train: { trainNo: '12904', trainName: 'GOLDEN TEMPLE M' },
    fare: { baseFare: 1505, reservationCharge: 40, superfastCharge: 45, serviceTax: 80, totalFare: 1670 },
    availability: [{ date: '15-9-2026', status: 'WAITLIST', availabilityText: 'WL 32',
      rawStatus: 'RLWL57/WL32', prediction: '86% Chance', predictionPercentage: 86, canBook: true }],
  },
} satisfies RailKitAvailabilityResponse;
const train = {
  success: true,
  data: {
    trainInfo: {
      train_no: '12554', train_name: 'Fixture train', from_stn_code: 'NDLS', from_stn_name: 'New Delhi',
      to_stn_code: 'SV', to_stn_name: 'Siwan', from_time: '20:00', to_time: '10:00', running_days: '1111111',
    },
    route: [
      { stnCode: 'NDLS', stnName: 'New Delhi', arrival: '--', departure: '20:00', haltMinutes: 0, distance: '0', day: '1', platform: 2 },
      { stnCode: 'SV', stnName: 'Siwan', arrival: '10:00', departure: '--', halt: '5 min', distance: '441', day: '2', platform: '1,2', coordinates: { latitude: 26.2, longitude: 84.3 } },
    ],
  },
} satisfies RailKitTrainInfoResponse;

test('WAITLIST preserves metadata and parses current RLWL number, not original number', () => {
  const result = normalizeAvailability(availability, request);
  assert.equal(result.providerState, 'SUCCESS');
  assert.equal(result.trainName, 'GOLDEN TEMPLE M');
  assert.deepEqual(result.request, request);
  assert.deepEqual(result.days[0], {
    date: '15-09-2026', state: 'WAITLIST', availabilityText: 'WL 32', rawStatus: 'RLWL57/WL32',
    waitlistType: 'RLWL', waitlistNumber: 32, predictionPercentage: 86, canBook: true,
  });
});
test('fare preserves values and does not invent missing components', () => {
  assert.deepEqual(normalizeAvailability(availability, request).fare, { ...availability.data.fare, currency: 'INR' });
  assert.deepEqual(normalizeFare({ totalFare: '0' }), { totalFare: 0, currency: 'INR' });
  assert.throws(() => normalizeFare({}), ProviderError);
});
test('multiple days remain in order and AVAILABLE counts are parsed safely', () => {
  const result = normalizeAvailability({ success: true, data: { availability: [
    availability.data.availability[0],
    { date: '16-9-2026', status: 'AVAILABLE', availabilityText: 'AVAILABLE-42', canBook: true },
    { date: '17-9-2026', status: 'RAC', availabilityText: 'RAC 10' },
    { date: '18-9-2026', status: 'NOT_AVAILABLE' },
  ] } }, request);
  assert.deepEqual(result.days.map((day) => day.state), ['WAITLIST', 'AVAILABLE', 'RAC', 'NOT_AVAILABLE']);
  assert.equal(result.days[1].date, '16-09-2026');
  assert.equal(result.days[1].availableCount, 42);
  assert.equal(result.days[2].availableCount, undefined);
});
test('exact inventory failure is PROVIDER_UNAVAILABLE with no seat statuses', () => {
  const result = normalizeAvailability({ success: false, error: 'Sorry, this train is not available for booking for this date' }, request);
  assert.equal(result.providerState, 'PROVIDER_UNAVAILABLE');
  assert.deepEqual(result.days, []);
});
test('unknown errors, malformed envelopes and unknown statuses are PROVIDER_ERROR', () => {
  for (const response of [null, {}, { success: false, error: 'Unauthorized' },
    { success: true, data: {} }, { success: true, data: { availability: [{ date: '15-9-2026', status: 'NEW_STATUS' }] } }]) {
    const result = normalizeAvailability(response, request);
    assert.equal(result.providerState, 'PROVIDER_ERROR');
    assert.deepEqual(result.days, []);
  }
});
test('unrecognized waitlist format retains raw text without inventing a number', () => {
  const result = normalizeAvailability({ success: true, data: { availability: [
    { date: '15-9-2026', status: 'WAITLIST', rawStatus: 'unrecognized' },
    { date: '16-9-2026', status: 'AVAILABLE', availabilityText: 'AVAILABLE (check later)' },
  ] } }, request);
  assert.equal(result.providerState, 'SUCCESS');
  assert.equal(result.days[0].rawStatus, 'unrecognized');
  assert.equal(result.days[0].waitlistNumber, undefined);
  assert.equal(result.days[1].availableCount, undefined);
});
test('route numbers, null times, platforms, coordinates and running days normalize', () => {
  const result = normalizeTrainInfo(train);
  assert.equal(result.trainNumber, '12554');
  assert.equal(result.route[0].arrivalTime, null);
  assert.equal(result.route[1].departureTime, null);
  assert.equal(result.route[1].distanceKm, 441);
  assert.equal(result.route[1].dayNumber, 2);
  assert.equal(result.route[1].haltMinutes, 5);
  assert.equal(result.route[0].platform, '2');
  assert.equal(result.route[1].platform, '1,2');
  assert.deepEqual(result.route[1].coordinates, { latitude: 26.2, longitude: 84.3 });
  assert.equal(result.runningDays, '1111111');
  assert.throws(() => normalizeTrainInfo({ success: true, data: { trainInfo: {}, route: [] } }), ProviderError);
});
test('normalizers never increment the counter or mutate fixtures', () => {
  resetApiCallCount();
  const before = JSON.stringify({ train, availability, request });
  normalizeTrainInfo(train);
  normalizeAvailability(availability, request);
  normalizeAvailability({ success: false, error: 'failure' }, request);
  assert.equal(getApiCallCount(), 0);
  assert.equal(JSON.stringify({ train, availability, request }), before);
});
test('provider messages and text fields redact secrets', () => {
  const previous = process.env.RAILKIT_API_KEY;
  process.env.RAILKIT_API_KEY = 'offline-redaction-marker';
  try {
    assert.equal(redact('error offline-redaction-marker'), 'error [REDACTED]');
    const result = normalizeAvailability({ success: false, error: 'offline-redaction-marker' }, request);
    // Availability errors now retain only allowlisted classification evidence.
    assert.equal(result.providerMessage, 'Availability provider failure: UNKNOWN_PROVIDER_ERROR.');
    assert.ok(!JSON.stringify(result).includes('offline-redaction-marker'));
  } finally {
    if (previous === undefined) delete process.env.RAILKIT_API_KEY;
    else process.env.RAILKIT_API_KEY = previous;
  }
});
