import type { TrainStop } from '../../domain/types/station.js';
/** Phase-3 route-local heuristic, not a measure of network connectivity. */
export function junctionScore(stop: TrainStop, source: TrainStop, destination: TrainStop): number {
  const span = destination.distanceKm - source.distanceKm;
  const progress = span > 0 ? (stop.distanceKm - source.distanceKm) / span : 0.5;
  const halt = Math.min(Math.max(stop.haltMinutes, 0), 20);
  const name = /\b(jn|junction|central|terminus)\b/i.test(stop.stationName) ? 2 : 0;
  const position = 6 * Math.max(0, 1 - 2 * Math.abs(progress - 0.5));
  const platform = stop.platform?.trim() ? 0.1 : 0;
  return halt + name + position + platform;
}
export function splitStationLimit(directAvailableResults: number, configuredLimit: number): number {
  return directAvailableResults >= 2 ? Math.min(1, configuredLimit) : configuredLimit;
}
