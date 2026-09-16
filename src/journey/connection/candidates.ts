import type { TrainCandidate, TrainSearchRequest, TrainSearchResult } from '../../domain/types/train-search.js';
import type { TrainStop } from '../../domain/types/station.js';
import type { TravelClass } from '../types/journey-segment.js';
import { junctionScore } from '../scoring/junction-score.js';
import { scheduledRun, type ScheduledRun } from './timing.js';
import { ConnectionProviderSession } from './provider-session.js';
export function candidateClasses(train: TrainCandidate, classes: TravelClass[]): TravelClass[] {
  return classes.filter((value) => train.availableClasses === undefined || train.availableClasses.includes(value));
}
export function selectTrains(result: TrainSearchResult | null, request: TrainSearchRequest, classes: TravelClass[], limit: number): TrainCandidate[] {
  if (!result || result.providerState !== 'SUCCESS') return [];
  const seen = new Set<string>();
  const classPriority = (train: TrainCandidate) => train.availableClasses === undefined ? 0 : classes.findIndex((value) => train.availableClasses!.includes(value));
  return result.trains.filter((train) => {
    if (seen.has(train.trainNumber) || !/^\d{5}$/.test(train.trainNumber) || train.fromStationCode !== request.fromStationCode || train.toStationCode !== request.toStationCode || !candidateClasses(train, classes).length) return false;
    seen.add(train.trainNumber); return true;
  }).sort((a, b) => classPriority(a) - classPriority(b) || Number(Boolean(scheduledRun(b, request.journeyDate))) - Number(Boolean(scheduledRun(a, request.journeyDate))) ||
    (a.durationMinutes ?? Infinity) - (b.durationMinutes ?? Infinity) ||
    (a.haltCount ?? Infinity) - (b.haltCount ?? Infinity)).slice(0, limit);
}
export interface ConnectionStation { stationCode: string; stationName: string; score: number }
export async function connectionStations(trains: TrainCandidate[], request: TrainSearchRequest, session: ConnectionProviderSession): Promise<ConnectionStation[]> {
  const stations = new Map<string, ConnectionStation>();
  for (const train of trains) {
    const info = await session.info(train.trainNumber);
    if (!info) continue;
    const source = info.route.findIndex((s) => s.stationCode === request.fromStationCode);
    const destination = info.route.findIndex((s) => s.stationCode === request.toStationCode);
    if (source < 0 || destination <= source) continue;
    const sourceStop = info.route[source]; const destinationStop = info.route[destination];
    for (const stop of info.route.slice(source + 1, destination)) {
      if (stop.stationCode === request.fromStationCode || stop.stationCode === request.toStationCode) continue;
      const score = junctionScore(stop, sourceStop, destinationStop);
      if (!Number.isFinite(score)) continue;
      const previous = stations.get(stop.stationCode);
      // Maximum local importance across observed routes. No invented network signals.
      if (!previous || score > previous.score) stations.set(stop.stationCode, { stationCode: stop.stationCode, stationName: stop.stationName, score });
    }
  }
  return [...stations.values()].sort((a, b) => b.score - a.score || a.stationCode.localeCompare(b.stationCode));
}
export async function timedRun(train: TrainCandidate, date: string, session: ConnectionProviderSession, infoLimit = Infinity): Promise<ScheduledRun | undefined> {
  const existing = scheduledRun(train, date);
  if (existing) return existing;
  const info = await session.info(train.trainNumber, infoLimit);
  const route = info?.route;
  const matches = (code: string): TrainStop[] => route?.filter((s) => s.stationCode === code) ?? [];
  const from = matches(train.fromStationCode); const to = matches(train.toStationCode);
  if (from.length === 1 && to.length === 1 && route!.indexOf(from[0]) < route!.indexOf(to[0])) {
    const enriched: TrainCandidate = { ...train, departureTime: from[0].departureTime, arrivalTime: to[0].arrivalTime,
      sourceDayNumber: from[0].dayNumber, destinationDayNumber: to[0].dayNumber, durationMinutes: undefined,
      distanceKm: to[0].distanceKm >= from[0].distanceKm ? to[0].distanceKm - from[0].distanceKm : undefined };
    const run = scheduledRun(enriched, date);
    if (run) return run;
  }
  session.diagnostics.missingTimingCount += 1;
  return undefined;
}
