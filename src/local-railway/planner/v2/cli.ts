import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { RailwayDatabase } from '../../database.js';
import { LocalJourneyPlannerV2 } from './planner.js';
import { defaultV2Limits, type V2Limits } from './types.js';
let database: RailwayDatabase | undefined;
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: { db: { type: 'string', default: 'data/local-railway/railway.sqlite' }, json: { type: 'boolean' }, 'max-changes': { type: 'string' }, ...Object.fromEntries(Object.keys(defaultV2Limits).map(k => [k, { type: 'string' as const }])) } });
  if (positionals.length !== 3) throw new Error('Usage: railway:plan:v2 -- FROM TO DD-MM-YYYY [--json] [--db FILE]');
  const limits: Partial<V2Limits> = {};
  for (const key of Object.keys(defaultV2Limits) as (keyof V2Limits)[]) { const value = (values as Record<string, string | boolean | undefined>)[key]; if (value !== undefined) limits[key] = Number(value); }
  database = new RailwayDatabase(resolve(String(values.db)), true);
  const result = new LocalJourneyPlannerV2(database, limits).search({ from: positionals[0], to: positionals[1], date: positionals[2], maxChanges: values['max-changes'] === undefined ? undefined : Number(values['max-changes']) });
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Planner V2: ${positionals[0]} → ${positionals[1]} / ${positionals[2]}\nDataset: ${result.dataset.label}\nScheduled candidates only\n${result.journeys.length} journeys`);
    result.journeys.forEach((j, i) => {
      console.log(`\n${i + 1}. ${j.changes} changes; ${j.durationMinutes} min; ${j.totalDistanceKm} km; distance detour ${j.distanceDetourPercent.toFixed(1)}%; duration detour ${j.durationDetourPercent.toFixed(1)}%; tiers ${j.interchangeTiers.join('/') || 'direct'}`);
      j.segments.forEach((s, k) => { if (k) console.log(`   Transfer ${j.connections[k - 1].minutes} min (${j.connections[k - 1].safety})`); console.log(`   ${s.trainNumber}: ${s.fromStation} ${s.boardingDateTime} → ${s.toStation} ${s.arrivalDateTime}`); });
    });
    console.log(`\nDiagnostics: ${JSON.stringify(result.diagnostics)}`);
  }
} catch (error) { console.error((error as Error).message); process.exitCode = 1; }
finally { database?.close(); }
