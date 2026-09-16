import type { TravelClass } from '../../journey/types/journey-segment.js';
export const MIN_RESERVED_COVERAGE = 0.50;
export type StationRef = { code: string; name?: string };
export type ReservedCoverage = { ratio: number; percentage: number; method: 'DISTANCE' | 'ROUTE_SPAN' };
export type RecoveryType = 'ALTERNATE_BOARDING' | 'ALTERNATE_DROP' | 'ALTERNATE_BOARDING_AND_DROP';
export type RecoveryQuality = 'EXCELLENT' | 'STRONG' | 'USEFUL' | 'LAST_RESORT';
export type RecoveryWarning = 'SELF_MANAGED_START' | 'SELF_MANAGED_END' | 'PARTIAL_RESERVED_COVERAGE' | 'RAC_NOT_CONFIRMED_BERTH' | 'SELF_MANAGED_COST_NOT_INCLUDED';
export type ReservedTrainSegment = { type: 'RESERVED_TRAIN'; trainNumber: string; trainName?: string; from: StationRef; to: StationRef;
  journeyDate: string; classCode: TravelClass; quota: 'GN'; availability: 'AVAILABLE' | 'RAC'; availabilityText?: string;
  fare?: number; scheduledDeparture?: string; scheduledArrival?: string; distanceKm?: number };
export type SelfManagedSegment = { type: 'SELF_MANAGED'; from: StationRef; to: StationRef; reason: 'ALTERNATE_BOARDING' | 'ALTERNATE_DROP' | 'UNRESERVED_EDGE'; distanceKm?: number; note: string };
export type RecoverySegment = ReservedTrainSegment | SelfManagedSegment;
export interface JourneyRecoveryCandidate {
  type: 'JOURNEY_RECOVERY'; kind: 'JOURNEY_RECOVERY'; requestedFrom: StationRef; requestedTo: StationRef;
  segments: RecoverySegment[]; reservedCoverage: ReservedCoverage; reservedSegmentCount: number; selfManagedSegmentCount: number;
  trainChangeCount: number; classChangeCount: number; totalReservedFare?: number; recoveryType: RecoveryType;
  quality: RecoveryQuality; score: number; warnings: RecoveryWarning[]; explanation: string;
}
export interface RecoveryDiagnostics {
  recoveryCandidatesGenerated: number; recoveryCandidatesCoveragePruned: number; recoveryAvailabilityChecks: number;
  recoveryCacheHits: number; recoveryUsableCandidates: number; recoveryDominatedCandidatesRemoved: number;
  recoveryDuplicatesRemoved: number; recoveryStrongStopCount: number;
}
export function recoveryDiagnostics(): RecoveryDiagnostics { return { recoveryCandidatesGenerated: 0, recoveryCandidatesCoveragePruned: 0,
  recoveryAvailabilityChecks: 0, recoveryCacheHits: 0, recoveryUsableCandidates: 0, recoveryDominatedCandidatesRemoved: 0,
  recoveryDuplicatesRemoved: 0, recoveryStrongStopCount: 0 }; }
export type RecoveryConfig = { boarding: number; drop: number; doublePairs: number; availabilityCalls: number };
export const recoveryModes: Record<'QUICK' | 'STANDARD' | 'DEEP', RecoveryConfig> = {
  QUICK: { boarding: 2, drop: 2, doublePairs: 2, availabilityCalls: 6 },
  STANDARD: { boarding: 4, drop: 4, doublePairs: 6, availabilityCalls: 12 },
  DEEP: { boarding: 6, drop: 6, doublePairs: 10, availabilityCalls: 18 },
};
