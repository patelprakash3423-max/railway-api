import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createRouter } from '../api/router.js';
import { readBody } from '../api/server.js';
import { JourneySearchService, type ServiceOptions } from '../application/journey-search-service.js';
import { searchModeConfig } from '../application/search-mode.js';
import { connectionDiagnostics } from '../journey/connection/types.js';
import type { RailwayProvider } from '../providers/railway-provider.js';
import type { JourneyResult } from '../journey/types/journey-result.js';
import { apiConfig } from '../config/api.js';
const input = { from: 'NDLS', to: 'SV', date: '20-09-2099' };
function fake() {
  let calls = 0;
  const provider: RailwayProvider = {
    async searchTrainsBetweenStations() { calls++; return { provider: 'fake', providerState: 'SUCCESS', trains: [] }; },
    async getTrainInfo() { calls++; throw new Error('offline'); },
    async getAvailability(r) { calls++; return { request: r, provider: 'railkit', providerState: 'SUCCESS', days: [] }; },
  };
  return { provider, count: () => calls };
}
const segment = { trainNumber: '02564', fromStationCode: 'NDLS', toStationCode: 'SV', journeyDate: input.date,
  travelClass: '3A' as const, availabilityState: 'AVAILABLE' as const, availabilityText: 'AVL 358', fare: { totalFare: 1625, currency: 'INR' as const } };
const direct: JourneyResult = { type: 'DIRECT', trainNumber: '02564', segments: [segment], totalFare: 1625, totalLiveAvailabilityCallsUsed: 10 };
const connection: JourneyResult = { type: 'DIFFERENT_TRAIN_CONNECTION', connectionStationCode: 'ASH', connectionStationName: 'Aishbagh', connectionMinutes: 170,
  connectionSafety: 'GOOD', totalScheduledDurationMinutes: 1050, totalFare: 2095, totalLiveAvailabilityCallsUsed: 16,
  segments: [{ ...segment, toStationCode: 'ASH' }, { ...segment, trainNumber: '15566', fromStationCode: 'ASH', journeyDate: '21-09-2099', travelClass: '2A' }] };
function setup(results: JourneyResult[] = [], options: ServiceOptions = {}) {
  const f = fake();
  const service = new JourneySearchService(f.provider, { logger: () => {}, engineFactory: () => ({ async search() {
    return { results, diagnostics: connectionDiagnostics() };
  } }), ...options });
  return { ...f, service, router: createRouter(service, { logger: () => {} }) };
}
async function post(router: ReturnType<typeof createRouter>, body: unknown = input) {
  return router({ method: 'POST', path: '/api/v1/journeys/search', contentType: 'application/json', body: JSON.stringify(body) });
}
test('health returns 200 with zero provider calls and matching generated request ID', async () => {
  const s = setup(); const reply = await s.router({ method: 'GET', path: '/health' });
  assert.equal(reply.status, 200); assert.equal(s.count(), 0);
  assert.equal(JSON.parse(reply.body).status, 'ok');
  assert.match(reply.headers['X-Request-Id'], /^[a-f0-9-]{36}$/);
  assert.equal(JSON.parse(reply.body).requestId, reply.headers['X-Request-Id']);
});
test('DIRECT HTTP serialization includes only public fields', async () => {
  const s = setup([direct]); const reply = await post(s.router); const body = JSON.parse(reply.body);
  assert.equal(reply.status, 200); assert.equal(body.results[0].trainNumber, '02564');
  assert.equal(body.results[0].segments[0].fare.totalFare, 1625);
  assert.equal(body.results[0].totalLiveAvailabilityCallsUsed, undefined);
  assert.equal(body.debug, undefined); assert.equal(body.requestId, reply.headers['X-Request-Id']);
});
test('connection metadata, next-day boarding and mixed classes survive serialization', async () => {
  const reply = await post(setup([connection]).router); const result = JSON.parse(reply.body).results[0];
  assert.equal(result.connection.stationCode, 'ASH'); assert.equal(result.connection.minutes, 170);
  assert.equal(result.connection.safety, 'GOOD'); assert.equal(result.connection.stationName, 'Aishbagh');
  assert.equal(result.segments[1].journeyDate, '21-09-2099'); assert.equal(result.segments[1].travelClass, '2A');
  assert.equal(result.totalFare, 2095);
});
test('missing fare remains absent', async () => {
  const reply = await post(setup([{ ...direct, totalFare: undefined, segments: [{ ...segment, fare: undefined }] }]).router);
  const result = JSON.parse(reply.body).results[0]; assert.ok(!('totalFare' in result)); assert.ok(!('fare' in result.segments[0]));
});
for (const [name, patch, code] of [
  ['same stations', { to: 'ndls' }, 'INVALID_STATION'], ['missing source', { from: undefined }, 'INVALID_STATION'],
  ['missing destination', { to: undefined }, 'INVALID_STATION'], ['invalid station', { from: 'A!B' }, 'INVALID_STATION'],
  ['missing date', { date: undefined }, 'INVALID_DATE'], ['date format', { date: '2099-09-20' }, 'INVALID_DATE'],
  ['impossible date', { date: '31-02-2099' }, 'INVALID_DATE'], ['past date', { date: '01-01-2000' }, 'INVALID_DATE'],
  ['unsupported class', { classes: ['BAD'] }, 'INVALID_CLASS'], ['class string', { classes: '3A' }, 'INVALID_CLASS'],
  ['empty classes', { classes: [] }, 'INVALID_CLASS'], ['quota', { quota: 'TQ' }, 'UNSUPPORTED_QUOTA'],
  ['mode', { searchMode: 'UNBOUNDED' }, 'INVALID_SEARCH_MODE'],
] as const) {
  test(`validation rejects ${name} without provider calls`, async () => {
    const s = setup(); const reply = await post(s.router, { ...input, ...patch });
    assert.equal(reply.status, 400); assert.equal(JSON.parse(reply.body).error.code, code); assert.equal(s.count(), 0);
  });
}
test('lowercase/whitespace stations normalize, classes deduplicate, defaults apply', async () => {
  const s = setup(); const response = await s.service.search({ ...input, from: ' ndls ', to: ' sv ', classes: ['3A','3A','SL'] });
  assert.deepEqual(response.search, { ...input, classes: ['3A','SL'], quota: 'GN', mode: 'STANDARD' });
  assert.deepEqual((await s.service.search(input)).search.classes, ['3A','SL','2A']);
});
for (const [mode, availability, stations] of [['QUICK',12,1], ['STANDARD',30,3], ['DEEP',40,4]] as const) {
  test(`${mode} service maps fresh bounded config to engine`, async () => {
    const f = fake(); let observed = false;
    const service = new JourneySearchService(f.provider, { logger: () => {}, engineFactory: () => ({ async search(request, options) {
      assert.equal(request.fromStationCode, 'NDLS'); assert.equal(request.quota, 'GN');
      assert.equal(options.budget?.maxAvailabilityCalls, availability); assert.equal(options.budget?.maxConnectionStations, stations);
      observed = true; return { results: [], diagnostics: connectionDiagnostics() };
    } }) });
    await service.search({ ...input, searchMode: mode }); assert.equal(observed, true);
    const config = searchModeConfig(mode); config.budget!.maxAvailabilityCalls = 999;
    assert.equal(searchModeConfig(mode).budget!.maxAvailabilityCalls, availability);
  });
}
test('real engine with fake empty discovery returns 200 not 503', async () => {
  const f = fake(); const reply = await post(createRouter(new JourneySearchService(f.provider, { logger: () => {} })));
  assert.equal(reply.status, 200); assert.equal(JSON.parse(reply.body).meta.resultCount, 0); assert.equal(f.count(), 1);
});
test('provider failure preventing discovery returns 503 with safe message', async () => {
  const f = fake(); f.provider.searchTrainsBetweenStations = async () => { throw new Error('private provider stack'); };
  const reply = await post(createRouter(new JourneySearchService(f.provider, { logger: () => {} })));
  assert.equal(reply.status, 503); assert.ok(!reply.body.includes('private'));
});
test('internal exceptions expose no stack or internal message', async () => {
  const s = setup([], { engineFactory: () => ({ async search() { throw new Error('private stack secret'); } }) });
  const reply = await post(s.router); assert.equal(reply.status, 500); assert.ok(!reply.body.includes('private'));
  assert.equal(JSON.parse(reply.body).error.code, 'INTERNAL_ERROR');
});
test('debug is opt-in and exposes only the small allowlist', async () => {
  const reply = await post(setup([], { enableDiagnostics: true }).router);
  assert.deepEqual(Object.keys(JSON.parse(reply.body).debug).sort(), ['availabilityCalls','cacheHits','providerCalls']);
});
test('API key and raw provider fields never enter public payloads or logs', async () => {
  const old = process.env.RAILKIT_API_KEY; process.env.RAILKIT_API_KEY = 'offline-private-marker';
  const logs: unknown[] = [];
  try {
    const s = setup([{ ...direct, segments: [{ ...segment, availabilityText: 'offline-private-marker' }], rawRailKit: 'PRIVATE_RAW' } as JourneyResult], { logger: (r) => logs.push(r) });
    const reply = await post(s.router);
    assert.ok(!reply.body.includes('offline-private-marker')); assert.ok(!reply.body.includes('PRIVATE_RAW'));
    assert.ok(!JSON.stringify(logs).includes('offline-private-marker'));
  } finally { if (old === undefined) delete process.env.RAILKIT_API_KEY; else process.env.RAILKIT_API_KEY = old; }
});
test('invalid JSON and media type fail before service calls', async () => {
  const s = setup();
  for (const request of [{ contentType: 'application/json', body: '{' }, { contentType: 'text/plain', body: '{}' }]) {
    const reply = await s.router({ method: 'POST', path: '/api/v1/journeys/search', ...request }); assert.equal(reply.status, 400);
  }
  assert.equal(s.count(), 0);
});
test('body limit counts streamed bytes and rejects oversized JSON', async () => {
  await assert.rejects(readBody(Readable.from([Buffer.alloc(16000), Buffer.alloc(1000)])), { status: 413 });
  assert.equal(await readBody(Readable.from(['{"a":', '1}'])), '{"a":1}');
  const reply = await setup().router({ method: 'POST', path: '/api/v1/journeys/search', contentType: 'application/json', body: ' '.repeat(17000) });
  assert.equal(reply.status, 413);
});
test('unknown paths return 404 and known paths with wrong methods return 405', async () => {
  const router = setup().router;
  assert.equal((await router({ method: 'GET', path: '/missing' })).status, 404);
  assert.equal((await router({ method: 'GET', path: '/api/v1/journeys/search' })).status, 405);
});
test('CORS accepts only configured origin without credentials or wildcard', async () => {
  const router = createRouter(setup().service, { corsOrigin: 'http://localhost:3000' });
  const allowed = await router({ method: 'OPTIONS', path: '/api/v1/journeys/search', origin: 'http://localhost:3000' });
  assert.equal(allowed.headers['Access-Control-Allow-Origin'], 'http://localhost:3000');
  assert.equal(allowed.headers['Access-Control-Allow-Credentials'], undefined);
  const other = await router({ method: 'GET', path: '/health', origin: 'http://other.test' });
  assert.equal(other.headers['Access-Control-Allow-Origin'], undefined);
});
test('API env config defaults and diagnostics validation', () => {
  assert.equal(apiConfig({}).port, 4000); assert.equal(apiConfig({}).enableDiagnostics, false);
  assert.equal(apiConfig({ ENABLE_API_DIAGNOSTICS: 'true' }).enableDiagnostics, true);
  assert.throws(() => apiConfig({ CORS_ORIGIN: '*' })); assert.throws(() => apiConfig({ PORT: 'bad' }));
});
test('concurrent service searches keep per-request counts and log correlation isolated', async () => {
  const f = fake(); const logs: Record<string, unknown>[] = [];
  const service = new JourneySearchService(f.provider, { enableDiagnostics: true, logger: (r) => logs.push(r) });
  const results = await Promise.all([service.search(input, 'one'), service.search(input, 'two')]);
  assert.equal(f.count(), 2); assert.deepEqual(results.map((r) => r.debug?.providerCalls), [1,1]);
  assert.deepEqual(logs.map((r) => r.externalCallCount), [1,1]); assert.ok(logs.every((r) => typeof r.elapsedMs === 'number'));
});

test('HTTP adapter handles request streams and generates IDs independently of client headers', async () => {
  const { createHttpHandler } = await import('../api/server.js');
  const request = Object.assign(Readable.from([JSON.stringify(input)]), { socket:{remoteAddress:'127.0.0.1'},method: 'POST', url: '/api/v1/journeys/search', headers: { 'content-type': 'application/json', 'x-request-id': 'untrusted-client-id' } });
  let status = 0; let headers: Record<string, string> = {}; let payload = '';
  const response = { once:()=>{},removeListener:()=>{},writeHead(code: number, values: Record<string,string>) { status = code; headers = values; }, end(body: string) { payload = body; } };
  await createHttpHandler(setup([direct]).service)(request as unknown as import('node:http').IncomingMessage, response as unknown as import('node:http').ServerResponse);
  assert.equal(status, 200); assert.notEqual(headers['X-Request-Id'], 'untrusted-client-id');
  assert.equal(JSON.parse(payload).requestId, headers['X-Request-Id']);
});
test('HTTP adapter returns 413 on streamed excess without invoking search', async () => {
  const { createHttpHandler } = await import('../api/server.js');
  const request = Object.assign(Readable.from([Buffer.alloc(17000)]), { socket:{remoteAddress:'127.0.0.1'},method: 'POST', url: '/api/v1/journeys/search', headers: { 'content-type': 'application/json' } });
  let status = 0; let payload = ''; let searches = 0;
  const response = { once:()=>{},removeListener:()=>{},writeHead(code: number) { status = code; }, end(body: string) { payload = body; } };
  await createHttpHandler({ async search() { searches++; throw new Error('unexpected'); } }, { logger: () => {} })(request as unknown as import('node:http').IncomingMessage, response as unknown as import('node:http').ServerResponse);
  assert.equal(status, 413); assert.equal(searches, 0); assert.equal(JSON.parse(payload).error.code, 'INVALID_REQUEST');
});
test('all failed availability requests produce 503; WAITLIST remains a valid empty 200', async () => {
  for (const state of ['PROVIDER_ERROR', 'SUCCESS'] as const) {
    const f = fake();
    f.provider.searchTrainsBetweenStations = async () => ({ provider: 'fake', providerState: 'SUCCESS', trains: [{ trainNumber: '12345', trainName: 'Fixture', fromStationCode: 'NDLS', toStationCode: 'SV', departureTime: '08:00', arrivalTime: '12:00', durationMinutes: 240 }] });
    f.provider.getAvailability = async (r) => ({ request: r, provider: 'railkit', providerState: state, days: state === 'SUCCESS' ? [{ date: r.journeyDate, state: 'WAITLIST' }] : [] });
    const reply = await post(createRouter(new JourneySearchService(f.provider, { logger: () => {} })));
    assert.equal(reply.status, state === 'SUCCESS' ? 200 : 503);
  }
});
test('bounded incomplete searches expose partial meta without default internal diagnostics', async () => {
  const s = setup([direct], { engineFactory: () => ({ async search() { return { results: [direct], diagnostics: { ...connectionDiagnostics(), availabilityBudgetExhausted: true } }; } }) });
  const response = await s.service.search(input);
  assert.equal(response.meta.searchCompleted, false); assert.equal(response.meta.partialResults, true); assert.equal(response.debug, undefined);
});
