import type { RailwayProvider } from '../../providers/railway-provider.js';
import type { TrainStop } from '../../domain/types/station.js';
import type { JourneySearchRequest, JourneySearchResponse } from '../types/journey-search.js';
import type { SameTrainJourneyResult as JourneyResult } from '../types/journey-result.js';
import { travelClasses, type JourneySegment, type TravelClass } from '../types/journey-segment.js';
import { SearchBudget, type SearchBudgetConfig } from '../utils/search-budget.js';
import { createSearchDiagnostics, JourneySearchError } from '../utils/search-diagnostics.js';
import { SearchAvailability } from '../utils/search-availability.js';
import { junctionScore, splitStationLimit } from '../scoring/junction-score.js';
import { rankResults, resultIdentity } from '../scoring/result-ranking.js';
import { validateAvailabilityRequest } from '../../utils/availability-input.js';

function boardingDate(date: string, dayOffset: number): string {
  const [day, month, year] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + dayOffset));
  return `${String(shifted.getUTCDate()).padStart(2, '0')}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${shifted.getUTCFullYear()}`;
}
function makeResult(segments: JourneySegment[], split?: TrainStop): JourneyResult {
  const knownFares = segments.every((segment) => segment.fare !== undefined);
  return { type: split ? 'SAME_TRAIN_SPLIT' : 'DIRECT', trainNumber: segments[0].trainNumber,
    segments, splitStationCode: split?.stationCode, splitStationName: split?.stationName,
    totalFare: knownFares ? segments.reduce((total, segment) => total + segment.fare!.totalFare, 0) : undefined,
    totalLiveAvailabilityCallsUsed: 0 };
}
export class SameTrainSearchEngine {
  constructor(private readonly provider: RailwayProvider) {}

  async search(input: JourneySearchRequest, limits: Partial<SearchBudgetConfig> = {}): Promise<JourneySearchResponse> {
    const diagnostics = createSearchDiagnostics();
    const fail = (message: string): never => {
      diagnostics.earlyStopReason = 'SEARCH_VALIDATION_OR_ROUTE_ERROR';
      throw new JourneySearchError(message, diagnostics);
    };
    const request = { ...input, classes: [...new Set(input.classes)] };
    if (!request.classes.length || request.classes.some((value) => !travelClasses.includes(value))) fail('Supply at least one supported travel class.');
    try {
      validateAvailabilityRequest({ ...request, travelClass: request.classes[0] });
    } catch { fail('Invalid search input: use a five-digit train, distinct uppercase station codes, a current/future DD-MM-YYYY date, supported classes and GN quota.'); }
    const budget = new SearchBudget(limits);
    const queries = new SearchAvailability(this.provider, budget, diagnostics);
    diagnostics.trainInfoCalls = 1;
    const train = await this.provider.getTrainInfo(request.trainNumber).catch((error: unknown) => {
      if (typeof error === 'object' && error !== null && 'providerState' in error && error.providerState === 'PROVIDER_UNAVAILABLE') {
        diagnostics.providerUnavailableCount += 1;
      } else diagnostics.providerErrorCount += 1;
      return fail('Train route could not be retrieved from the provider.');
    });
    if (train.trainNumber !== request.trainNumber) fail('Provider returned a different train.');
    const sources = train.route.filter((stop) => stop.stationCode === request.fromStationCode);
    const destinations = train.route.filter((stop) => stop.stationCode === request.toStationCode);
    if (sources.length !== 1 || destinations.length !== 1) fail('Source and destination must each occur exactly once in the train route.');
    const source = sources[0];
    const destination = destinations[0];
    const start = train.route.indexOf(source);
    const end = train.route.indexOf(destination);
    if (start >= end) fail('Source must appear before destination in the train route.');
    const route = train.route.slice(start, end + 1);
    if (new Set(route.map((s) => s.stationCode)).size !== route.length) fail('Repeated stations in this route section are ambiguous.');
    for (let i = 0; i < route.length; i += 1) {
      const stop = route[i];
      if (!Number.isFinite(stop.distanceKm) || stop.distanceKm < 0 || !Number.isInteger(stop.dayNumber) || stop.dayNumber < 1 ||
        (i > 0 && (stop.distanceKm < route[i - 1].distanceKm || stop.dayNumber < route[i - 1].dayNumber))) {
        fail('Route distances and day numbers must be valid and nondecreasing.');
      }
    }
    const candidates = route.slice(1, -1).map((stop, index) => ({ stop, index, score: junctionScore(stop, source, destination) }))
      .sort((a, b) => b.score - a.score || a.index - b.index);
    diagnostics.intermediateStationsConsidered = candidates.length;
    diagnostics.stationCandidates = candidates.map(({ stop, score }) => ({ stationCode: stop.stationCode, score }));
    const results: JourneyResult[] = [];
    const identities = new Set<string>();
    const full = () => results.length >= budget.config.maxResults;
    const add = (result: JourneyResult) => {
      const identity = resultIdentity(result);
      if (!full() && !identities.has(identity)) { identities.add(identity); results.push(result); }
    };
    const segment = async (from: TrainStop, to: TrainStop, travelClass: TravelClass, split?: TrainStop): Promise<JourneySegment | undefined> => {
      const date = boardingDate(request.journeyDate, from.dayNumber - source.dayNumber);
      const response = await queries.get({ trainNumber: request.trainNumber, fromStationCode: from.stationCode,
        toStationCode: to.stationCode, journeyDate: date, travelClass, quota: request.quota }, split ? 'split' : 'direct', split?.stationCode);
      if (!response || response.providerState !== 'SUCCESS') return undefined;
      // Never use another returned date to claim availability on the requested run.
      const days = response.days.filter((day) => day.date === date);
      if (days.length !== 1) { diagnostics.missingRequestedDateCount += 1; return undefined; }
      const day = days[0];
      if (day.state === 'WAITLIST') { diagnostics.waitlistCount += 1; return undefined; }
      if (day.state === 'NOT_AVAILABLE') { diagnostics.notAvailableCount += 1; return undefined; }
      if (day.canBook === false) { diagnostics.unbookableCount += 1; return undefined; }
      return { trainNumber: request.trainNumber, fromStationCode: from.stationCode, toStationCode: to.stationCode,
        journeyDate: date, travelClass, availabilityState: day.state, availabilityText: day.availabilityText, fare: response.fare };
    };

    for (const travelClass of request.classes) {
      if (full() || !budget.canCall()) break;
      const direct = await segment(source, destination, travelClass);
      if (direct) add(makeResult([direct]));
    }
    const directAvailable = results.filter((result) => result.segments[0].availabilityState === 'AVAILABLE').length;
    const stationLimit = splitStationLimit(directAvailable, budget.config.maxIntermediateStations);
    for (const { stop } of candidates.slice(0, stationLimit)) {
      if (full() || !budget.canCall()) break;
      const firstIsOriginHalf = stop.distanceKm - source.distanceKm >= destination.distanceKm - stop.distanceKm;
      const firstFrom = firstIsOriginHalf ? source : stop;
      const firstTo = firstIsOriginHalf ? stop : destination;
      const secondFrom = firstIsOriginHalf ? stop : source;
      const secondTo = firstIsOriginHalf ? destination : stop;
      // Discover viable classes on the longer half first. Reserve one call for the other half.
      const viable: JourneySegment[] = [];
      for (const travelClass of request.classes) {
        if (!budget.canCall()) break;
        if (viable.length && budget.config.maxAvailabilityCalls - budget.callsUsed <= 1) break;
        const harder = await segment(firstFrom, firstTo, travelClass, stop);
        if (harder) viable.push(harder);
        if (viable.length >= budget.config.maxResults - results.length) break;
      }
      if (!viable.length) continue;
      for (const travelClass of request.classes) {
        if (full() || !budget.canCall()) break;
        const easier = await segment(secondFrom, secondTo, travelClass, stop);
        if (!easier) continue;
        // One pairing per easier-half class; cycle through viable harder-half classes.
        // No Cartesian enumeration or extra API calls for each pairing.
        const harder = viable.shift()!;
        viable.push(harder);
        add(makeResult(firstIsOriginHalf ? [harder, easier] : [easier, harder], stop));
      }
    }
    diagnostics.resultsCount = results.length;
    diagnostics.budgetExhausted = !budget.canCall();
    diagnostics.earlyStopReason = full() ? 'MAX_RESULTS_REACHED' : diagnostics.budgetExhausted ? 'AVAILABILITY_BUDGET_EXHAUSTED' :
      candidates.length > stationLimit ? (stationLimit < budget.config.maxIntermediateStations ? 'DIRECT_RESULTS_REDUCED_SPLIT_LIMIT' : 'MAX_INTERMEDIATE_STATIONS_REACHED') : 'CANDIDATES_EXHAUSTED';
    for (const result of results) result.totalLiveAvailabilityCallsUsed = budget.callsUsed;
    return { results: rankResults(results), diagnostics };
  }
}
