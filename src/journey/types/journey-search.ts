import type { TravelClass } from './journey-segment.js';
import type { SameTrainJourneyResult as JourneyResult } from './journey-result.js';
import type { SearchDiagnostics } from '../utils/search-diagnostics.js';
export interface JourneySearchRequest {
  trainNumber: string;
  fromStationCode: string;
  toStationCode: string;
  /** Boarding date at fromStationCode, DD-MM-YYYY. */
  journeyDate: string;
  classes: TravelClass[];
  quota: 'GN';
}
export interface JourneySearchResponse {
  results: JourneyResult[];
  diagnostics: SearchDiagnostics;
}
