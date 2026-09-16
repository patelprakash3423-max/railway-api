import type { TrainSearchRequest, TrainSearchResult } from '../domain/types/train-search.js';
import type { TrainDetails } from '../domain/types/train.js';
import type { AvailabilityRequest, AvailabilityResult } from '../domain/types/availability.js';
export interface RailwayProvider {
  searchTrainsBetweenStations(request: TrainSearchRequest): Promise<TrainSearchResult>;
  getTrainInfo(trainNumber: string): Promise<TrainDetails>;
  getAvailability(request: AvailabilityRequest): Promise<AvailabilityResult>;
}
