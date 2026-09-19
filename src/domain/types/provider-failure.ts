export const providerFailureCategories = ['RATE_LIMITED','BOOKING_UNSUPPORTED','INVALID_PROVIDER_RESPONSE','UNKNOWN_PROVIDER_ERROR',
 'UNSUPPORTED_CLASS','INVALID_REQUEST','AUTHENTICATION_FAILED','ACCESS_DENIED','PROVIDER_SERVER_ERROR','PROVIDER_TIMEOUT','NETWORK_FAILURE'] as const;
export type ProviderFailureCategory = typeof providerFailureCategories[number];
/** Plain, enumerable, allowlisted evidence: never retain headers or raw bodies. */
export interface ProviderTransportEvidence {
 statusCode?: number;
 failureCategory: ProviderFailureCategory;
 message: string;
}
const unsupportedMessage = 'Class does not exist in this train for this train route';
const bookingMessage = 'Sorry, this train is not available for booking for this date';
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
export function providerTransportEvidence(value: unknown, httpStatus?: number): ProviderTransportEvidence {
 const v=object(value), saved=object(v.transportEvidence), response=object(v.response);
 // Direct property access intentionally includes RailKit's non-enumerable statusCode.
 const status=[httpStatus,saved.statusCode,v.statusCode,v.code==='PROVIDER_TIMEOUT'?undefined:v.status,response.status].find(x=>typeof x==='number'&&Number.isInteger(x)&&x>=100&&x<=599) as number|undefined;
 const explicit=saved.failureCategory??v.failureCategory;
 const messages=[saved.message,v.error,v.providerMessage,v.message];
 const unsupported=messages.some(m=>typeof m==='string'&&/^class does not exist in this train for this train route[.!]?$/i.test(m.trim()));
 let category:ProviderFailureCategory;
 if(status===429)category='RATE_LIMITED';
 else if(status===401)category='AUTHENTICATION_FAILED';
 else if(status===403)category='ACCESS_DENIED';
 else if(status!==undefined&&status>=500)category='PROVIDER_SERVER_ERROR';
 else if(status===400&&(unsupported||explicit==='UNSUPPORTED_CLASS')&&
  (explicit===undefined||explicit==='UNKNOWN_PROVIDER_ERROR'||explicit==='UNSUPPORTED_CLASS'||explicit==='INVALID_REQUEST'))category='UNSUPPORTED_CLASS';
 else if(status===400||status===422)category='INVALID_REQUEST';
 else if(status!==undefined&&status>=400)category='UNKNOWN_PROVIDER_ERROR';
 else if(v.code==='PROVIDER_TIMEOUT'||v.name==='TimeoutError')category='PROVIDER_TIMEOUT';
 else if(explicit!=='UNKNOWN_PROVIDER_ERROR'&&providerFailureCategories.includes(explicit as ProviderFailureCategory))category=explicit as ProviderFailureCategory;
 else if(v.providerState!=='PROVIDER_UNAVAILABLE'&&unsupported)category='UNSUPPORTED_CLASS';
 else if(messages.some(m=>m===bookingMessage))category='BOOKING_UNSUPPORTED';
 else category='UNKNOWN_PROVIDER_ERROR';
 return {...(status===undefined?{}:{statusCode:status}),failureCategory:category,
  message:category==='UNSUPPORTED_CLASS'?unsupportedMessage:category==='BOOKING_UNSUPPORTED'?bookingMessage:`Availability provider failure: ${category}.`};
}
export function providerFailureCategory(value:unknown):ProviderFailureCategory {
 return providerTransportEvidence(value).failureCategory;
}
