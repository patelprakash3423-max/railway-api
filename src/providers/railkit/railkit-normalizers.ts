import type { TrainDetails } from '../../domain/types/train.js';
import type { TrainStop } from '../../domain/types/station.js';
import type { Fare } from '../../domain/types/fare.js';
import type { AvailabilityDay, AvailabilityRequest, AvailabilityResult } from '../../domain/types/availability.js';
import {providerTransportEvidence} from '../../domain/types/provider-failure.js';
import { ProviderError, redact } from '../../utils/errors.js';

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
  const date = availabilityDate(raw.date);
  const result: AvailabilityDay = {
    date,
    state, availabilityText: optionalText(raw.availabilityText), rawStatus: optionalText(raw.rawStatus),
  };
  if(raw.canBook!==undefined&&typeof raw.canBook!=='boolean')invalid('canBook');
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
/** Only explicit dates/codes are compared; station names and timetable endpoints are not aliases. */
function availabilityDate(value: unknown): string {
 const date=text(value,'date').trim();
 const iso=/^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
 const match=/^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(date);
 if(!iso&&!match)invalid('availability date');
 const [day,month,year]=iso?[Number(iso[3]),Number(iso[2]),Number(iso[1])]:match!.slice(1).map(Number);
 const parsed=new Date(Date.UTC(year,month-1,day));
 if(parsed.getUTCDate()!==day||parsed.getUTCMonth()!==month-1||parsed.getUTCFullYear()!==year)invalid('availability date');
 return `${String(day).padStart(2,'0')}-${String(month).padStart(2,'0')}-${year}`;
}
function validateIdentity(data: Record<string,unknown>, train: Record<string,unknown>|undefined, request: AvailabilityRequest): void {
 const code=(value:unknown)=>text(value,'availability identity').trim().toUpperCase();
 for(const [field,expected] of [['trainNo',request.trainNumber],['from',request.fromStationCode],['to',request.toStationCode],['travelClass',request.travelClass],['quota',request.quota]] as const){
  if(train?.[field]!==undefined&&code(train[field])!==code(expected))invalid(`conflicting ${field}`);
 }
 // A daily availability array may legitimately include adjacent dates. An explicit
 // request-level journeyDate, when supplied, must identify the requested journey.
 for(const source of [data,train])if(source?.journeyDate!==undefined&&availabilityDate(source.journeyDate)!==availabilityDate(request.journeyDate))invalid('conflicting journeyDate');
}
export function availabilityFailure(request: AvailabilityRequest, error: unknown): AvailabilityResult {
 const evidence=providerTransportEvidence(error);
 return {request:{...request},provider:'railkit',providerState:evidence.failureCategory==='BOOKING_UNSUPPORTED'?'PROVIDER_UNAVAILABLE':'PROVIDER_ERROR',
  days:[],failureCategory:evidence.failureCategory,providerMessage:evidence.message,transportEvidence:evidence};
}
export function normalizeAvailability(value: unknown, request: AvailabilityRequest): AvailabilityResult {
  try {
    const evidence=providerTransportEvidence(value);
    const envelope=record(value,'envelope');
    if((evidence.statusCode!==undefined&&evidence.statusCode>=400)||envelope.success===false||envelope.transportEvidence!==undefined)return availabilityFailure(request,value);
    const data = payload(value);
    if (!Array.isArray(data.availability)) invalid('availability array');
    const train = data.train === undefined ? undefined : record(data.train, 'train');
    validateIdentity(data,train,request);
    return {
      request: { ...request }, provider: 'railkit', providerState: 'SUCCESS',
      trainName: optionalText(train?.trainName),
      fare: data.fare === undefined ? undefined : normalizeFare(data.fare),
      days: data.availability.map(normalizeDay),
    };
  } catch (error: unknown) { return availabilityFailure(request, {transportEvidence:providerTransportEvidence(error,providerTransportEvidence(value).statusCode)}); }
}
