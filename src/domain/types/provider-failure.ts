export type ProviderFailureCategory = 'RATE_LIMITED'|'BOOKING_UNSUPPORTED'|'INVALID_PROVIDER_RESPONSE'|'UNKNOWN_PROVIDER_ERROR';
/** Only structural HTTP status evidence or explicit normalized tags. Never guess from message text. */
export function providerFailureCategory(value:unknown):ProviderFailureCategory {
 if(value&&typeof value==='object') {
  const v=value as {status?:unknown;statusCode?:unknown;response?:{status?:unknown};failureCategory?:unknown;providerState?:unknown};
  if(v.status===429||v.statusCode===429||v.response?.status===429||v.failureCategory==='RATE_LIMITED')return 'RATE_LIMITED';
  if(v.failureCategory==='INVALID_PROVIDER_RESPONSE')return 'INVALID_PROVIDER_RESPONSE';
  if(v.failureCategory==='BOOKING_UNSUPPORTED')return 'BOOKING_UNSUPPORTED';
 }
 return 'UNKNOWN_PROVIDER_ERROR';
}
