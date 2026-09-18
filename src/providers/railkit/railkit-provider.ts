import type { TrainSearchRequest, TrainSearchResult } from '../../domain/types/train-search.js';
import { normalizeTrainSearch, validateTrainSearch, discoveryFailure } from './railkit-discovery.js';
import type { RailwayProvider } from '../railway-provider.js';
import type { TrainDetails } from '../../domain/types/train.js';
import type { AvailabilityRequest, AvailabilityResult } from '../../domain/types/availability.js';
import { rawTrainInfo, rawAvailability, rawTrainsBetween } from './railkit-client.js';
import { normalizeTrainInfo, normalizeAvailability, availabilityFailure } from './railkit-normalizers.js';
import { providerError } from '../../utils/errors.js';
import { validateAvailabilityRequest } from '../../utils/availability-input.js';
import {configureRailKit} from '../../config/railkit.js';
import {ProviderConfigurationError} from '../../application/errors.js';

export class RailKitProvider implements RailwayProvider {
  readonly quotaAccounting = 'SDK_INVOCATION' as const;
  assertConfigured(): void { configureRailKit(); }
  async searchTrainsBetweenStations(request: TrainSearchRequest): Promise<TrainSearchResult> {
    try {
      validateTrainSearch(request);
      return normalizeTrainSearch(await rawTrainsBetween(request.fromStationCode, request.toStationCode, request.journeyDate), request);
    } catch (error: unknown) { return discoveryFailure(error); }
  }

  async getTrainInfo(trainNumber: string): Promise<TrainDetails> {
    try {
      if (!/^\d{5}$/.test(trainNumber)) throw new Error('Train number must contain exactly five digits.');
      return normalizeTrainInfo(await rawTrainInfo(trainNumber));
    } catch (error: unknown) { throw providerError(error); }
  }

  async getAvailability(request: AvailabilityRequest): Promise<AvailabilityResult> {
    const input = { ...request };
    try {
      validateAvailabilityRequest(input);
      const result = await rawAvailability(input.trainNumber, input.fromStationCode,
        input.toStationCode, input.journeyDate, input.travelClass, input.quota);
      return normalizeAvailability(result, input);
    } catch (error: unknown) {
      if (error instanceof ProviderConfigurationError) throw error;
      return availabilityFailure(input, error);
    }
  }
}
