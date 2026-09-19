import { getTrainInfo, getAvailability, searchTrainBetweenStations } from 'railkit';
import { configureRailKit } from '../../config/railkit.js';
import { incrementApiCallCount } from '../../utils/api-call-counter.js';
import {processAvailabilityScheduler,type AvailabilityScheduler} from './availability-scheduler.js';
import {validateAvailabilityRequest} from '../../utils/availability-input.js';
import type {AvailabilityRequest} from '../../domain/types/availability.js';
import {installAvailabilityAbortTransport} from './availability-abort.js';
import {availabilitySdkInvoked} from '../availability-observation.js';

// Shared SDK boundary for normalized providers and the original raw playground.
// Counts SDK invocations, not provider billing or undocumented SDK internals.
export async function rawTrainInfo(trainNumber: string): Promise<unknown> {
  configureRailKit();
  incrementApiCallCount();
  return getTrainInfo(trainNumber);
}
export async function scheduledAvailability(scheduler:AvailabilityScheduler,...args:Parameters<typeof getAvailability>):Promise<unknown>{
  configureRailKit();
  const [trainNumber,fromStationCode,toStationCode,journeyDate,travelClass,quota]=args;
  const request={trainNumber,fromStationCode,toStationCode,journeyDate,travelClass,quota} as AvailabilityRequest;
  validateAvailabilityRequest(request);
  return scheduler.execute(request,async()=>{
    configureRailKit();
    installAvailabilityAbortTransport();
    scheduler.quota.consume();
    availabilitySdkInvoked();
    incrementApiCallCount();
    return getAvailability(...args);
  });
}
export async function rawAvailability(...args:Parameters<typeof getAvailability>):Promise<unknown>{
  return scheduledAvailability(processAvailabilityScheduler(),...args);
}

export async function rawTrainsBetween(...args: Parameters<typeof searchTrainBetweenStations>): Promise<unknown> {
  configureRailKit();
  incrementApiCallCount();
  return searchTrainBetweenStations(...args);
}
