import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { RailwayDatabase } from './database.js';
import { importRailway } from './importer.js';
import { LocalJourneyPlanner } from './planner/local-journey-planner.js';
import { defaultBounds, type SearchBounds } from './planner/bounds.js';
const [command, ...args] = process.argv.slice(2);
let database: RailwayDatabase | undefined;
try {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    db: { type: 'string', default: 'data/local-railway/railway.sqlite' }, trains: { type: 'string' }, stops: { type: 'string' }, stations: { type: 'string' },
    'source-generated-at': { type: 'string' }, label: { type: 'string' }, 'exclude-trains': { type: 'string' }, 'max-changes': { type: 'string', default: '2' }, json: { type: 'boolean' },
    ...Object.fromEntries(Object.keys(defaultBounds).map(k => [k, { type: 'string' as const }])),
  } });
  const path = resolve(String(values.db));
  if (command === 'import') {
    if (!values.trains || !values.stops || positionals.length) throw new Error('Usage: railway:import -- --trains FILE --stops FILE [--stations FILE] [--db FILE]');
    mkdirSync(dirname(path), { recursive: true }); database = new RailwayDatabase(path);
    const metadata = importRailway(database, { trains: String(values.trains), stops: String(values.stops), stations: values.stations ? String(values.stations) : undefined, sourceGeneratedAt: values['source-generated-at'] ? String(values['source-generated-at']) : undefined, label: values.label ? String(values.label) : undefined, excludedTrains: values['exclude-trains'] ? JSON.parse(readFileSync(String(values['exclude-trains']), 'utf8')) : undefined });
    console.log(values.json ? JSON.stringify({ database: path, ...metadata }) : `Railway dataset imported\nStations: ${metadata.stationCount}\nTrains: ${metadata.trainCount}\nStops: ${metadata.stopCount}\nExcluded whole trains: ${metadata.excludedTrains?.length ?? 0}\nExcluded stop records: ${metadata.excludedStopCount ?? 0}\nUnexplained skipped records: 0\nDatabase: ${path}\n${metadata.label ?? ''}`);
    if (!values.json && (metadata.warnings?.length || metadata.excludedTrains?.length)) console.log(JSON.stringify({ warnings: metadata.warnings ?? [], excludedTrains: metadata.excludedTrains ?? [] }, null, 2));
  } else if (command === 'plan') {
    if (positionals.length !== 3) throw new Error('Usage: railway:plan -- FROM TO DD-MM-YYYY [--max-changes 0|1|2] [--db FILE] [--json]');
    database = new RailwayDatabase(path, true);
    const bounds: Partial<SearchBounds> = {};
    for (const key of Object.keys(defaultBounds) as (keyof SearchBounds)[]) { const value = (values as Record<string, string | boolean | undefined>)[key]; if (value !== undefined) bounds[key] = Number(value); }
    const result = new LocalJourneyPlanner(database, { bounds }).search({ from: positionals[0], to: positionals[1], date: positionals[2], maxChanges: Number(values['max-changes']) });
    if (values.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Local timetable search: ${positionals[0]} → ${positionals[1]} / ${positionals[2]}\nScheduled candidates only; seats and fares unknown.\nDataset: ${JSON.stringify(result.dataset)}\n${result.journeys.length} scheduled journey candidates`);
      result.journeys.forEach((j, i) => {
        console.log(`\n${i + 1}. ${j.changes} changes; ${Math.floor(j.durationMinutes / 60)}h ${j.durationMinutes % 60}m`);
        j.segments.forEach((s, n) => { if (n) console.log(`   Transfer: ${j.connections[n - 1].minutes} min (${j.connections[n - 1].safety})`); console.log(`   ${s.from} ${s.departureDateTime} — ${s.trainNumber} ${s.trainName} → ${s.to} ${s.arrivalDateTime}`); });
      });
      console.log(`\nDiagnostics: ${JSON.stringify(result.diagnostics)}`);
    }
  } else throw new Error('Expected import or plan command');
} catch (error) { console.error((error as Error).message); process.exitCode = 1; }
finally { database?.close(); }
