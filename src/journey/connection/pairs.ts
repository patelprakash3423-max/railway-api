import type { ScheduledRun, ConnectionTimeConfig, ConnectionSafety } from './timing.js';
import { connectionSafety } from './timing.js';
import type { ConnectionSearchDiagnostics } from './types.js';
export interface TrainPair {
  first: ScheduledRun;
  second: ScheduledRun;
  connectionMinutes: number;
  connectionSafety: ConnectionSafety;
  duration: number;
}
export function pairOrder(a: TrainPair, b: TrainPair): number {
  const safety = { GOOD: 0, TIGHT: 1, LONG: 2 };
  return safety[a.connectionSafety] - safety[b.connectionSafety] || a.duration - b.duration || a.connectionMinutes - b.connectionMinutes;
}
/** Inputs are capped first. Discard incompatible pairs immediately and retain only top K. */
export function compatiblePairs(incoming: ScheduledRun[], outgoing: ScheduledRun[], times: ConnectionTimeConfig,
  limit: number, diagnostics: ConnectionSearchDiagnostics): TrainPair[] {
  const best: TrainPair[] = [];
  const seen = new Set<string>();
  for (const first of incoming) {
    for (const second of outgoing) {
      const key = JSON.stringify([first.train.trainNumber, first.boardingDate, second.train.trainNumber, second.boardingDate]);
      if (seen.has(key)) continue;
      seen.add(key);
      if (first.train.trainNumber === second.train.trainNumber) { diagnostics.sameTrainPairsRejected += 1; continue; }
      const minutes = second.departure - first.arrival;
      const safety = connectionSafety(minutes, times);
      if (first.train.toStationCode !== second.train.fromStationCode || !safety) { diagnostics.trainPairsRejectedByTiming += 1; continue; }
      diagnostics.trainPairsGenerated += 1;
      best.push({ first, second, connectionMinutes: minutes, connectionSafety: safety, duration: second.arrival - first.departure });
      best.sort(pairOrder);
      if (best.length > limit) best.pop();
    }
  }
  return best;
}
export function firstLegIsBottleneck(pair: TrainPair): boolean {
  const a = pair.first.train.distanceKm; const b = pair.second.train.distanceKm;
  if (a !== undefined && b !== undefined && Number.isFinite(a) && Number.isFinite(b) && a !== b) return a > b;
  const firstDuration = pair.first.arrival - pair.first.departure;
  const secondDuration = pair.second.arrival - pair.second.departure;
  if (firstDuration !== secondDuration) return firstDuration > secondDuration;
  return false;
}
