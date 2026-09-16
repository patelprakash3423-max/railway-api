import type { TrainDetails } from '../../domain/types/train.js';
import type { TrainStop } from '../../domain/types/station.js';
import type { Fare } from '../../domain/types/fare.js';
import type { AvailabilityDay, AvailabilityRequest, AvailabilityResult } from '../../domain/types/availability.js';
import { ProviderError, providerError, redact } from '../../utils/errors.js';

const inventoryMessage = 'Sorry, this train is not available for booking for this date';
function invalid(field: string): never {
  throw new ProviderError('PROVIDER_ERROR', `Invalid RailKit response: ${field}`, 'INVALID_PROVIDER_RESPONSE');
}
function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(field);
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) invalid(field);
  return redact(value);
}
function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' ? redact(value) : undefined;
}
function number(value: unknown, field: string): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.trim()))) invalid(field);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) invalid(field);
  return parsed;
}
function time(value: unknown): string | null {
  if (value === undefined || value === null || value === '--' || value === '') return null;
  return text(value, 'time');
}
function payload(value: unknown): Record<string, unknown> {
  const response = record(value, 'envelope');
  if (response.success === false) {
    const message = optionalText(response.error) ?? 'RailKit returned an unspecified error';
    throw new ProviderError(response.error === inventoryMessage ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_ERROR', message, response.error === inventoryMessage ? 'BOOKING_UNSUPPORTED' : undefined);
  }
  if (response.success !== true) invalid('success');
  return record(response.data, 'data');
}
function stop(value: unknown): TrainStop {
  const raw = record(value, 'route stop');
  const halt = raw.haltMinutes ?? (typeof raw.halt === 'string' ? /^(\d+)\s*min(?:s|utes)?$/i.exec(raw.halt.trim())?.[1] : undefined);
  const day = number(raw.day, 'day');
  if (!Number.isInteger(day) || day < 1) invalid('day');
  const result: TrainStop = {
    stationCode: text(raw.stnCode, 'station code'), stationName: text(raw.stnName, 'station name'),
    arrivalTime: time(raw.arrival), departureTime: time(raw.departure),
    haltMinutes: number(halt, 'halt minutes'), distanceKm: number(raw.distance, 'distance'), dayNumber: day,
  };
  if (typeof raw.platform === 'string' || typeof raw.platform === 'number') result.platform = redact(String(raw.platform));
  if (raw.coordinates != null) {
    const coordinates = record(raw.coordinates, 'coordinates');
    // Coordinates may be negative, unlike distances and fares.
    const coordinate = (value: unknown, limit: number): number => {
      if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value.trim()))) invalid('coordinates');
      const n = Number(value);
      if (!Number.isFinite(n) || Math.abs(n) > limit) invalid('coordinates');
      return n;
    };
    result.coordinates = { latitude: coordinate(coordinates.latitude, 90), longitude: coordinate(coordinates.longitude, 180) };
  }
  return result;
}
export function normalizeTrainInfo(value: unknown): TrainDetails {
  const data = payload(value);
  const train = record(data.trainInfo, 'trainInfo');
  if (!Array.isArray(data.route)) invalid('route');
  return {
    trainNumber: text(train.train_no, 'train number'), trainName: text(train.train_name, 'train name'),
    sourceStationCode: text(train.from_stn_code, 'source code'), sourceStationName: text(train.from_stn_name, 'source name'),
    destinationStationCode: text(train.to_stn_code, 'destination code'), destinationStationName: text(train.to_stn_name, 'destination name'),
    sourceDepartureTime: time(train.from_time), destinationArrivalTime: time(train.to_time),
    travelTimeText: optionalText(train.travel_time), trainType: optionalText(train.type),
    runningDays: typeof train.running_days === 'number' ? String(train.running_days) : optionalText(train.running_days),
    route: data.route.map(stop),
  };
}
export function normalizeFare(value: unknown): Fare {
  const raw = record(value, 'fare');
  const fare: Fare = { totalFare: number(raw.totalFare, 'total fare'), currency: 'INR' };
  // Only fields observed in RailKit are mapped. No guessed catering/dynamic aliases.
  for (const field of ['baseFare', 'reservationCharge', 'superfastCharge', 'serviceTax'] as const) {
    if (raw[field] !== undefined) fare[field] = number(raw[field], field);
  }
  return fare;
}
function normalizeDay(value: unknown): AvailabilityDay {
  const raw = record(value, 'availability day');
  const state = text(raw.status, 'status').trim().toUpperCase();
  if (state !== 'AVAILABLE' && state !== 'RAC' && state !== 'WAITLIST' && state !== 'NOT_AVAILABLE') invalid('unknown availability status');
  const date = text(raw.date, 'date');
  const match = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(date);
  if (!match) invalid('availability date');
  const [day, month, year] = match.slice(1).map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCDate() !== day || parsed.getUTCMonth() !== month - 1 || parsed.getUTCFullYear() !== year) invalid('availability date');
  const result: AvailabilityDay = {
    date: `${String(day).padStart(2, '0')}-${String(month).padStart(2, '0')}-${year}`,
    state, availabilityText: optionalText(raw.availabilityText), rawStatus: optionalText(raw.rawStatus),
  };
  if (typeof raw.canBook === 'boolean') result.canBook = raw.canBook;
  if (raw.predictionPercentage !== undefined) {
    const prediction = number(raw.predictionPercentage, 'prediction');
    if (prediction > 100) invalid('prediction');
    result.predictionPercentage = prediction;
  }
  const safeCount = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
  };
  if (state === 'WAITLIST') {
    const waitlist = /^(GNWL|RLWL|PQWL|RQWL|TQWL|WL)\s*(\d+)(?:\s*\/\s*WL\s*(\d+))?$/i.exec(result.rawStatus?.trim() ?? '');
    if (waitlist) {
      result.waitlistType = waitlist[1].toUpperCase();
      result.waitlistNumber = safeCount(waitlist[3] ?? waitlist[2]);
    } else {
      const current = /^WL\s*(\d+)$/i.exec(result.availabilityText?.trim() ?? '');
      result.waitlistNumber = safeCount(current?.[1]);
    }
  }
  if (state === 'AVAILABLE') {
    const count = /^(?:AVAILABLE|AVBL)\s*[-:]?\s*(\d+)$/i.exec(result.availabilityText?.trim() ?? '');
    result.availableCount = safeCount(count?.[1]);
  }
  return result;
}
export function availabilityFailure(request: AvailabilityRequest, error: unknown): AvailabilityResult {
  const failure = providerError(error);
  return { request: { ...request }, provider: 'railkit', providerState: failure.providerState, days: [], failureCategory: failure.failureCategory, providerMessage: failure.message };
}
export function normalizeAvailability(value: unknown, request: AvailabilityRequest): AvailabilityResult {
  try {
    const data = payload(value);
    if (!Array.isArray(data.availability)) invalid('availability array');
    const train = data.train === undefined ? undefined : record(data.train, 'train');
    return {
      request: { ...request }, provider: 'railkit', providerState: 'SUCCESS',
      trainName: optionalText(train?.trainName),
      fare: data.fare === undefined ? undefined : normalizeFare(data.fare),
      days: data.availability.map(normalizeDay),
    };
  } catch (error: unknown) { return availabilityFailure(request, error); }
}
