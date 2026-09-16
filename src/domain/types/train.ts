import type { TrainStop } from './station.js';
export interface TrainDetails {
  trainNumber: string;
  trainName: string;
  sourceStationCode: string;
  sourceStationName: string;
  destinationStationCode: string;
  destinationStationName: string;
  sourceDepartureTime: string | null;
  destinationArrivalTime: string | null;
  travelTimeText?: string;
  trainType?: string;
  runningDays?: string;
  route: TrainStop[];
}
