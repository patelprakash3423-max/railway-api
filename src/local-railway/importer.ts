import {stationCode} from './station-code.js';
export {stationCode} from './station-code.js';
import { readCsv } from './csv.js';
import { parseRunningDays } from './calendar.js';
import { RailwayDatabase } from './database.js';
import type { LocalDataset, LocalStation, LocalTrain, LocalTrainStop } from './types.js';
export interface ImportOptions { trains: string; stops: string; stations?: string; sourceGeneratedAt?: string; label?: string; excludedTrains?: { number: string; reason: string }[] }
function required(v: string | undefined, field: string): string { if (!v) throw new Error(`Missing ${field}`); return v; }
function trainNumber(v: string): string { if (!/^\d{1,5}$/.test(v)) throw new Error(`Invalid train number ${v}`); return v.padStart(5, '0'); }
function integer(v: string, field: string): number { if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) throw new Error(`Invalid ${field}: ${v}`); return Number(v); }
function numeric(v: string | undefined, field: string, min = 0, max = Infinity): number | undefined {
  if (!v) return undefined;
  if (!/^-?\d+(?:\.\d+)?$/.test(v)) throw new Error(`Invalid ${field}: ${v}`);
  const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid ${field}: ${v}`); return n;
}
function time(v: string | undefined): string | undefined {
  if (!v || v === '--' || v === '-') return undefined;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`Invalid time: ${v}`);
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}
const clock = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
/** Strict import: any malformed record aborts the complete replacement; no silently truncated routes. */
export function readDataset(options: ImportOptions): LocalDataset {
  const stations = new Map<string, LocalStation>(), trains = new Map<string, LocalTrain>(), stops: LocalTrainStop[] = [];
  const errors: string[] = [];
  let haltMismatchCount = 0;
  const haltMismatchTrains = new Set<string>();
  const excluded = new Map<string, string>();
  for (const item of options.excludedTrains ?? []) {
    const number = trainNumber(item.number);
    if (excluded.has(number)) throw new Error(`Duplicate excluded train ${number}`);
    excluded.set(number, required(item.reason?.trim(), 'exclusion reason'));
  }
  const excludedFound = new Set<string>(); let excludedStopCount = 0;
  const unnamedStations = new Set<string>();
  const stationName = (code: string, name: string | undefined) => { if (!name) unnamedStations.add(code); return name || code; };
  const each = (path: string, headers: string[], fn: (r: Record<string, string>) => void) => {
    for (const r of readCsv(path, headers)) { try { fn(r); } catch (error) { errors.push(`${path}: record ${r.__record}: ${(error as Error).message}`); } }
  };
  if (options.stations) each(options.stations, ['code', 'name'], r => {
    const code = stationCode(r.code); if (stations.has(code)) throw new Error(`Duplicate station ${code}`);
    stations.set(code, { code, name: stationName(code, r.name), latitude: numeric(r.lat, 'latitude', -90, 90), longitude: numeric(r.lon, 'longitude', -180, 180) });
  });
  each(options.trains, ['number', 'name', 'runs_days', 'source_code', 'dest_code'], r => {
    const number = trainNumber(r.number);
    if (excluded.has(number)) { excludedFound.add(number); return; }
    if (trains.has(number)) throw new Error(`Duplicate train ${number}`);
    trains.set(number, { number, name: required(r.name, 'train name'), type: r.type || undefined, sourceCode: stationCode(r.source_code), destinationCode: stationCode(r.dest_code), runningDaysRaw: r.runs_days, runningDays: parseRunningDays(r.runs_days) });
  });
  const seen = new Set<string>();
  each(options.stops, ['train_number', 'seq', 'station_code', 'station_name', 'day', 'arrival', 'departure'], r => {
    const number = trainNumber(r.train_number);
    if (excluded.has(number)) { excludedStopCount++; return; }
    const code = stationCode(r.station_code), sequence = integer(r.seq, 'sequence');
    if (!trains.has(number)) throw new Error(`Unknown train ${number}`);
    const key = `${number}:${sequence}`; if (seen.has(key)) throw new Error(`Duplicate stop sequence ${key}`);
    const stop: LocalTrainStop = { trainNumber: number, stationCode: code, sequence, dayOffset: integer(r.day, 'day'), arrivalTime: time(r.arrival), departureTime: time(r.departure), distanceKm: numeric(r.distance_km, 'distance') };
    const name = stationName(code, r.station_name);
    // Stops are authoritative membership; stations.csv is optional enrichment, never a whitelist.
    if (!stations.has(code)) stations.set(code, { code, name });
    // NTES Day is the departure day for a midnight-spanning halt (observed
    // 00170/SWV: arrival 23:50, departure 00:20, Day 2, halt_min 30).
    // Only resolve differing event days when the exported halt proves the clocks.
    const halt = numeric(r.halt_min, 'halt minutes');
    if (stop.arrivalTime && stop.departureTime && halt !== undefined) {
      if (!Number.isSafeInteger(halt)) throw new Error('Halt minutes must be an integer');
      const end = clock(stop.arrivalTime) + halt;
      if (end % 1440 !== clock(stop.departureTime)) {
        // Informational source halt can disagree with otherwise valid clocks.
        // Do not use contradictory evidence to infer or repair event days.
        haltMismatchCount++; haltMismatchTrains.add(number);
      } else {
        const days = Math.floor(end / 1440);
        if (days) stop.arrivalDayOffset = stop.dayOffset - days;
      }
    }
    stops.push(stop); seen.add(key);
  });
  const byTrain = new Map<string, LocalTrainStop[]>();
  for (const s of stops) { const list = byTrain.get(s.trainNumber) ?? []; list.push(s); byTrain.set(s.trainNumber, list); }
  for (const train of trains.values()) {
    try {
      const route = (byTrain.get(train.number) ?? []).sort((a, b) => a.sequence - b.sequence);
      if (route.length < 2) throw new Error('At least two stops required');
      if (route[0].stationCode !== train.sourceCode || route.at(-1)!.stationCode !== train.destinationCode) throw new Error('Route endpoints differ from train endpoints');
      const base = route[0].dayOffset;
      if (base !== 0 && base !== 1) throw new Error('Origin day must be 0 or 1');
      let previousTime = -1, previousDistance = -1;
      for (let i = 0; i < route.length; i++) {
        const s = route[i]; s.dayOffset -= base;
        if (s.arrivalDayOffset !== undefined) s.arrivalDayOffset -= base;
        if (s.dayOffset < 0 || (i > 0 && s.sequence !== route[i - 1].sequence + 1)) throw new Error('Noncontiguous sequence or invalid day');
        if ((i > 0 && !s.arrivalTime) || (i < route.length - 1 && !s.departureTime)) throw new Error(`Missing critical time at sequence ${s.sequence}`);
        for (const [t, offset] of [[s.arrivalTime, s.arrivalDayOffset ?? s.dayOffset], [s.departureTime, s.dayOffset]] as const) if (t) {
          if (offset < 0) throw new Error(`Invalid arrival day at sequence ${s.sequence}`);
          const absolute = offset * 1440 + clock(t);
          if (absolute < previousTime) throw new Error(`Backwards/ambiguous timetable at sequence ${s.sequence}`);
          previousTime = absolute;
        }
        if (s.distanceKm !== undefined) { if (s.distanceKm < previousDistance) throw new Error('Decreasing distance'); previousDistance = s.distanceKm; }
      }
    } catch (error) { errors.push(`Train ${train.number}: ${(error as Error).message}`); }
  }
  for (const number of excluded.keys()) if (!excludedFound.has(number)) errors.push(`Excluded train ${number} not found in source`);
  if (!trains.size || !stops.length) errors.push('Empty dataset');
  if (options.sourceGeneratedAt && (!/^\d{4}-\d{2}-\d{2}T/.test(options.sourceGeneratedAt) || !Number.isFinite(Date.parse(options.sourceGeneratedAt)))) errors.push('Invalid sourceGeneratedAt: use ISO timestamp');
  if (errors.length) throw new Error(`Import rejected: ${errors.length} error(s); existing dataset unchanged.\n${errors.slice(0, 30).join('\n')}${errors.length > 30 ? '\nFurther errors omitted' : ''}`);
  return { stations: [...stations.values()].sort((a,b) => a.code.localeCompare(b.code)), trains: [...trains.values()].sort((a,b) => a.number.localeCompare(b.number)), stops: stops.sort((a,b) => a.trainNumber.localeCompare(b.trainNumber) || a.sequence - b.sequence), metadata: { source: 'RAILPULL_NTES', haltMismatchCount, haltMismatchTrainCount: haltMismatchTrains.size, excludedTrainCount: excluded.size, excludedStopCount, importedAt: new Date().toISOString(), sourceGeneratedAt: options.sourceGeneratedAt, label: options.label, ...(excluded.size ? { excludedTrains: [...excluded].sort(([a],[b]) => a.localeCompare(b)).map(([number, reason]) => ({ number, reason })), excludedStopCount } : {}), ...(unnamedStations.size ? { warnings: [...unnamedStations].sort().map(code => `Station ${code}: missing name; using code as label`) } : {}), trainCount: trains.size, stationCount: stations.size, stopCount: stops.length } };
}
export function importRailway(database: RailwayDatabase, options: ImportOptions) {
  const data = readDataset(options); database.replace(data); return data.metadata;
}
