import type { ScheduledJourney, ScheduledTrainSegment } from '../types.js';
import type { RailwayDatasetMetadata } from '../../types.js';
import type { StationTier } from './network.js';
export interface V2Leg extends ScheduledTrainSegment { fromStation: string; toStation: string; boardingDateTime: string; distanceKm: number }
export interface V2Journey extends ScheduledJourney { segments: V2Leg[]; totalDistanceKm: number; interchangeTiers: StationTier[]; distanceDetourPercent: number; durationDetourPercent: number }
export interface V2Limits { beamWidth: number; maxExpandedStates: number; maxCompleteCandidates: number; maxResults: number; outgoingTrainCap: number; strongCandidateTarget: number; maxBaselineStates: number }
export const defaultV2Limits: Readonly<V2Limits> = Object.freeze({ beamWidth: 160, maxExpandedStates: 4000, maxCompleteCandidates: 400, maxResults: 30, outgoingTrainCap: 80, strongCandidateTarget: 12, maxBaselineStates: 1200 });
export function deriveMaxChanges(distanceKm: number): number { if (!Number.isFinite(distanceKm) || distanceKm < 0) throw new Error('Invalid baseline distance'); return Math.min(5, Math.max(0, Math.floor(distanceKm / 300))); }
export interface V2Diagnostics {
  baselineDistanceKm: number | null; baselineDurationMinutes: number | null; baselineSource: 'DIRECT' | 'BOUNDED_PATH' | 'NONE'; maxDistanceKm: number | null; maxDurationMinutes: number | null; derivedMaxChanges: number;
  stagesAttempted: string[]; stationTierCounts: Record<StationTier, number>;
  statesGenerated: number; statesExpanded: number; baselineStatesExpanded: number; statesDominated: number; statesTimingPruned: number; statesDistancePruned: number; statesDurationPruned: number; statesLoopPruned: number; statesCalendarPruned: number; statesBackwardPruned: number; statesLowerBoundPruned: number; statesUnknownDistancePruned: number;
  completeCandidatesGenerated: number; candidatesAfterDetourBounds: number; candidatesAfterDominance: number; candidatesAfterDiversity: number; maxFrontierSize: number; truncated: boolean; truncationReasons: string[]; queryDurationMs: number;
}
export interface V2Result { kind: 'SCHEDULED_CANDIDATES_ONLY'; plannerVersion: 2; dataset: RailwayDatasetMetadata; journeys: V2Journey[]; diagnostics: V2Diagnostics }
