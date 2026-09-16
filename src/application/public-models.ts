import type { TravelClass } from '../journey/types/journey-segment.js';
import type { SearchMode } from './search-mode.js';
export interface PublicJourneySearchRequest {
  from: string; to: string; date: string;
  classes?: TravelClass[]; quota?: 'GN'; searchMode?: SearchMode;
}
export interface NormalizedPublicSearch {
  from: string; to: string; date: string; classes: TravelClass[]; quota: 'GN'; mode: SearchMode;
}
export interface PublicJourneySegment {
  trainNumber: string; fromStationCode: string; toStationCode: string;
  journeyDate: string; travelClass: TravelClass; availabilityState: 'AVAILABLE' | 'RAC';
  availabilityText?: string; fare?: { totalFare: number; currency: 'INR' };
}
export interface PublicJourneyResult {
  type: 'DIRECT' | 'SAME_TRAIN_SPLIT' | 'DIFFERENT_TRAIN_CONNECTION';
  trainNumber?: string;
  segments: PublicJourneySegment[];
  totalFare?: number;
  split?: { stationCode?: string; stationName?: string };
  connection?: { stationCode: string; stationName?: string; minutes: number; safety: 'TIGHT' | 'GOOD' | 'LONG' };
  totalScheduledDurationMinutes?: number;
}
export interface PublicJourneySearchResponse {
  requestId: string;
  search: NormalizedPublicSearch;
  results: (PublicJourneyResult | PublicRecoveryResult | PublicMultiResult)[];
  meta: { resultCount: number; searchMode: SearchMode; searchCompleted: boolean; partialResults?: boolean; debugDiagnostics?: import('./search-debug-diagnostics.js').SearchDebugDiagnostics; apiUsage?: import('../domain/usage/search-api-usage.js').SearchApiUsage; providerQuota?: import('../domain/usage/provider-quota.js').ProviderQuotaSnapshot };
  debug?: { providerCalls: number; availabilityCalls: number; cacheHits: number; earlyStopReason?: string; multi?: import('../domain/planner/types.js').MultiDiagnostics; recovery?: import('../domain/recovery/types.js').RecoveryDiagnostics };
}

export type PublicRecoveryResult = Omit<import('../domain/recovery/types.js').JourneyRecoveryCandidate, 'score' | 'kind'>;

export type PublicMultiResult = Omit<import('../domain/planner/types.js').MultiTrainJourneyCandidate, 'score'>;
