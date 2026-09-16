import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createRouter } from '../api/router.js';
import { JourneySearchService } from '../application/journey-search-service.js';
import type { RailwayProvider } from '../providers/railway-provider.js';

for (const [from, to] of [['NDLS', 'SV'], ['LKO', 'BSB'], ['BPL', 'NGP'], ['MAS', 'SBC'], ['CNB', 'PRYJ'], ['ADI', 'BRC'], ['PUNE', 'SUR'], ['AII', 'JP'], ['NDLS', 'BCT'], [' lko ', 'bsb'], ['bpl', ' BPL ']]) {
  test(`generic HTTP search ${from} → ${to} validates and forwards exact stations`, async () => {
    const calls: unknown[] = [];
    const provider: RailwayProvider = {
      async searchTrainsBetweenStations(request) { calls.push(request); return { provider: 'fake', providerState: 'SUCCESS', trains: [] }; },
      async getTrainInfo() { throw new Error('Unexpected info call'); },
      async getAvailability() { throw new Error('Unexpected availability call'); },
    };
    const router = createRouter(new JourneySearchService(provider, { logger: () => {} }), { logger: () => {} });
    const reply = await router({ method: 'POST', path: '/api/v1/journeys/search', contentType: 'application/json',
      body: JSON.stringify({ from, to, date: '20-09-2099', classes: ['3A', 'SL', '2A'], quota: 'GN', searchMode: 'STANDARD' }) });
    if (from.trim().toUpperCase() === to.trim().toUpperCase()) {
      assert.equal(reply.status, 400); assert.equal(JSON.parse(reply.body).error.code, 'INVALID_STATION'); assert.deepEqual(calls, []);
    } else {
      assert.equal(reply.status, 200);
      assert.equal(JSON.parse(reply.body).search.from, from.trim().toUpperCase());
      assert.equal(JSON.parse(reply.body).search.to, to.trim().toUpperCase());
      assert.deepEqual(calls, [{ fromStationCode: from.trim().toUpperCase(), toStationCode: to.trim().toUpperCase(), journeyDate: '20-09-2099', classes: ['3A', 'SL', '2A'], quota: 'GN' }]);
      assert.equal(JSON.parse(reply.body).meta.searchCompleted, true);
    }
  });
}
test('backend production sources contain no reference-route literals', async () => {
  async function inspect(dir: URL): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'tests') continue;
      const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
      if (entry.isDirectory()) await inspect(path);
      else if (entry.name.endsWith('.ts')) assert.doesNotMatch(await readFile(path, 'utf8'), /\b(?:NDLS|SV|ASH|GKP|02564|15566|Delhi|Siwan)\b/i, path.pathname);
    }
  }
  await inspect(new URL('../', import.meta.url));
});
