import type { ProviderState } from './provider.js';
import type { TravelClass } from '../../journey/types/journey-segment.js';
export interface TrainSearchRequest {
  fromStationCode: string;
  toStationCode: string;
  journeyDate: string;
}
export interface TrainCandidate {
  trainNumber: string;
  trainName: string;
  sourceStationCode?: string;
  sourceStationName?: string;
  destinationStationCode?: string;
  destinationStationName?: string;
  fromStationName?: string;
  toStationName?: string;
  travelTimeText?: string;
  haltCount?: number;
  fromStationCode: string;
  toStationCode: string;
  departureTime: string | null;
  arrivalTime: string | null;
  sourceDayNumber?: number;
  destinationDayNumber?: number;
  durationMinutes?: number;
  distanceKm?: number;
  availableClasses?: TravelClass[];
  runningDays?: string;
  trainType?: string;
}
export interface TrainSearchResult {
  provider: string;
  providerState: ProviderState;
  trains: TrainCandidate[];
  failureCategory?: import('./provider-failure.js').ProviderFailureCategory;
  providerMessage?: string;
}
