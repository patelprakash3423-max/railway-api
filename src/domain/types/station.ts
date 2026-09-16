export interface Coordinates { latitude: number; longitude: number }
export interface TrainStop {
  stationCode: string;
  stationName: string;
  arrivalTime: string | null;
  departureTime: string | null;
  haltMinutes: number;
  distanceKm: number;
  dayNumber: number;
  platform?: string;
  coordinates?: Coordinates;
}
