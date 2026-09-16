import { SearchBudgetOrchestrator, adaptiveCallValue, type DeferredValidation } from '../../application/search-budget-orchestrator.js';
import { multiInterchangeSearch } from '../../application/multi-interchange-planner.js';
import { shouldRunMultiInterchangeSearch } from '../../domain/planner/ranking.js';
import { multiDiagnostics, type MultiConfig } from '../../domain/planner/types.js';
import { searchRecovery } from '../../application/journey-recovery-engine.js';
import type { RecoveryConfig } from '../../domain/recovery/types.js';
import type { RailwayProvider } from '../../providers/railway-provider.js';
import type { TrainCandidate, TrainSearchRequest } from '../../domain/types/train-search.js';
import type { JourneyResult } from '../types/journey-result.js';
import { travelClasses, type JourneySegment, type TravelClass } from '../types/journey-segment.js';
import { rankResults, resultIdentity } from '../scoring/result-ranking.js';
import { connectionDiagnostics, type ConnectionSearchRequest, type ConnectionSearchResponse } from './types.js';
import { ConnectionBudget, connectionPolicy, connectionStationLimit, directPhaseCallLimit, type ConnectionSearchBudgetConfig, type ConnectionSearchPolicy } from './budget.js';
import { ConnectionProviderSession } from './provider-session.js';
import { connectionTimes, connectionSafety, scheduledRun, departureDates, parseDate, type ConnectionTimeConfig, type ScheduledRun } from './timing.js';
import { selectTrains, candidateClasses, connectionStations, timedRun, type ConnectionStation } from './candidates.js';
import { compatiblePairs, firstLegIsBottleneck, type TrainPair } from './pairs.js';
export interface ConnectionSearchOptions {
  recovery?: RecoveryConfig;
  multi?: MultiConfig;
  orchestration?: 'QUICK' | 'STANDARD' | 'DEEP';
  budget?: Partial<ConnectionSearchBudgetConfig>;
  timing?: Partial<ConnectionTimeConfig>;
  policy?: Partial<ConnectionSearchPolicy>;
}
function validate(request: ConnectionSearchRequest): void {
  if (!/^[A-Z]{1,5}$/.test(request.fromStationCode) || !/^[A-Z]{1,5}$/.test(request.toStationCode) || request.fromStationCode === request.toStationCode || request.quota !== 'GN') throw new Error('Use distinct uppercase station codes and GN quota.');
  parseDate(request.journeyDate);
  if (!request.classes.length || request.classes.some((c) => !travelClasses.includes(c))) throw new Error('Supply supported classes in priority order.');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (name: string) => today.find((p) => p.type === name)!.value;
  if (parseDate(request.journeyDate) < parseDate(`${part('day')}-${part('month')}-${part('year')}`)) throw new Error('Journey date cannot be in the past (Asia/Kolkata).');
}
function totalFare(segments: JourneySegment[]): number | undefined {
  return segments.every((s) => s.fare !== undefined) ? segments.reduce((sum, s) => sum + s.fare!.totalFare, 0) : undefined;
}
export class ConnectionSearchEngine {
  constructor(private readonly provider: RailwayProvider) {}
  async search(input: ConnectionSearchRequest, options: ConnectionSearchOptions = {}): Promise<ConnectionSearchResponse> {
    const request = { ...input, classes: [...new Set(input.classes)] };
    validate(request);
    const budget = new ConnectionBudget(options.budget);
    const policy = connectionPolicy(options.policy);
    const times = connectionTimes(options.timing);
    const directLimit = directPhaseCallLimit(budget.config, policy);
    const diagnostics = connectionDiagnostics();
    const orchestrator = options.orchestration ? new SearchBudgetOrchestrator(budget.config.maxAvailabilityCalls, options.orchestration) : undefined;
    const session = new ConnectionProviderSession(this.provider, budget, diagnostics, policy.providerUnavailableThreshold, orchestrator);
    if (!options.recovery) orchestrator?.releaseStageProtection('sameTrainRecovery', false);
    if (!options.multi) orchestrator?.releaseStageProtection('multiInterchange', false);
    if (!budget.config.maxConnectionStations) orchestrator?.releaseStageProtection('oneChange', false);
    const results: JourneyResult[] = [];
    const identities = new Set<string>();
    const full = () => results.length >= budget.config.maxResults;
    const add = (result: JourneyResult): boolean => {
      const key = resultIdentity(result);
      if (full() || identities.has(key)) return false;
      results.push(result); identities.add(key); return true;
    };
    const deferredDirect: DeferredValidation[] = [];
    const deferredPairs: DeferredValidation[] = [];
    let recoveryTrains: TrainCandidate[] = [];
    let recovery: Awaited<ReturnType<typeof searchRecovery>> | undefined;
    const runRecovery = async () => {
      if (!recovery && options.recovery && !full()) recovery = await searchRecovery(request, recoveryTrains, session, orchestrator ? { ...options.recovery, availabilityCalls: Math.min(options.recovery.availabilityCalls, orchestrator.stageUsage.sameTrainRecovery.protectedFloor) } : options.recovery,
        new Set(results.flatMap((r) => r.type === 'DIRECT' ? [r.trainNumber] : [])));
      orchestrator?.releaseStageProtection('sameTrainRecovery', Boolean(recovery?.diagnostics.recoveryCandidatesGenerated));
    };
    const finish = async (reason: string): Promise<ConnectionSearchResponse> => {
      orchestrator?.releaseStageProtection('direct', recoveryTrains.length > 0);
      await runRecovery();
      orchestrator?.releaseStageProtection('oneChange', diagnostics.trainPairsGenerated > 0);
      const multi = options.multi && !full() && shouldRunMultiInterchangeSearch(results, recovery?.candidates ?? [], options.multi.deep)
        ? await multiInterchangeSearch(request, recoveryTrains, session, options.multi, times) : options.multi ? { candidates: [], diagnostics: multiDiagnostics() } : undefined;


      orchestrator?.releaseStageProtection('multiInterchange', Boolean(multi?.diagnostics.multiInterchangeActivated));
      if (orchestrator) {
        orchestrator.resume();
        const strong = () => full() || results.some(r=>r.segments.every(s=>s.availabilityState==='AVAILABLE') && (r.type!=='DIFFERENT_TRAIN_CONNECTION'||r.connectionSafety==='GOOD')) || Boolean(multi?.diagnostics.multiInterchangeStrongStopCount) || Boolean(recovery?.candidates.some(c=>c.quality==='EXCELLENT'));
        const adaptive = [...deferredPairs.splice(0), ...deferredDirect].sort((a,b)=>b.value-a.value);
        if (!strong()) for (const task of adaptive) { if (strong() || !budget.canCall('availability')) break; await task.run(); }
        if (!strong() && options.recovery && recovery && budget.canCall('availability')) {
          const extra = await searchRecovery(request, recoveryTrains, session, { ...options.recovery, availabilityCalls: Math.max(0, options.recovery.availabilityCalls - recovery.diagnostics.recoveryAvailabilityChecks) }, new Set(results.flatMap(r=>r.type==='DIRECT'?[r.trainNumber]:[])));
          for (const key of Object.keys(extra.diagnostics) as (keyof typeof extra.diagnostics)[]) extra.diagnostics[key] += recovery.diagnostics[key];
          recovery = { candidates: extra.candidates, diagnostics: extra.diagnostics };
        }
        orchestrator.strongResultExists = strong();
        diagnostics.budgetOrchestration = orchestrator.snapshot();
        diagnostics.insufficientRemainingBudgetForNextExpansion = orchestrator.insufficientRemainingBudget && !strong();
      }
      diagnostics.earlyStopReason = full() ? 'MAX_RESULTS_REACHED' : reason;
      if (!diagnostics.connectionStationsQueried.length) diagnostics.connectionSearchSkippedReason = reason;
      diagnostics.resultsCount = Math.min(budget.config.maxResults, results.length + (recovery?.candidates.length ?? 0) + (multi?.candidates.length ?? 0));
      diagnostics.effectiveConnectionStationLimit = connectionStationLimit(diagnostics.directSearchQuality, budget.config.maxConnectionStations, policy);
      diagnostics.trainDiscoveryBudgetExhausted = !budget.canCall('discovery');
      diagnostics.trainInfoBudgetExhausted = !budget.canCall('info');
      diagnostics.availabilityBudgetExhausted = !budget.canCall('availability');
      for (const result of results) result.totalLiveAvailabilityCallsUsed = diagnostics.availabilityCalls;
      return { results: rankResults(results), diagnostics, multi, recovery: recovery ? { ...recovery, candidates: recovery.candidates.slice(0, budget.config.maxResults - results.length) } : undefined };
    };
    let resumingDirect = false;
    let reservedOtherRequests: import('../../domain/types/availability.js').AvailabilityRequest[] = [];
    const usable = async (train: TrainCandidate, date: string, travelClass: TravelClass, direct = false, stationCode?: string): Promise<JourneySegment | undefined> => {
      const query = { trainNumber: train.trainNumber, fromStationCode: train.fromStationCode, toStationCode: train.toStationCode, journeyDate: date, travelClass, quota: request.quota };
      if (orchestrator && !direct && !session.canValidate('oneChange', [query, ...reservedOtherRequests], 0, stationCode ? policy.maxAvailabilityCallsPerConnectionStation - (diagnostics.availabilityCallsByConnectionStation[stationCode] ?? 0) : Infinity)) return undefined;
      const result = await session.availability({ trainNumber: train.trainNumber, fromStationCode: train.fromStationCode,
        toStationCode: train.toStationCode, journeyDate: date, travelClass, quota: request.quota }, direct, { directLimit: orchestrator && resumingDirect ? budget.config.maxAvailabilityCalls : directLimit, stationCode, stationLimit: policy.maxAvailabilityCallsPerConnectionStation });
      if (!result || result.providerState !== 'SUCCESS') return undefined;
      const days = result.days.filter((day) => day.date === date);
      if (days.length !== 1) { diagnostics.missingRequestedDateCount += 1; return undefined; }
      const day = days[0];
      if (day.state === 'WAITLIST') { diagnostics.waitlistCount += 1; return undefined; }
      if (day.state !== 'AVAILABLE' && day.state !== 'RAC' || day.canBook === false) return undefined;
      return { trainNumber: train.trainNumber, fromStationCode: train.fromStationCode, toStationCode: train.toStationCode,
        journeyDate: date, travelClass, availabilityState: day.state, availabilityText: day.availabilityText, fare: result.fare };
    };
    if (full()) return finish('MAX_RESULTS_REACHED');
    if (!budget.canCall('availability')) return finish('AVAILABILITY_BUDGET_EXHAUSTED');
    const directRequest: TrainSearchRequest = request;
    const discovered = await session.discover(directRequest);
    if ((!discovered && diagnostics.trainDiscoveryCalls > 0) || (discovered && discovered.providerState !== 'SUCCESS')) return finish('DIRECT_DISCOVERY_FAILED_NO_CONNECTION_SEEDS');
    diagnostics.directTrainsDiscovered = discovered?.providerState === 'SUCCESS' ? discovered.trains.filter((train) =>
      train.fromStationCode === request.fromStationCode && train.toStationCode === request.toStationCode).length : 0;
    const directTrains = selectTrains(discovered, directRequest, request.classes, budget.config.maxTrainsPerLeg);
    recoveryTrains = directTrains;
    const optionsByTrain = new Map<string, number>();
    const strongTrains = new Set<string>();
    for (let round = 0; round < request.classes.length; round += 1) {
      if (full() || !budget.canCall('availability')) break;
      if (round > 0 && !policy.broadenDirectClassAlternatives &&
        diagnostics.directSearchQuality.availableResults >= policy.directAvailableWideningTarget) {
        diagnostics.directChecksSkippedAfterStrongResult += directTrains.reduce((sum, train) => sum +
          (strongTrains.has(train.trainNumber) ? candidateClasses(train, request.classes.slice(round)).length : 0), 0);
        break;
      }
      const travelClass = request.classes[round];
      const eligible = directTrains.filter((train) => candidateClasses(train, [travelClass]).length &&
        (optionsByTrain.get(train.trainNumber) ?? 0) < policy.directOptionsPerTrain);
      if (!eligible.length) continue;
      diagnostics.directSearchRounds += 1;
      for (const train of eligible) {
        if (full() || !budget.canCall('availability')) break;
        if (strongTrains.has(train.trainNumber) && !policy.broadenDirectClassAlternatives) {
          diagnostics.directChecksSkippedAfterStrongResult += 1;
          continue;
        }
        const attempt = async () => {
          if ((optionsByTrain.get(train.trainNumber) ?? 0) >= policy.directOptionsPerTrain || (strongTrains.has(train.trainNumber) && !policy.broadenDirectClassAlternatives)) return;
          const segment = await usable(train, request.journeyDate, travelClass, true);
        if (segment && add({ type: 'DIRECT', trainNumber: train.trainNumber, segments: [segment], totalFare: segment.fare?.totalFare, totalLiveAvailabilityCallsUsed: 0 })) {
          optionsByTrain.set(train.trainNumber, (optionsByTrain.get(train.trainNumber) ?? 0) + 1);
          if (segment.availabilityState === 'AVAILABLE') {
            strongTrains.add(train.trainNumber);
            diagnostics.directSearchQuality.availableResults += 1;
          } else diagnostics.directSearchQuality.racResults += 1;
        }
        };
        if (orchestrator && (!candidateClasses(train, request.classes).slice(0, 2).includes(travelClass) || diagnostics.availabilityCallsByPhase.direct >= directLimit)) {
          orchestrator.defer('direct');
          deferredDirect.push({ value: adaptiveCallValue(1, round, 1, 0), run: async () => { resumingDirect = true; await attempt(); resumingDirect = false; } });
          continue;
        }
        await attempt();
        if (diagnostics.directPhaseSoftLimitReached && !orchestrator) break;
      }
      if (diagnostics.directPhaseSoftLimitReached && !orchestrator) break;
    }
    if (full()) return finish('MAX_RESULTS_REACHED');
    if (!budget.canCall('availability')) return finish('AVAILABILITY_BUDGET_EXHAUSTED');
    orchestrator?.releaseStageProtection('direct', directTrains.length > 0);
    await runRecovery();
    const strongDirect = diagnostics.directSearchQuality.availableResults;
    const stationLimit = connectionStationLimit(diagnostics.directSearchQuality, budget.config.maxConnectionStations, policy);
    diagnostics.effectiveConnectionStationLimit = stationLimit;
    if (!stationLimit) return finish(strongDirect >= policy.strongDirectSkipThreshold ? 'ENOUGH_STRONG_DIRECT_RESULTS' : 'MAX_CONNECTION_STATIONS_REACHED');
    if (!budget.canCall('discovery')) return finish('TRAIN_DISCOVERY_BUDGET_EXHAUSTED');
    const stations = await connectionStations(directTrains, directRequest, session);
    diagnostics.connectionStationsConsidered = stations.length;
    diagnostics.connectionStationCandidates = stations.map(({ stationCode, score }) => ({ stationCode, score }));
    if (!stations.length) return finish('NO_ROUTE_DERIVED_CONNECTION_STATIONS');

    const checkPair = async (pair: TrainPair, station: ConnectionStation): Promise<void> => {
      const initialQueries = [pair.first, pair.second].map(r=>({ trainNumber:r.train.trainNumber, fromStationCode:r.train.fromStationCode, toStationCode:r.train.toStationCode, journeyDate:r.boardingDate, travelClass:candidateClasses(r.train,request.classes)[0], quota:request.quota }));
      const deferPair = () => deferredPairs.push({ value: adaptiveCallValue(1, 0, session.estimatedUncachedAvailabilityCost(initialQueries), 1), run: ()=>checkPair(pair,station) });
      if (orchestrator && !session.canValidate('oneChange', initialQueries, 0, policy.maxAvailabilityCallsPerConnectionStation - (diagnostics.availabilityCallsByConnectionStation[station.stationCode] ?? 0))) { deferPair(); return; }
      const beforeChecks = diagnostics.availabilityCalls + diagnostics.availabilityCacheHits;
      const reservationBefore = orchestrator?.preventedByReservation ?? 0;
      diagnostics.trainPairsCheckedForAvailability += 1;
      const firstHarder = firstLegIsBottleneck(pair);
      const harder = firstHarder ? pair.first : pair.second;
      const other = firstHarder ? pair.second : pair.first;
      reservedOtherRequests = orchestrator ? [initialQueries[firstHarder ? 1 : 0]] : [];
      const viable: JourneySegment[] = [];
      for (const travelClass of candidateClasses(harder.train, request.classes)) {
        if (full()) break;
        // Preserve capacity to check the other leg after finding a usable bottleneck class.
        if (viable.length && Math.min(budget.config.maxAvailabilityCalls - budget.used.availability, policy.maxAvailabilityCallsPerConnectionStation - (diagnostics.availabilityCallsByConnectionStation[station.stationCode] ?? 0)) <= 1) break;
        const segment = await usable(harder.train, harder.boardingDate, travelClass, false, station.stationCode);
        if (segment) viable.push(segment);
        if (viable.length >= budget.config.maxResults - results.length) break;
      }
      reservedOtherRequests = [];
      if (orchestrator && diagnostics.availabilityCalls + diagnostics.availabilityCacheHits > beforeChecks) orchestrator.markMeaningfulAttempt('oneChange');
      if (orchestrator && orchestrator.preventedByReservation > reservationBefore) deferPair();
      if (!viable.length) return;
      for (const travelClass of candidateClasses(other.train, request.classes)) {
        if (full()) break;
        const segment = await usable(other.train, other.boardingDate, travelClass, false, station.stationCode);
        if (!segment) continue;
        const hardSegment = viable.shift()!; viable.push(hardSegment);
        const segments: [JourneySegment, JourneySegment] = firstHarder ? [hardSegment, segment] : [segment, hardSegment];
        add({ type: 'DIFFERENT_TRAIN_CONNECTION', connectionStationCode: station.stationCode,
          connectionStationName: station.stationName, connectionMinutes: pair.connectionMinutes,
          connectionSafety: pair.connectionSafety, totalScheduledDurationMinutes: pair.duration,
          segments, totalFare: totalFare(segments), totalLiveAvailabilityCallsUsed: 0 });
      }
    };
    for (const station of stations.slice(0, stationLimit)) {
      if (full()) break;
      if (!budget.canCall('discovery') || !budget.canCall('availability')) break;
      diagnostics.connectionStationsQueried.push(station.stationCode);
      const firstRequest: TrainSearchRequest = { fromStationCode: request.fromStationCode, toStationCode: station.stationCode, journeyDate: request.journeyDate };
      const incomingResponse = await session.discover(firstRequest);
      if (incomingResponse?.providerState === 'SUCCESS') diagnostics.firstLegTrainsDiscovered += incomingResponse.trains.length;
      const incoming: ScheduledRun[] = [];
      for (const train of selectTrains(incomingResponse, firstRequest, request.classes, budget.config.maxTrainsPerLeg)) {
        const run = await timedRun(train, request.journeyDate, session);
        if (run) incoming.push(run);
      }
      if (!incoming.length) continue;
      const dates = [...new Set(incoming.flatMap((run) => departureDates(run.arrival, times)))].sort((a, b) => parseDate(a) - parseDate(b));
      const outgoing: ScheduledRun[] = [];
      for (const date of dates) {
        const remaining = budget.config.maxTrainsPerLeg - outgoing.length;
        if (remaining <= 0) break;
        const secondRequest: TrainSearchRequest = { fromStationCode: station.stationCode, toStationCode: request.toStationCode, journeyDate: date };
        const outgoingResponse = await session.discover(secondRequest);
        if (outgoingResponse?.providerState === 'SUCCESS') diagnostics.secondLegTrainsDiscovered += outgoingResponse.trains.length;
        // A same-day departure outside every safe window must not crowd out next-day trains.
        const timelyResponse = outgoingResponse?.providerState === 'SUCCESS' ? {
          ...outgoingResponse,
          trains: outgoingResponse.trains.filter((train) => {
            const run = scheduledRun(train, date);
            if (!run || incoming.some((first) => connectionSafety(run.departure - first.arrival, times))) return true;
            diagnostics.trainPairsRejectedByTiming += incoming.length;
            return false;
          }),
        } : outgoingResponse;
        for (const train of selectTrains(timelyResponse, secondRequest, request.classes, remaining)) {
          const run = await timedRun(train, date, session);
          if (run) outgoing.push(run);
        }
      }
      if (!outgoing.length) continue;
      const pairs = compatiblePairs(incoming, outgoing, times, budget.config.maxTrainPairsPerConnection, diagnostics);
      for (const pair of pairs) {
        if (full() || !budget.canCall('availability')) break;
        await checkPair(pair, station);
      }
    }
    return finish(full() ? 'MAX_RESULTS_REACHED' : !budget.canCall('availability') ? 'AVAILABILITY_BUDGET_EXHAUSTED' :
      !budget.canCall('discovery') ? 'TRAIN_DISCOVERY_BUDGET_EXHAUSTED' : stations.length > stationLimit ?
        (stationLimit < budget.config.maxConnectionStations ? 'DIRECT_RESULTS_REDUCED_CONNECTION_LIMIT' : 'MAX_CONNECTION_STATIONS_REACHED') : 'CANDIDATES_EXHAUSTED');
  }
}
