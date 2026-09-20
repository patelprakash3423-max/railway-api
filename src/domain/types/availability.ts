import type {ProviderIdentityEvidence} from '../../providers/availability-evidence.js';
import type { Fare } from './fare.js';
import type { ProviderState } from './provider.js';
export type AvailabilityState = 'AVAILABLE' | 'RAC' | 'WAITLIST' | 'NOT_AVAILABLE' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_ERROR';
export interface AvailabilityRequest {
  trainNumber: string;
  fromStationCode: string;
  toStationCode: string;
  journeyDate: string;
  travelClass: string;
  quota: 'GN';
}
export interface AvailabilityDay {
  date: string;
  state: Exclude<AvailabilityState, 'PROVIDER_UNAVAILABLE' | 'PROVIDER_ERROR'>;
  availabilityText?: string;
  rawStatus?: string;
  availableCount?: number;
  waitlistType?: string;
  waitlistNumber?: number;
  predictionPercentage?: number;
  canBook?: boolean;
}
export interface AvailabilityResult {
  /** Internal provider identity observability; never serialized into journey responses. */
  identityEvidence?: ProviderIdentityEvidence;
  request: AvailabilityRequest;
  provider: 'railkit';
  providerState: ProviderState;
  trainName?: string;
  fare?: Fare;
  days: AvailabilityDay[];
  failureCategory?: import('./provider-failure.js').ProviderFailureCategory;
  providerMessage?: string;
  transportEvidence?: import('./provider-failure.js').ProviderTransportEvidence;
}
