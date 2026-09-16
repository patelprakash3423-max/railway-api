import type { TrainCandidate } from '../domain/types/train-search.js';
import type { ConnectionSearchRequest } from '../journey/connection/types.js';
import type { ConnectionProviderSession } from '../journey/connection/provider-session.js';
import { candidateClasses } from '../journey/connection/candidates.js';
import { addDays, routeDayOffset } from '../journey/connection/timing.js';
import { recoveryEdges } from '../domain/recovery/edges.js';
import { rankRecovery, scoreRecovery } from '../domain/recovery/ranking.js';
import { recoveryDiagnostics, type JourneyRecoveryCandidate, type RecoveryConfig, type RecoverySegment, type RecoveryWarning } from '../domain/recovery/types.js';
export async function searchRecovery(request: ConnectionSearchRequest, trains: TrainCandidate[], session: ConnectionProviderSession, config: RecoveryConfig, fullTrains: Set<string>) {
  if (Object.values(config).some((v) => !Number.isSafeInteger(v) || v < 0 || v > 100)) throw new Error('Invalid recovery limits');
  const diagnostics = recoveryDiagnostics(); const candidates: JourneyRecoveryCandidate[] = [];
  const limit = Math.min(session.budget.config.maxAvailabilityCalls, session.diagnostics.availabilityCalls + config.availabilityCalls);
  for (const train of trains) {
    if (fullTrains.has(train.trainNumber)) continue;
    const info = await session.info(train.trainNumber); if (!info) continue;
    const route = info.route;
    const i = route.findIndex((s) => s.stationCode === request.fromStationCode);
    const j = route.findIndex((s) => s.stationCode === request.toStationCode);
    if (i < 0 || j <= i || new Set(route.slice(i, j + 1).map((s) => s.stationCode)).size !== j - i + 1) continue;
    const groups = recoveryEdges(route, i, j, config, diagnostics);
    let strong = false; let singleQuality = false;
    for (let phase = 0; phase < groups.length; phase++) {
      if (strong || (phase === 2 && singleQuality)) break;
      const successful = new Set<string>();
      for (const travelClass of candidateClasses(train, request.classes)) {
        if (strong) break;
        for (const edge of groups[phase]) {
          const key = `${edge.from}:${edge.to}`;
          if (successful.has(key)) continue;
          let date: string;
          try { date = addDays(request.journeyDate, routeDayOffset(route[i].dayNumber, route[edge.from].dayNumber)); } catch { continue; }
          const before = session.diagnostics.availabilityCalls, hits = session.diagnostics.availabilityCacheHits;
          const result = await session.availability({ trainNumber: train.trainNumber, fromStationCode: route[edge.from].stationCode,
            toStationCode: route[edge.to].stationCode, journeyDate: date, travelClass, quota: request.quota }, false,
            { directLimit: 0, stationLimit: 0, recoveryLimit: limit });
          diagnostics.recoveryAvailabilityChecks += session.diagnostics.availabilityCalls - before;
          diagnostics.recoveryCacheHits += session.diagnostics.availabilityCacheHits - hits;
          if (!result || result.providerState !== 'SUCCESS') continue;
          const days = result.days.filter((d) => d.date === date); if (days.length !== 1) continue;
          const day = days[0]; if ((day.state !== 'AVAILABLE' && day.state !== 'RAC') || day.canBook === false) continue;
          const ref = (n: number) => ({ code: route[n].stationCode, name: route[n].stationName });
          const distance = (a: number, b: number) => edge.coverage.method === 'DISTANCE' ? route[b].distanceKm - route[a].distanceKm : undefined;
          const segments: RecoverySegment[] = []; const warnings: RecoveryWarning[] = ['PARTIAL_RESERVED_COVERAGE', 'SELF_MANAGED_COST_NOT_INCLUDED'];
          const note = 'Passenger must independently manage this portion. Reservation is not provided by this option.';
          if (edge.from > i) { segments.push({ type: 'SELF_MANAGED', from: ref(i), to: ref(edge.from), reason: 'ALTERNATE_BOARDING', distanceKm: distance(i, edge.from), note }); warnings.push('SELF_MANAGED_START'); }
          const fare = result.fare?.totalFare;
          const validFare = fare !== undefined && Number.isFinite(fare) && fare >= 0 ? fare : undefined;
          segments.push({ type: 'RESERVED_TRAIN', trainNumber: train.trainNumber, trainName: info.trainName, from: ref(edge.from), to: ref(edge.to),
            journeyDate: date, classCode: travelClass, quota: request.quota, availability: day.state, availabilityText: day.availabilityText,
            fare: validFare, distanceKm: distance(edge.from, edge.to) });
          if (edge.to < j) { segments.push({ type: 'SELF_MANAGED', from: ref(edge.to), to: ref(j), reason: 'ALTERNATE_DROP', distanceKm: distance(edge.to, j), note }); warnings.push('SELF_MANAGED_END'); }
          if (day.state === 'RAC') warnings.push('RAC_NOT_CONFIRMED_BERTH');
          const count = segments.length - 1;
          const excellent = edge.coverage.ratio >= .9 && day.state === 'AVAILABLE' && count === 1;
          const candidate: JourneyRecoveryCandidate = { type: 'JOURNEY_RECOVERY', kind: 'JOURNEY_RECOVERY', requestedFrom: ref(i), requestedTo: ref(j), segments,
            reservedCoverage: edge.coverage, reservedSegmentCount: 1, selfManagedSegmentCount: count, trainChangeCount: 0, classChangeCount: 0,
            totalReservedFare: validFare, recoveryType: count === 2 ? 'ALTERNATE_BOARDING_AND_DROP' : edge.from > i ? 'ALTERNATE_BOARDING' : 'ALTERNATE_DROP',
            quality: excellent ? 'EXCELLENT' : edge.coverage.ratio >= .75 ? 'STRONG' : 'USEFUL', score: 0, warnings,
            explanation: `${edge.coverage.percentage}% of the requested rail journey is covered by reserved segments${edge.coverage.method === 'ROUTE_SPAN' ? ' (estimated by route stop span)' : ''}. Reserved ${travelClass} travel from ${ref(edge.from).name} to ${ref(edge.to).name}: ${day.state}. ${segments.filter((s) => s.type === 'SELF_MANAGED').map((s) => `Independently manage ${s.from.name} to ${s.to.name}.`).join(' ')}` };
          candidate.score = scoreRecovery(candidate, request.classes); candidates.push(candidate); diagnostics.recoveryUsableCandidates++;
          if (day.state === 'AVAILABLE') successful.add(key);
          if (phase < 2 && edge.coverage.ratio >= .75 && day.state === 'AVAILABLE') singleQuality = true;
          if (excellent) { strong = true; diagnostics.recoveryStrongStopCount++; break; }
        }
      }
    }
  }
  return { candidates: rankRecovery(candidates, diagnostics), diagnostics };
}
