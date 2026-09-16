import type { TrainSearchRequest, TrainSearchResult, TrainCandidate } from '../../domain/types/train-search.js';
import { providerError, ProviderError, redact } from '../../utils/errors.js';
import { parseDate, clockMinutes } from '../../journey/connection/timing.js';
export function validateTrainSearch(request: TrainSearchRequest): void {
  if (!/^[A-Z]{1,5}$/.test(request.fromStationCode) || !/^[A-Z]{1,5}$/.test(request.toStationCode) || request.fromStationCode === request.toStationCode) throw new Error('Use distinct uppercase station codes of 1–5 letters.');
  parseDate(request.journeyDate);
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed discovery response.');
  return value as Record<string, unknown>;
}
function required(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Missing discovery field.');
  return redact(value);
}
function time(value: unknown): string | null {
  return typeof value === 'string' && clockMinutes(value) !== undefined ? value : null;
}
export function discoveryFailure(error: unknown): TrainSearchResult {
  const failure = providerError(error);
  return { provider: 'railkit', providerState: failure.providerState, trains: [], failureCategory: failure.failureCategory, providerMessage: failure.message };
}
export function normalizeTrainSearch(value: unknown, _request: TrainSearchRequest): TrainSearchResult {
  try {
    const envelope = record(value);
    if (envelope.success === false) throw new ProviderError('PROVIDER_ERROR', typeof envelope.error === 'string' ? envelope.error : 'Train discovery failed.');
    if (envelope.success !== true || !Array.isArray(envelope.data)) throw new Error('Malformed train discovery envelope.');
    const trains = envelope.data.map((item): TrainCandidate => {
      const raw = record(item);
      const trainNumber = required(raw.train_no);
      const fromStationCode = required(raw.from_stn_code);
      const toStationCode = required(raw.to_stn_code);
      if (!/^\d{5}$/.test(trainNumber) || !/^[A-Z]{1,5}$/.test(fromStationCode) || !/^[A-Z]{1,5}$/.test(toStationCode)) throw new Error('Invalid discovery train or station code.');
      const duration = typeof raw.travel_time === 'string' ? /^(\d+):([0-5]\d)\s*hrs?$/i.exec(raw.travel_time.trim()) : null;
      const distance = typeof raw.distance === 'number' || (typeof raw.distance === 'string' && /^\d+(?:\.\d+)?$/.test(raw.distance)) ? Number(raw.distance) : undefined;
      const durationMinutes = duration ? Number(duration[1]) * 60 + Number(duration[2]) : undefined;
      const optionalText = (value: unknown): string | undefined => typeof value === 'string' ? redact(value) : undefined;
      return { trainNumber, trainName: required(raw.train_name), fromStationCode, toStationCode,
        sourceStationCode: optionalText(raw.source_stn_code), sourceStationName: optionalText(raw.source_stn_name),
        destinationStationCode: optionalText(raw.dstn_stn_code), destinationStationName: optionalText(raw.dstn_stn_name),
        fromStationName: optionalText(raw.from_stn_name), toStationName: optionalText(raw.to_stn_name),
        travelTimeText: optionalText(raw.travel_time),
        haltCount: typeof raw.halts === 'number' && Number.isSafeInteger(raw.halts) && raw.halts >= 0 ? raw.halts : undefined,
        departureTime: time(raw.from_time), arrivalTime: time(raw.to_time),
        durationMinutes: durationMinutes !== undefined && Number.isSafeInteger(durationMinutes) ? durationMinutes : undefined,
        distanceKm: distance !== undefined && Number.isFinite(distance) && distance >= 0 ? distance : undefined,
        runningDays: typeof raw.running_days === 'string' ? redact(raw.running_days) : undefined };
    });
    return { provider: 'railkit', providerState: 'SUCCESS', trains };
  } catch (error: unknown) { return discoveryFailure(error); }
}
