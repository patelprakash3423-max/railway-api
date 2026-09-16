import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRouter, type ApiRequest } from '../api/router.js';
import { createHttpHandler } from '../api/server.js';
import { JourneySearchService } from '../application/journey-search-service.js';
import type { RailwayProvider } from '../providers/railway-provider.js';

const origin = 'http://localhost:3000';
const path = '/api/v1/journeys/search';
const preflight: ApiRequest = { method: 'OPTIONS', path, origin };
function setup(corsOrigin: string | undefined = origin) {
  let providerCalls = 0;
  let searchCalls = 0;
  const logs: unknown[] = [];
  const logger = (event: Record<string, unknown>) => { logs.push(event); };
  const provider: RailwayProvider = {
    async searchTrainsBetweenStations() { providerCalls++; return { provider: 'fake', providerState: 'SUCCESS', trains: [] }; },
    async getTrainInfo() { providerCalls++; throw new Error('Unexpected train info call'); },
    async getAvailability() { providerCalls++; throw new Error('Unexpected availability call'); },
  };
  const realService = new JourneySearchService(provider, { logger });
  const service = { async search(...args: Parameters<JourneySearchService['search']>) {
    searchCalls++;
    return realService.search(...args);
  } };
  const options = { corsOrigin, logger };
  return { router: createRouter(service, options), service, options, logs,
    providerCalls: () => providerCalls, searchCalls: () => searchCalls };
}

test('preflight returns 204 with an empty body before content/body validation', async () => {
  const reply = await setup().router({ ...preflight, contentType: 'text/plain', body: '{' });
  assert.equal(reply.status, 204);
  assert.equal(reply.body, '');
});
test('preflight permits exactly the configured origin and varies by Origin', async () => {
  const { headers } = await setup().router(preflight);
  assert.equal(headers['Access-Control-Allow-Origin'], origin);
  assert.equal(headers.Vary, 'Origin');
});
test('preflight allows POST and OPTIONS methods', async () => {
  const { headers } = await setup().router(preflight);
  assert.deepEqual(headers['Access-Control-Allow-Methods'].split(', '), ['POST', 'OPTIONS']);
});
for (const header of ['Content-Type', 'X-Request-Id']) {
  test(`preflight allows ${header}`, async () => {
    const { headers } = await setup().router(preflight);
    assert.ok(headers['Access-Control-Allow-Headers'].split(', ').includes(header));
  });
}
test('preflight consumes zero provider calls', async () => {
  const s = setup(); await s.router(preflight);
  assert.equal(s.providerCalls(), 0);
});
test('preflight never invokes JourneySearchService', async () => {
  const s = setup(); await s.router(preflight);
  assert.equal(s.searchCalls(), 0);
});
test('preflight emits no journey search failure or other search log', async () => {
  const s = setup(); await s.router(preflight);
  assert.deepEqual(s.logs, []);
});
test('POST retains successful search response and allowed-origin headers', async () => {
  const s = setup();
  const reply = await s.router({ method: 'POST', path, origin, contentType: 'application/json',
    body: JSON.stringify({ from: 'NDLS', to: 'SV', date: '20-09-2099' }) });
  assert.equal(reply.status, 200);
  assert.equal(reply.headers['Access-Control-Allow-Origin'], origin);
  assert.equal(JSON.parse(reply.body).meta.searchCompleted, true);
  assert.equal(s.searchCalls(), 1);
  assert.equal(s.providerCalls(), 1); // Offline empty discovery fixture.
});
for (const method of ['GET', 'PUT', 'DELETE']) {
  test(`${method} journey request remains method-not-allowed`, async () => {
    const s = setup(); const reply = await s.router({ method, path, origin });
    assert.equal(reply.status, 405);
    assert.equal(JSON.parse(reply.body).error.code, 'METHOD_NOT_ALLOWED');
    assert.equal(s.searchCalls(), 0);
    assert.equal(s.providerCalls(), 0);
  });
}
for (const scenario of ['disallowed', 'unconfigured', 'missing'] as const) {
  test(`${scenario} origin receives no preflight CORS permission`, async () => {
    const s = setup(scenario === 'unconfigured' ? '' : origin);
    const reply = await s.router({ ...preflight, origin: scenario === 'missing' ? undefined : scenario === 'disallowed' ? 'http://other.test' : origin });
    assert.equal(reply.status, 204);
    assert.equal(reply.headers['Access-Control-Allow-Origin'], undefined);
    assert.equal(reply.headers['Access-Control-Allow-Methods'], undefined);
    assert.equal(reply.headers['Access-Control-Allow-Headers'], undefined);
    assert.equal(reply.headers.Vary, 'Origin');
    assert.equal(s.searchCalls(), 0);
    assert.deepEqual(s.logs, []);
  });
}
test('health remains 200 with request ID and zero search/provider calls', async () => {
  const s = setup(); const reply = await s.router({ method: 'GET', path: '/health', origin });
  assert.equal(reply.status, 200);
  assert.deepEqual(JSON.parse(reply.body), { requestId: reply.headers['X-Request-Id'], status: 'ok' });
  assert.equal(s.searchCalls(), 0);
  assert.equal(s.providerCalls(), 0);
  assert.deepEqual(s.logs, []);
});
test('HTTP adapter handles browser preflight without reading a body or invoking search', async () => {
  const s = setup();
  const request = { once:()=>{},removeListener:()=>{},socket:{remoteAddress:'127.0.0.1'},method: 'OPTIONS', url: path, headers: { origin,
    'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-request-id' },
    iterator() { throw new Error('Preflight body must not be read'); } };
  let status = 0; let body: string | undefined; let headers: Record<string, string> = {};
  const response = { once:()=>{},removeListener:()=>{},writeHead(code: number, values: Record<string, string>) { status = code; headers = values; },
    end(value: string) { body = value; } };
  await createHttpHandler(s.service, s.options)(request as unknown as IncomingMessage, response as unknown as ServerResponse);
  assert.equal(status, 204);
  assert.equal(body, '');
  assert.equal(headers['Access-Control-Allow-Origin'], origin);
  assert.equal(s.searchCalls(), 0);
  assert.equal(s.providerCalls(), 0);
  assert.deepEqual(s.logs, []);
});
