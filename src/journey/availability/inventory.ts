import type { AvailabilityRequest, AvailabilityResult } from '../../domain/types/availability.js';
import { providerFailureCategory } from '../../domain/types/provider-failure.js';
import type { TravelClass } from '../types/journey-segment.js';
import type { ErrorCategory, InventoryCheck } from './types.js';
import {availabilityRequestKey as requestKey} from '../../utils/availability-key.js';
export {requestKey};
export function errorCategory(value: unknown): ErrorCategory {
  const v = value && typeof value === 'object' ? value as { failureCategory?: string; status?: number; statusCode?: number; providerState?: string } : {};
  const existing = providerFailureCategory(value);
  if (existing !== 'UNKNOWN_PROVIDER_ERROR') return existing;
  if (v.failureCategory === 'UNSUPPORTED_CLASS' || v.failureCategory === 'INVALID_REQUEST') return v.failureCategory;
  if (v.status === 400 || v.statusCode === 400 || v.status === 422 || v.statusCode === 422) return 'INVALID_REQUEST';
  if (v.providerState === 'PROVIDER_UNAVAILABLE') return 'PROVIDER_UNAVAILABLE';
  const message=value&&typeof value==='object'?(value as {providerMessage?:unknown;message?:unknown}):{};
  if([message.providerMessage,message.message].some(m=>typeof m==='string'&&/^class does not exist in this train for this train route[.!]?$/i.test(m.trim())))return 'UNSUPPORTED_CLASS';
  return 'UNKNOWN_PROVIDER_ERROR';
}
export function normalizeInventory(request: AvailabilityRequest, result: AvailabilityResult): InventoryCheck {
  const base = { travelClass: request.travelClass as TravelClass, rawDetails: result };
  if (!result || result.providerState !== 'SUCCESS') {
    const category=errorCategory(result);
    return { ...base, status: category==='UNSUPPORTED_CLASS'?'UNSUPPORTED_CLASS':'PROVIDER_ERROR', errorCategory: category, ...(category==='UNSUPPORTED_CLASS'?{unsupportedScope:'EXACT_REQUEST' as const}:{}) };
  }
  const days = Array.isArray(result.days) ? result.days.filter(d => d.date === request.journeyDate) : [];
  if (!result.request || requestKey(result.request) !== requestKey(request) || days.length !== 1 || !['AVAILABLE','RAC','WAITLIST','NOT_AVAILABLE'].includes(days[0].state)) return { ...base, status: 'PROVIDER_ERROR', errorCategory: 'INVALID_PROVIDER_RESPONSE' };
  const day = days[0];
  if((day.state==='AVAILABLE'||day.state==='RAC')&&day.canBook===false)return {...base,status:'PROVIDER_ERROR',errorCategory:'BOOKING_UNSUPPORTED'};
  const fare = result.fare?.currency === 'INR' && Number.isFinite(result.fare.totalFare) && result.fare.totalFare >= 0 ? result.fare : undefined;
  return { ...base, status: day.state === 'NOT_AVAILABLE' ? 'UNAVAILABLE' : day.state, availabilityText: day.availabilityText, fare };
}
export const usable = (c: InventoryCheck) => c.status === 'AVAILABLE' || c.status === 'RAC';
