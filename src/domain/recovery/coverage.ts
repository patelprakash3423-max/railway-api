import type { TrainStop } from '../types/station.js';
import type { ReservedCoverage } from './types.js';
/** One metric per requested route: never mix distance and stop span. */
export function coverage(route: TrainStop[], i: number, j: number, from: number, to: number): ReservedCoverage {
  if (!(0 <= i && i <= from && from < to && to <= j && j < route.length)) throw new Error('Invalid recovery interval');
  const distances = route.slice(i, j + 1).map((s) => s.distanceKm);
  const reliable = distances.every((d, k) => Number.isFinite(d) && d >= 0 && (!k || d > distances[k - 1]));
  const ratio = Math.max(0, Math.min(1, reliable ? (route[to].distanceKm - route[from].distanceKm) / (route[j].distanceKm - route[i].distanceKm) : (to - from) / (j - i)));
  return { ratio, percentage: Math.round(ratio * 100), method: reliable ? 'DISTANCE' : 'ROUTE_SPAN' };
}
