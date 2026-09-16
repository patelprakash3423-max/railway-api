import { RailwayDatabase, stopRow } from '../../database.js';
import type { LocalTrain, LocalTrainStop } from '../../types.js';
import { clockMinutes } from '../../../journey/connection/timing.js';
export type StationTier = 'MAJOR' | 'MEDIUM' | 'SMALL';
export interface StationMetric { trains: number; frequency: number; sourceConnectivity: number; destinationConnectivity: number; score: number; tier: StationTier }
interface Edge { station: string; distance: number; duration: number }
export interface Network { routes: Map<string, LocalTrainStop[]>; trains: Map<string, LocalTrain>; boards: Map<string, LocalTrainStop[]>; metrics: Map<string, StationMetric>; reverse: Map<string, Edge[]> }
const cache = new WeakMap<RailwayDatabase, { version: string; network: Network }>();
export const routeSql = 'SELECT * FROM train_stops ORDER BY train_number,sequence';
export const eventMinute = (s: LocalTrainStop, arrival: boolean) => ((arrival ? s.arrivalDayOffset : undefined) ?? s.dayOffset) * 1440 + (clockMinutes((arrival ? s.arrivalTime : s.departureTime) ?? null) ?? NaN);
/** One ordered pass per dataset snapshot; no per-expansion SQL or full-table scans. */
export function networkFor(db: RailwayDatabase): Network {
  const version = JSON.stringify(db.metadata());
  const found = cache.get(db); if (found?.version === version) return found.network;
  const routes = new Map<string, LocalTrainStop[]>(), trains = new Map<string, LocalTrain>();
  for (const r of db.db.prepare('SELECT * FROM trains ORDER BY number').all()) trains.set(String(r.number), { number: String(r.number), name: String(r.name), sourceCode: String(r.source_code), destinationCode: String(r.destination_code), runningDaysRaw: String(r.running_days_raw), runningDays: JSON.parse(String(r.running_days_normalized)) });
  for (const row of db.db.prepare(routeSql).all()) { const s = stopRow(row); const route = routes.get(s.trainNumber) ?? []; route.push(s); routes.set(s.trainNumber, route); }
  const boards = new Map<string, LocalTrainStop[]>(), metrics = new Map<string, StationMetric>(), reverse = new Map<string, Edge[]>();
  const members = new Map<string, Set<string>>(), incoming = new Map<string, Set<string>>(), outgoing = new Map<string, Set<string>>();
  for (const r of db.db.prepare('SELECT code FROM stations ORDER BY code').all()) metrics.set(String(r.code), { trains: 0, frequency: 0, sourceConnectivity: 0, destinationConnectivity: 0, score: 0, tier: 'SMALL' });
  for (const [number, route] of routes) {
    for (let i = 0; i < route.length; i++) {
      const s = route[i], member = members.get(s.stationCode) ?? new Set<string>(); member.add(number); members.set(s.stationCode, member);
      if (s.departureTime) { const list = boards.get(s.stationCode) ?? []; list.push(s); boards.set(s.stationCode, list); }
      if (!i) continue;
      const prev = route[i - 1];
      const ins = incoming.get(s.stationCode) ?? new Set<string>(); ins.add(prev.stationCode); incoming.set(s.stationCode, ins);
      const outs = outgoing.get(prev.stationCode) ?? new Set<string>(); outs.add(s.stationCode); outgoing.set(prev.stationCode, outs);
      // Ignoring dwell, calendars and transfers is optimistic. Unknown distance is
      // zero ONLY in this relaxation; a complete candidate must have known distance.
      const distance = prev.distanceKm !== undefined && s.distanceKm !== undefined ? s.distanceKm - prev.distanceKm : 0;
      const duration = eventMinute(s, true) - eventMinute(prev, false);
      const edges = reverse.get(s.stationCode) ?? [];
      edges.push({ station: prev.stationCode, distance: Math.max(0, distance), duration: Number.isFinite(duration) ? Math.max(0, duration) : 0 }); reverse.set(s.stationCode, edges);
    }
  }
  for (const [code, m] of metrics) {
    const served = members.get(code) ?? new Set<string>(); m.trains = served.size;
    m.frequency = [...served].reduce((n, t) => n + trains.get(t)!.runningDays.length, 0);
    m.sourceConnectivity = incoming.get(code)?.size ?? 0; m.destinationConnectivity = outgoing.get(code)?.size ?? 0;
    m.score = m.trains * 7 + m.frequency + 2 * (m.sourceConnectivity + m.destinationConnectivity);
  }
  const ordered = [...metrics].filter(([, m]) => m.trains > 0).sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]));
  ordered.forEach(([, m], i) => { m.tier = i < Math.ceil(ordered.length * .10) ? 'MAJOR' : i < Math.ceil(ordered.length * .35) ? 'MEDIUM' : 'SMALL'; });
  const network = { routes, trains, boards, metrics, reverse }; cache.set(db, { version, network }); return network;
}
/** Dijkstra over reverse adjacent-stop edges. Independent minima are admissible. */
export function lowerBounds(network: Network, destination: string, weight: 'distance' | 'duration'): Map<string, number> {
  const best = new Map<string, number>([[destination, 0]]), heap: [number, string][] = [];
  const push = (item: [number, string]) => { heap.push(item); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= item[0]) break; heap[i] = heap[p]; i = p; } heap[i] = item; };
  const pop = () => { const first = heap[0], last = heap.pop()!; if (heap.length) { let i = 0; while (i * 2 + 1 < heap.length) { let c = i * 2 + 1; if (c + 1 < heap.length && heap[c + 1][0] < heap[c][0]) c++; if (heap[c][0] >= last[0]) break; heap[i] = heap[c]; i = c; } heap[i] = last; } return first; };
  push([0, destination]);
  while (heap.length) { const [distance, code] = pop(); if (best.get(code) !== distance) continue; for (const edge of network.reverse.get(code) ?? []) { const next = distance + edge[weight]; if (next < (best.get(edge.station) ?? Infinity)) { best.set(edge.station, next); push([next, edge.station]); } } }
  return best;
}
