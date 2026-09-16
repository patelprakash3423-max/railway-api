import type { JourneyResult } from '../types/journey-result.js';
function category(result: JourneyResult): number {
  const rac = result.segments.some((segment) => segment.availabilityState === 'RAC');
  if (result.type === 'DIRECT') return Number(rac);
  if (result.type === 'SAME_TRAIN_SPLIT') return rac ? 4 : 2;
  return rac ? 5 : 3;
}
function classChanges(result: JourneyResult): number {
  return result.segments.slice(1).filter((segment, index) => segment.travelClass !== result.segments[index].travelClass).length;
}
export function resultIdentity(result: JourneyResult): string {
  return JSON.stringify([result.type, result.type === 'DIFFERENT_TRAIN_CONNECTION' ? result.connectionStationCode : result.splitStationCode,
    result.segments.map((s) => [s.trainNumber, s.fromStationCode, s.toStationCode, s.journeyDate, s.travelClass])]);
}
export function rankResults<T extends JourneyResult>(results: T[]): T[] {
  // Explicit stable insertion avoids inventing a price order when one fare is unknown.
  const compare = (a: JourneyResult, b: JourneyResult): number =>
    category(a) - category(b) || connectionOrder(a, b) || a.segments.length - b.segments.length ||
    (a.totalFare !== undefined && b.totalFare !== undefined ? a.totalFare - b.totalFare : 0) ||
    classChanges(a) - classChanges(b);
  const ranked: T[] = [];
  for (const result of results) {
    const index = ranked.findIndex((other) => compare(result, other) < 0);
    ranked.splice(index < 0 ? ranked.length : index, 0, result);
  }
  return ranked;
}

function connectionOrder(a: JourneyResult, b: JourneyResult): number {
  if (a.type !== 'DIFFERENT_TRAIN_CONNECTION' || b.type !== 'DIFFERENT_TRAIN_CONNECTION') return 0;
  const safety = { GOOD: 0, TIGHT: 1, LONG: 2 };
  return safety[a.connectionSafety] - safety[b.connectionSafety] || classChanges(a) - classChanges(b) ||
    a.totalScheduledDurationMinutes - b.totalScheduledDurationMinutes || a.connectionMinutes - b.connectionMinutes;
}
