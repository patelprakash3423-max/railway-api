import { addDays, clockMinutes, connectionSafety, connectionTimes, departureDates, parseDate } from '../../../journey/connection/timing.js';
import { RailwayDatabase } from '../../database.js';
import { runsOnBoardingDate } from '../../calendar.js';
import { stationCode } from '../../station-code.js';
import type { LocalTrainStop } from '../../types.js';
import type { LocalSearchRequest } from '../local-journey-planner.js';
import { journeyIdentity } from '../ranking.js';
import { networkFor, lowerBounds, eventMinute, type StationTier } from './network.js';
import { candidateDominates, diversify, rankV2 } from './ranking.js';
import { defaultV2Limits, deriveMaxChanges, type V2Diagnostics, type V2Journey, type V2Leg, type V2Limits, type V2Result } from './types.js';
export interface SearchState { station: string; arrival: number; departure?: number; distance: number; legs: V2Leg[]; connections: V2Journey['connections']; used: Set<string>; visited: Set<string>; tiers: StationTier[] }
const subset = (a: Set<string>, b: Set<string>) => [...a].every(x => b.has(x));
/** Equal absolute arrival preserves the entire [30,360] transfer window. Resource
 * subsets preserve future legal choices; earlier arrival alone is NOT safe. */
export function stateDominates(a: SearchState, b: SearchState): boolean {
  return a.station === b.station && a.arrival === b.arrival && a.departure !== undefined && b.departure !== undefined && a.departure >= b.departure && a.legs.length <= b.legs.length && a.distance <= b.distance && subset(a.used, b.used) && subset(a.visited, b.visited) && (a.departure > b.departure || a.legs.length < b.legs.length || a.distance < b.distance || a.used.size < b.used.size || a.visited.size < b.visited.size);
}
const datetime = (minutes: number) => new Date(minutes * 60000).toISOString().slice(0, 16) + ':00+05:30';
export class LocalJourneyPlannerV2 {
  private readonly limits: V2Limits;
  constructor(private readonly database: RailwayDatabase, limits: Partial<V2Limits> = {}) {
    this.limits = { ...defaultV2Limits, ...limits };
    for (const [key, value] of Object.entries(this.limits)) if (!Number.isSafeInteger(value) || value < 1 || value > 100000) throw new Error(`Invalid V2 limit ${key}`);
  }
  search(input: LocalSearchRequest): V2Result {
    this.database.db.exec('BEGIN');
    try { const result = this.snapshot(input); this.database.db.exec('COMMIT'); return result; } catch (error) { this.database.db.exec('ROLLBACK'); throw error; }
  }
  private snapshot(input: LocalSearchRequest): V2Result {
    const start = performance.now(), from = stationCode(input.from), to = stationCode(input.to), day = parseDate(input.date), dataset = this.database.metadata(), limits = this.limits;
    if (from === to) throw new Error('Use distinct stations');
    if (!this.database.station(from) || !this.database.station(to)) throw new Error('Station missing from local dataset');
    if (input.maxChanges !== undefined && (!Number.isInteger(input.maxChanges) || input.maxChanges < 0 || input.maxChanges > 5)) throw new Error('maxChanges must be between 0 and 5');
    const net = networkFor(this.database), remainingDistance = lowerBounds(net, to, 'distance'), remainingTime = lowerBounds(net, to, 'duration');
    const d: V2Diagnostics = { baselineDistanceKm: null, baselineDurationMinutes: null, baselineSource: 'NONE', maxDistanceKm: null, maxDurationMinutes: null, derivedMaxChanges: 0, stagesAttempted: ['DIRECT'], stationTierCounts: { MAJOR: 0, MEDIUM: 0, SMALL: 0 }, statesGenerated: 0, statesExpanded: 0, baselineStatesExpanded: 0, statesDominated: 0, statesTimingPruned: 0, statesDistancePruned: 0, statesDurationPruned: 0, statesLoopPruned: 0, statesCalendarPruned: 0, statesBackwardPruned: 0, statesLowerBoundPruned: 0, statesUnknownDistancePruned: 0, completeCandidatesGenerated: 0, candidatesAfterDetourBounds: 0, candidatesAfterDominance: 0, candidatesAfterDiversity: 0, maxFrontierSize: 0, truncated: false, truncationReasons: [], queryDurationMs: 0 };
    for (const m of net.metrics.values()) d.stationTierCounts[m.tier]++;
    const truncate = (reason: string) => { d.truncated = true; if (!d.truncationReasons.includes(reason)) d.truncationReasons.push(reason); };
    const timing = connectionTimes({ minimumConnectionMinutes: 30 });
    const initial: SearchState = { station: from, arrival: day, distance: 0, legs: [], connections: [], used: new Set(), visited: new Set([from]), tiers: [] };
    let maxDistance = Infinity, maxDuration = Infinity;
    const elapsed = (s: SearchState) => s.departure === undefined ? 0 : s.arrival - s.departure;
    const bound = (s: SearchState): boolean => {
      if (s.distance > maxDistance) { d.statesDistancePruned++; return false; }
      if (elapsed(s) > maxDuration) { d.statesDurationPruned++; return false; }
      const rd = remainingDistance.get(s.station) ?? Infinity, rt = remainingTime.get(s.station) ?? Infinity;
      if (!Number.isFinite(rd) || !Number.isFinite(rt) || s.distance + rd > maxDistance || elapsed(s) + rt > maxDuration) { d.statesLowerBoundPruned++; return false; }
      return true;
    };
    const advance = (state: SearchState, board: LocalTrainStop, end: LocalTrainStop, date: string): SearchState | undefined => {
      if (state.used.has(board.trainNumber)) { d.statesLoopPruned++; return; }
      const train = net.trains.get(board.trainNumber)!;
      if (!runsOnBoardingDate(train, date, board.dayOffset)) { d.statesCalendarPruned++; return; }
      const departure = parseDate(date) + (clockMinutes(board.departureTime ?? null) ?? NaN), arrival = departure + eventMinute(end, true) - eventMinute(board, false);
      const safety = state.legs.length ? connectionSafety(departure - state.arrival, timing) : undefined;
      if (!Number.isFinite(arrival) || arrival <= departure || end.sequence <= board.sequence || (state.legs.length && !safety)) { d.statesTimingPruned++; return; }
      if (board.distanceKm === undefined || end.distanceKm === undefined) { d.statesUnknownDistancePruned++; return; }
      const distance = end.distanceKm - board.distanceKm;
      if (distance < 0) { d.statesDistancePruned++; return; }
      const totalDistance = state.distance + distance, totalDuration = arrival - (state.departure ?? departure);
      // Branch-and-bound before copying route histories.
      if (totalDistance > maxDistance) { d.statesDistancePruned++; return; }
      if (totalDuration > maxDuration) { d.statesDurationPruned++; return; }
      const rd = remainingDistance.get(end.stationCode) ?? Infinity, rt = remainingTime.get(end.stationCode) ?? Infinity;
      if (!Number.isFinite(rd) || !Number.isFinite(rt) || totalDistance + rd > maxDistance || totalDuration + rt > maxDuration) { d.statesLowerBoundPruned++; return; }
      // A large increase in shortest-network distance is a deliberate practical
      // corridor policy, not an admissible lower bound. Small reversals survive.
      if (Number.isFinite(maxDistance) && rd > (remainingDistance.get(state.station) ?? Infinity) + Math.max(100, d.baselineDistanceKm! * .20)) { d.statesBackwardPruned++; return; }
      const visited = new Set(state.visited);
      for (const stop of net.routes.get(board.trainNumber)!) if (stop.sequence > board.sequence && stop.sequence <= end.sequence) {
        if (visited.has(stop.stationCode)) { d.statesLoopPruned++; return; } visited.add(stop.stationCode);
      }
      const leg: V2Leg = { trainNumber: train.number, trainName: train.name, from: board.stationCode, to: end.stationCode, fromStation: board.stationCode, toStation: end.stationCode, boardingDate: date, originDate: addDays(date, -board.dayOffset), departureDateTime: datetime(departure), boardingDateTime: datetime(departure), arrivalDateTime: datetime(arrival), distanceKm: distance };
      d.statesGenerated++;
      return { station: end.stationCode, arrival, departure: state.departure ?? departure, distance: totalDistance, legs: [...state.legs, leg], connections: safety ? [...state.connections, { station: state.station, minutes: departure - state.arrival, safety }] : [], used: new Set([...state.used, train.number]), visited, tiers: state.legs.length ? [...state.tiers, net.metrics.get(state.station)!.tier] : [] };
    };
    const journey = (s: SearchState): V2Journey => ({ from, to, departureDateTime: s.legs[0].departureDateTime, arrivalDateTime: s.legs.at(-1)!.arrivalDateTime, durationMinutes: elapsed(s), changes: s.legs.length - 1, segments: s.legs, connections: s.connections, totalDistanceKm: s.distance, interchangeTiers: s.tiers, distanceDetourPercent: 0, durationDetourPercent: 0 });
    const direct: V2Journey[] = [];
    for (const board of net.boards.get(from) ?? []) for (const end of net.routes.get(board.trainNumber)!) if (end.stationCode === to && end.sequence > board.sequence && end.arrivalTime) { const s = advance(initial, board, end, input.date); if (s) direct.push(journey(s)); }
    const candidates = new Map<string, V2Journey>();
    const priority = (s: SearchState) => elapsed(s) + (remainingTime.get(s.station) ?? Infinity) + .15 * (remainingDistance.get(s.station) ?? Infinity) - Math.min(60, (net.metrics.get(s.station)?.score ?? 0) / 100);
    const stateKey = (s: SearchState) => s.legs.map(l => `${l.trainNumber}:${l.from}:${l.to}:${l.departureDateTime}`).join('|');
    const order = (a: SearchState, b: SearchState) => priority(a) - priority(b) || a.distance - b.distance || stateKey(a).localeCompare(stateKey(b));
    const search = (tiers: StationTier[], maxChanges: number, baseline: boolean): V2Journey[] => {
      let beam = [initial]; const found: V2Journey[] = [];
      for (let depth = 0; depth <= maxChanges && beam.length; depth++) {
        let next: SearchState[] = [];
        for (const state of beam) {
          if ((baseline ? d.baselineStatesExpanded >= limits.maxBaselineStates : d.statesExpanded >= limits.maxExpandedStates) || (!baseline && candidates.size >= limits.maxCompleteCandidates)) { truncate(baseline ? 'baselineStates' : candidates.size >= limits.maxCompleteCandidates ? 'completeCandidates' : 'expandedStates'); return found; }
          if (baseline) d.baselineStatesExpanded++; else d.statesExpanded++;
          if (!bound(state)) continue;
          const dates = state.legs.length ? departureDates(state.arrival, timing) : [input.date];
          // Date/time eligibility precedes the outgoing cap. Direct completions
          // always bypass it, so train-number ordering cannot hide a destination.
          const options: { board: LocalTrainStop; date: string; score: number }[] = [];
          for (const board of net.boards.get(state.station) ?? []) {
            if (state.used.has(board.trainNumber)) { d.statesLoopPruned++; continue; }
            for (const date of dates) {
              if (!runsOnBoardingDate(net.trains.get(board.trainNumber)!, date, board.dayOffset)) { d.statesCalendarPruned++; continue; }
              const departure = parseDate(date) + clockMinutes(board.departureTime!)!;
              if (state.legs.length && !connectionSafety(departure - state.arrival, timing)) { d.statesTimingPruned++; continue; }
              let score = Infinity;
              for (const end of net.routes.get(board.trainNumber)!) if (end.sequence > board.sequence && end.arrivalTime) {
                if (end.stationCode === to) {
                  const s = advance(state, board, end, date); if (s) {
                    const j = journey(s); found.push(j);
                    if (!baseline) { const key = journeyIdentity(j); if (!candidates.has(key)) { if (candidates.size >= limits.maxCompleteCandidates) { truncate('completeCandidates'); return found; } candidates.set(key, j); d.completeCandidatesGenerated++; } }
                  }
                } else if (tiers.includes(net.metrics.get(end.stationCode)!.tier)) score = Math.min(score, eventMinute(end, true) - eventMinute(board, false) + (remainingTime.get(end.stationCode) ?? Infinity) + .15 * (remainingDistance.get(end.stationCode) ?? Infinity));
              }
              if (depth < maxChanges && Number.isFinite(score)) options.push({ board, date, score });
            }
          }
          if (baseline && found.length >= 20) { truncate('baselineCandidates'); return found; }
          options.sort((a, b) => a.score - b.score || a.board.trainNumber.localeCompare(b.board.trainNumber) || a.board.sequence - b.board.sequence || a.date.localeCompare(b.date));
          if (options.length > limits.outgoingTrainCap) truncate('outgoingTrains');
          for (const { board, date } of options.slice(0, limits.outgoingTrainCap)) for (const end of net.routes.get(board.trainNumber)!) {
            if (end.sequence <= board.sequence || !end.arrivalTime || end.stationCode === to || !tiers.includes(net.metrics.get(end.stationCode)!.tier)) continue;
            const s = advance(state, board, end, date); if (s) next.push(s);
          }
          // Bound the working frontier as well as the next expanded beam.
          if (next.length > limits.beamWidth * 4) { next.sort(order); next = next.slice(0, limits.beamWidth * 2); truncate('workingFrontier'); }
        }
        next.sort(order);
        const groups = new Map<string, SearchState[]>(), survivors: SearchState[] = [], keys = new Set<string>();
        for (const s of next) {
          const key = stateKey(s); if (keys.has(key)) continue; keys.add(key);
          const position = `${s.station}:${s.arrival}`, group = groups.get(position) ?? [];
          if (group.some(a => stateDominates(a, s))) { d.statesDominated++; continue; }
          const remaining = group.filter(b => { if (stateDominates(s, b)) { d.statesDominated++; return false; } return true; }); remaining.push(s); groups.set(position, remaining);
        }
        for (const group of groups.values()) survivors.push(...group); survivors.sort(order);
        // Give each station one slot before filling with alternative histories.
        const stations = new Set<string>(), diverse: SearchState[] = [], rest: SearchState[] = [];
        for (const s of survivors) { if (!stations.has(s.station)) { stations.add(s.station); diverse.push(s); } else rest.push(s); }
        if (survivors.length > limits.beamWidth) truncate('beamWidth');
        beam = [...diverse, ...rest].slice(0, limits.beamWidth); d.maxFrontierSize = Math.max(d.maxFrontierSize, beam.length);
      }
      return found;
    };
    let baseline = [...direct].sort((a, b) => a.durationMinutes - b.durationMinutes || a.totalDistanceKm - b.totalDistanceKm || rankV2(a, b))[0];
    if (baseline) d.baselineSource = 'DIRECT';
    else {
      d.stagesAttempted.push('BASELINE');
      baseline = search(['MAJOR', 'MEDIUM', 'SMALL'], input.maxChanges ?? 5, true).filter(j => j.changes <= deriveMaxChanges(j.totalDistanceKm)).sort((a, b) => a.durationMinutes - b.durationMinutes || a.totalDistanceKm - b.totalDistanceKm || rankV2(a, b))[0];
      if (baseline) d.baselineSource = 'BOUNDED_PATH';
    }
    if (baseline) {
      d.baselineDistanceKm = baseline.totalDistanceKm; d.baselineDurationMinutes = baseline.durationMinutes;
      maxDistance = d.maxDistanceKm = baseline.totalDistanceKm * 1.5; maxDuration = d.maxDurationMinutes = baseline.durationMinutes * 1.5;
      d.derivedMaxChanges = deriveMaxChanges(baseline.totalDistanceKm);
      const changes = Math.min(input.maxChanges ?? 5, d.derivedMaxChanges);
      for (const j of [...direct, baseline].sort(rankV2)) if (j.totalDistanceKm <= maxDistance && j.durationMinutes <= maxDuration && j.changes <= changes) {
        const key = journeyIdentity(j);
        if (!candidates.has(key) && candidates.size >= limits.maxCompleteCandidates) { truncate('completeCandidates'); break; }
        candidates.set(key, j);
      }
      d.completeCandidatesGenerated = candidates.size;
      const enough = () => {
        const strong = [...candidates.values()].filter(j => j.durationMinutes <= baseline!.durationMinutes * 1.25 && j.totalDistanceKm <= baseline!.totalDistanceKm * 1.25);
        return diversify(strong.filter(b => !strong.some(a => candidateDominates(a, b)))).length >= limits.strongCandidateTarget;
      };
      const tiers: StationTier[] = [];
      for (const tier of ['MAJOR', 'MEDIUM', 'SMALL'] as const) {
        if (!changes || enough()) break;
        if (d.statesExpanded >= limits.maxExpandedStates || candidates.size >= limits.maxCompleteCandidates) { truncate('stageBudget'); break; }
        tiers.push(tier); d.stagesAttempted.push(tiers.join('+')); search(tiers, changes, false);
      }
    }
    const bounded = [...candidates.values()].filter(j => j.totalDistanceKm <= maxDistance && j.durationMinutes <= maxDuration);
    d.candidatesAfterDetourBounds = bounded.length;
    const nondominated = bounded.filter(b => !bounded.some(a => candidateDominates(a, b))); d.candidatesAfterDominance = nondominated.length;
    const diverse = diversify(nondominated); d.candidatesAfterDiversity = diverse.length;
    if (diverse.length > limits.maxResults) truncate('results');
    const journeys = diverse.slice(0, limits.maxResults);
    for (const j of journeys) { j.distanceDetourPercent = d.baselineDistanceKm ? (j.totalDistanceKm / d.baselineDistanceKm - 1) * 100 : 0; j.durationDetourPercent = d.baselineDurationMinutes ? (j.durationMinutes / d.baselineDurationMinutes - 1) * 100 : 0; }
    d.queryDurationMs = performance.now() - start;
    return { kind: 'SCHEDULED_CANDIDATES_ONLY', plannerVersion: 2, dataset, journeys, diagnostics: d };
  }
}
