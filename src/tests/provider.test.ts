import test from 'node:test';
import assert from 'node:assert/strict';
import { RailKitProvider } from '../providers/railkit/railkit-provider.js';
import { getApiCallCount, resetApiCallCount } from '../utils/api-call-counter.js';

// All network calls are intercepted. No real key or provider request is used.
test('provider validates before calls and makes one attempt without retries on failure', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.RAILKIT_API_KEY;
  process.env.RAILKIT_API_KEY = 'offline-test-only';
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('offline network failure');
  };
  try {
    const provider = new RailKitProvider();
    resetApiCallCount();
    const request = { trainNumber: '12904', fromStationCode: 'NZM', toStationCode: 'BDTS', journeyDate: '15-09-2099', travelClass: '3A', quota: 'GN' as const };
    const invalid = await provider.getAvailability({ ...request, trainNumber: 'invalid' });
    assert.equal(invalid.providerState, 'PROVIDER_ERROR');
    assert.equal(getApiCallCount(), 0);
    assert.equal(fetchCalls, 0);
    const result = await provider.getAvailability(request);
    assert.equal(result.providerState, 'PROVIDER_ERROR');
    assert.equal(getApiCallCount(), 1);
    assert.equal(fetchCalls, 1);
    assert.deepEqual(result.days, []);
    resetApiCallCount();
    await assert.rejects(provider.getTrainInfo('12554'), { providerState: 'PROVIDER_ERROR' });
    assert.equal(getApiCallCount(), 1);
    assert.equal(fetchCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.RAILKIT_API_KEY;
    else process.env.RAILKIT_API_KEY = originalKey;
    resetApiCallCount();
  }
});
