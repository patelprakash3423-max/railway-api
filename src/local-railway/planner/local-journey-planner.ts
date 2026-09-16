import { addDays, clockMinutes, connectionSafety, connectionTimes, departureDates, parseDate, type ConnectionTimeConfig } from '../../journey/connection/timing.js';
import { RailwayDatabase } from '../database.js';
import { TimetableIndexes } from '../indexes.js';
import { stationCode } from '../station-code.js';
import { runsOnBoardingDate } from '../calendar.js';
import type { LocalTrain, LocalTrainStop } from '../types.js';
import { searchBounds, type SearchBounds } from './bounds.js';
import { journeyIdentity, rankScheduled } from './ranking.js';
import type { PlannerDiagnostics, ScheduledJourney, ScheduledSearchResult, ScheduledTrainSegment } from './types.js';
interface State { station: string; arrival: number; departure?: number; trains: Set<string>; visited: Set<string>; segments: ScheduledTrainSegment[]; connections: ScheduledJourney['connections']; distance?: number }
// Absolute minutes are railway wall-clock minutes, matching the shared timing utilities.
const datetime = (minutes: number) => new Date(minutes * 60000).toISOString().slice(0, 16) + ':00+05:30';
export interface LocalSearchRequest { from: string; to: string; date: string; maxChanges?: number }
export class LocalJourneyPlanner {
  constructor(private readonly database: RailwayDatabase, private readonly options: { bounds?: Partial<SearchBounds>; timing?: Partial<ConnectionTimeConfig> } = {}) {}
  search(input: LocalSearchRequest): ScheduledSearchResult {
    // One consistent read snapshot, including metadata, even during an external import.
    this.database.db.exec('BEGIN');
    try { const result = this.searchSnapshot(input); this.database.db.exec('COMMIT'); return result; }
    catch (error) { this.database.db.exec('ROLLBACK'); throw error; }
  }
  private searchSnapshot(input: LocalSearchRequest): ScheduledSearchResult {
    const start = performance.now(), from = stationCode(input.from), to = stationCode(input.to), date = input.date;
    parseDate(date);
    const maxChanges = input.maxChanges ?? 2;
    if (!Number.isInteger(maxChanges) || maxChanges < 0 || maxChanges > 2) throw new Error('maxChanges must be 0, 1 or 2');
    if (from === to) throw new Error('Use distinct stations');
    const dataset = this.database.metadata();
    if (!this.database.station(from) || !this.database.station(to)) throw new Error(`Station missing from local dataset: ${!this.database.station(from) ? from : to}`);
    const bounds = searchBounds(this.options.bounds), timing = connectionTimes(this.options.timing), indexes = new TimetableIndexes(this.database);
    const diagnostics: PlannerDiagnostics = { directTrainsConsidered: 0, firstLegTrainsConsidered: 0, trainsConsidered: 0, interchangeStationsConsidered: 0, partialPathsGenerated: 0, pathsTimingPruned: 0, pathsLoopPruned: 0, pathsCalendarPruned: 0, completedJourneys: 0, rowsConsidered: 0, boundsPruned: 0, maxFrontier: 1, queryDurationMs: 0, truncated: false };
    const bounded = <T>(items: T[], limit: number): T[] => {
      if (items.length > limit) { diagnostics.boundsPruned += items.length - limit; diagnostics.truncated = true; }
      return items.slice(0, limit);
    };
    const trainCache = new Map<string, LocalTrain>();
    const train = (number: string) => { let t = trainCache.get(number); if (!t) { t = this.database.train(number); trainCache.set(number, t); } return t; };
    const candidates: ScheduledJourney[] = [], accepted = new Set<string>();
    const full = () => candidates.length >= bounds.maxCandidateJourneys;
    const complete = (state: State) => {
      const journey: ScheduledJourney = { from, to, departureDateTime: state.segments[0].departureDateTime, arrivalDateTime: state.segments.at(-1)!.arrivalDateTime, durationMinutes: state.arrival - state.departure!, changes: state.segments.length - 1, segments: state.segments, connections: state.connections, totalDistanceKm: state.distance };
      const key = journeyIdentity(journey);
      if (!accepted.has(key) && !full()) { accepted.add(key); candidates.push(journey); diagnostics.completedJourneys++; }
    };
    const advance = (state: State, board: LocalTrainStop, end: LocalTrainStop, boardingDate: string): State | undefined => {
      const t = train(board.trainNumber);
      if (state.trains.has(t.number)) { diagnostics.pathsLoopPruned++; return; }
      if (!runsOnBoardingDate(t, boardingDate, board.dayOffset)) { diagnostics.pathsCalendarPruned++; return; }
      const depClock = clockMinutes(board.departureTime ?? null), arrClock = clockMinutes(end.arrivalTime ?? null);
      if (depClock === undefined || arrClock === undefined || end.sequence <= board.sequence) { diagnostics.pathsTimingPruned++; return; }
      const departure = parseDate(boardingDate) + depClock;
      const arrival = parseDate(boardingDate) + ((end.arrivalDayOffset ?? end.dayOffset) - board.dayOffset) * 1440 + arrClock;
      const connection = state.segments.length ? connectionSafety(departure - state.arrival, timing) : undefined;
      if (arrival <= departure || (state.segments.length && !connection)) { diagnostics.pathsTimingPruned++; return; }
      const visited = new Set(state.visited);
      for (const stop of indexes.traversed(t.number, board.sequence, end.sequence)) {
        if (visited.has(stop.stationCode)) { diagnostics.pathsLoopPruned++; return; }
        visited.add(stop.stationCode);
      }
      const distance = board.distanceKm !== undefined && end.distanceKm !== undefined ? end.distanceKm - board.distanceKm : undefined;
      const segment: ScheduledTrainSegment = { trainNumber: t.number, trainName: t.name, from: board.stationCode, to: end.stationCode, boardingDate, originDate: addDays(boardingDate, -board.dayOffset), departureDateTime: datetime(departure), arrivalDateTime: datetime(arrival), distanceKm: distance };
      return { station: end.stationCode, arrival, departure: state.departure ?? departure, trains: new Set([...state.trains, t.number]), visited, segments: [...state.segments, segment], connections: connection ? [...state.connections, { station: board.stationCode, minutes: departure - state.arrival, safety: connection }] : state.connections, distance: state.distance !== undefined && distance !== undefined ? state.distance + distance : undefined };
    };
    let beam: State[] = [{ station: from, arrival: parseDate(date), trains: new Set(), visited: new Set([from]), segments: [], connections: [], distance: 0 }];
    for (let depth = 0; depth <= maxChanges && beam.length && !full(); depth++) {
      const next: State[] = [], nextKeys = new Set<string>();
      for (const state of beam) {
        if (full()) break;
        const dates = depth === 0 ? [date] : departureDates(state.arrival, timing);
        // Indexed pair membership always searches completion separately from the bounded onward shortlist.
        const finishing = bounded(indexes.departures(state.station, bounds.maxTrainsPerExpansion + 1, to), bounds.maxTrainsPerExpansion);
        if (!depth) diagnostics.directTrainsConsidered += finishing.length;
        diagnostics.trainsConsidered += finishing.length;
        let directCount = 0;
        for (const board of finishing) {
          const ends = bounded(indexes.onward(board.trainNumber, board.sequence, bounds.maxInterchangeStationsPerExpansion + 1, to), bounds.maxInterchangeStationsPerExpansion);
          for (const boardingDate of dates) for (const end of ends) {
            if (!depth && directCount >= bounds.maxDirectResults) { diagnostics.truncated = true; diagnostics.boundsPruned++; break; }
            const result = advance(state, board, end, boardingDate);
            if (result) { const before = candidates.length; complete(result); directCount += candidates.length - before; }
          }
          if (full()) break;
        }
        if (depth === maxChanges || full()) continue;
        const departures = bounded(indexes.departures(state.station, bounds.maxTrainsPerExpansion + 1), bounds.maxTrainsPerExpansion);
        if (!depth) diagnostics.firstLegTrainsConsidered += departures.length;
        diagnostics.trainsConsidered += departures.length;
        const interchangeStations = new Set<string>();
        for (const board of departures) {
          if (state.trains.has(board.trainNumber)) { diagnostics.pathsLoopPruned++; continue; }
          const ends = bounded(indexes.onward(board.trainNumber, board.sequence, bounds.maxInterchangeStationsPerExpansion + 1), bounds.maxInterchangeStationsPerExpansion);
          for (const end of ends) {
            if (end.stationCode === to) continue;
            if (!interchangeStations.has(end.stationCode)) {
              if (interchangeStations.size >= bounds.maxInterchangeStationsPerExpansion) { diagnostics.boundsPruned++; diagnostics.truncated = true; continue; }
              interchangeStations.add(end.stationCode); diagnostics.interchangeStationsConsidered++;
            }
            for (const boardingDate of dates) {
              const result = advance(state, board, end, boardingDate); if (!result) continue;
              const key = JSON.stringify(result.segments);
              if (nextKeys.has(key)) continue;
              nextKeys.add(key); next.push(result); diagnostics.partialPathsGenerated++;
            }
          }
        }
      }
      // Keep distinct resource histories: earlier arrival alone cannot dominate a later safe transfer window.
      next.sort((a,b) => a.arrival - b.arrival || (a.arrival - a.departure!) - (b.arrival - b.departure!) || JSON.stringify(a.segments).localeCompare(JSON.stringify(b.segments)));
      // Station diversity prevents one busy interchange from occupying every beam slot.
      const diverse: State[] = [], stations = new Set<string>();
      for (const s of next) if (!stations.has(s.station)) { diverse.push(s); stations.add(s.station); }
      beam = bounded([...diverse, ...next.filter(s => !diverse.includes(s))], bounds.beamWidth);
      diagnostics.maxFrontier = Math.max(diagnostics.maxFrontier, beam.length);
    }
    if (full()) diagnostics.truncated = true;
    diagnostics.rowsConsidered = indexes.rowsRead; diagnostics.queryDurationMs = performance.now() - start;
    return { kind: 'SCHEDULED_CANDIDATES_ONLY', dataset, journeys: candidates.sort(rankScheduled).slice(0, bounds.finalResultLimit), diagnostics };
  }
}
