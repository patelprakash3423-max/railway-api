import type { TravelClass } from '../types/journey-segment.js';
import type { JourneyResult } from '../types/journey-result.js';
export interface ConnectionSearchRequest {
  fromStationCode: string;
  toStationCode: string;
  journeyDate: string;
  classes: TravelClass[];
  quota: 'GN';
}
export interface ConnectionSearchDiagnostics {
  /** Provider invocations, including failures; adapter/global SDK count is reported separately by CLI. */
  totalExternalApiCalls: number;
  trainDiscoveryCalls: number;
  trainDiscoveryCacheHits: number;
  trainInfoCalls: number;
  trainInfoCacheHits: number;
  availabilityCalls: number;
  availabilityCacheHits: number;
  directSearchRounds: number;
  directChecksSkippedAfterStrongResult: number;
  effectiveConnectionStationLimit: number;
  availabilityCallsByPhase: { direct: number; connection: number; recovery?: number; multi?: number };
  availabilityCallsByConnectionStation: Record<string, number>;
  directPhaseSoftLimitReached: boolean;
  connectionSearchSkippedReason?: string;
  directSearchQuality: { availableResults: number; racResults: number };
  directTrainsDiscovered: number;
  directAvailabilityChecks: number;
  connectionStationsConsidered: number;
  connectionStationCandidates: { stationCode: string; score: number }[];
  connectionStationsQueried: string[];
  firstLegTrainsDiscovered: number;
  secondLegTrainsDiscovered: number;
  trainPairsGenerated: number;
  trainPairsRejectedByTiming: number;
  trainPairsCheckedForAvailability: number;
  sameTrainPairsRejected: number;
  providerUnavailableCount: number;
  providerErrorCount: number;
  waitlistCount: number;
  providerCircuitBreakerSkips: number;
  likelyProviderUnsupported: { trainNumber: string; journeyDate: string }[];
  missingTimingCount: number;
  missingRequestedDateCount: number;
  resultsCount: number;
  trainDiscoveryBudgetExhausted: boolean;
  trainInfoBudgetExhausted: boolean;
  availabilityBudgetExhausted: boolean;
  insufficientRemainingBudgetForNextExpansion?: boolean;
  budgetOrchestration?: import('../../application/search-budget-orchestrator.js').BudgetOrchestrationDiagnostics;
  earlyStopReason?: string;
}
export interface ConnectionSearchResponse { multi?: { candidates: import('../../domain/planner/types.js').MultiTrainJourneyCandidate[]; diagnostics: import('../../domain/planner/types.js').MultiDiagnostics };  recovery?: { candidates: import('../../domain/recovery/types.js').JourneyRecoveryCandidate[]; diagnostics: import('../../domain/recovery/types.js').RecoveryDiagnostics }; results: JourneyResult[]; diagnostics: ConnectionSearchDiagnostics }
export function connectionDiagnostics(): ConnectionSearchDiagnostics {
  return { totalExternalApiCalls: 0, trainDiscoveryCalls: 0, trainDiscoveryCacheHits: 0,
    trainInfoCalls: 0, trainInfoCacheHits: 0, availabilityCalls: 0, availabilityCacheHits: 0,
    directSearchRounds: 0, directChecksSkippedAfterStrongResult: 0, effectiveConnectionStationLimit: 0,
    availabilityCallsByPhase: { direct: 0, connection: 0 }, availabilityCallsByConnectionStation: {},
    directPhaseSoftLimitReached: false, directSearchQuality: { availableResults: 0, racResults: 0 },
    directTrainsDiscovered: 0, directAvailabilityChecks: 0, connectionStationsConsidered: 0,
    connectionStationCandidates: [], connectionStationsQueried: [], firstLegTrainsDiscovered: 0,
    secondLegTrainsDiscovered: 0, trainPairsGenerated: 0, trainPairsRejectedByTiming: 0,
    trainPairsCheckedForAvailability: 0, sameTrainPairsRejected: 0, providerUnavailableCount: 0,
    providerErrorCount: 0, waitlistCount: 0, providerCircuitBreakerSkips: 0, likelyProviderUnsupported: [],
    missingTimingCount: 0, missingRequestedDateCount: 0, resultsCount: 0,
    trainDiscoveryBudgetExhausted: false, trainInfoBudgetExhausted: false, availabilityBudgetExhausted: false };
}
