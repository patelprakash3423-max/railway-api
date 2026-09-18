import { getTrainInfo, getAvailability, searchTrainBetweenStations } from 'railkit';
import { configureRailKit } from '../../config/railkit.js';
import { incrementApiCallCount } from '../../utils/api-call-counter.js';
import {availabilitySdkInvoked} from '../availability-observation.js';

// Shared SDK boundary for normalized providers and the original raw playground.
// Counts SDK invocations, not provider billing or undocumented SDK internals.
export async function rawTrainInfo(trainNumber: string): Promise<unknown> {
  configureRailKit();
  incrementApiCallCount();
  return getTrainInfo(trainNumber);
}
export async function rawAvailability(...args: Parameters<typeof getAvailability>): Promise<unknown> {
  configureRailKit();
  availabilitySdkInvoked();
  incrementApiCallCount();
  return getAvailability(...args);
}

export async function rawTrainsBetween(...args: Parameters<typeof searchTrainBetweenStations>): Promise<unknown> {
  configureRailKit();
  incrementApiCallCount();
  return searchTrainBetweenStations(...args);
}
