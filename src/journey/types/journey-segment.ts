import type { Fare } from '../../domain/types/fare.js';
export const travelClasses = ['SL', '3A', '2A', '1A', '3E', '2S', 'CC', 'EC'] as const;
export type TravelClass = typeof travelClasses[number];
export interface JourneySegment {
  trainNumber: string;
  fromStationCode: string;
  toStationCode: string;
  journeyDate: string;
  travelClass: TravelClass;
  availabilityState: 'AVAILABLE' | 'RAC';
  availabilityText?: string;
  fare?: Fare;
}
