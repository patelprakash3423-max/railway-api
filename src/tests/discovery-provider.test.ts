import test from 'node:test';
import assert from 'node:assert/strict';
import { RailKitProvider } from '../providers/railkit/railkit-provider.js';
import { resetApiCallCount, getApiCallCount } from '../utils/api-call-counter.js';
// The installed SDK is exercised against a replaced fetch. No network is used.
test('installed discovery SDK forwards date, normalizes documented payload, counts one call and does not retry', async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.RAILKIT_API_KEY;
  process.env.RAILKIT_API_KEY = 'offline-discovery-test-only';
  const urls: string[] = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ success: true, data: [{ train_no: '12345', train_name: 'Fixture',
      from_stn_code: 'AAA', to_stn_code: 'ZZZ', from_time: '20:00', to_time: '02:00', travel_time: '06:00 hrs' }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  resetApiCallCount();
  try {
    const provider = new RailKitProvider();
    const request = { fromStationCode: 'AAA', toStationCode: 'ZZZ', journeyDate: '15-09-2099' };
    const result = await provider.searchTrainsBetweenStations(request);
    assert.equal(result.providerState, 'SUCCESS');
    assert.equal(result.trains[0].durationMinutes, 360);
    assert.equal(urls.length, 1);
    assert.equal(new URL(urls[0]).searchParams.get('date'), request.journeyDate);
    assert.equal(getApiCallCount(), 1);
    const invalid = await provider.searchTrainsBetweenStations({ ...request, journeyDate: '31-02-2099' });
    assert.equal(invalid.providerState, 'PROVIDER_ERROR');
    assert.equal(getApiCallCount(), 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.RAILKIT_API_KEY; else process.env.RAILKIT_API_KEY = previousKey;
    resetApiCallCount();
  }
});
