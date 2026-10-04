import test from 'node:test';
import assert from 'node:assert/strict';
import {safeProviderErrorDetails,safeProviderErrorMessage} from '../domain/types/provider-error-details.js';
import {providerTransportEvidence} from '../domain/types/provider-failure.js';
import {RailKitProvider} from '../providers/railkit/railkit-provider.js';
import {AvailabilityScheduler} from '../providers/railkit/availability-scheduler.js';
import {AvailabilitySession} from '../journey/availability/session.js';
import {SelectedAvailabilityTrace} from '../journey/availability/selected-diagnostics.js';
import {hardeningConfig} from '../config/hardening.js';
import {normalizeAvailability} from '../providers/railkit/railkit-normalizers.js';
import {requestKey} from '../journey/availability/inventory.js';
const request={trainNumber:'15565',fromStationCode:'BNZ',toStationCode:'ASH',journeyDate:'22-11-2026',travelClass:'3A',quota:'GN' as const};
test('section restriction requires explicit code or unambiguous message',()=>{
 for(const input of [{code:'SECTION_NOT_BOOKABLE'},{code:'BOOKING_SECTION_RESTRICTED'},{error:'Booking not allowed between these stations'},{error:'Booking is not allowed between the selected stations.'}]){
  assert.equal(providerTransportEvidence({statusCode:400,...input}).failureCategory,'SECTION_NOT_BOOKABLE');
 }
 for(const error of ['Bad request','Booking [redacted] [redacted] stations','Booking not allowed for given pair of stations'])assert.equal(providerTransportEvidence({statusCode:400,error}).failureCategory,'INVALID_REQUEST');
 assert.equal(providerTransportEvidence({statusCode:429,code:'SECTION_NOT_BOOKABLE'}).failureCategory,'RATE_LIMITED');
});
test('section restriction stays exact and preserves alternate classes and trace details',async()=>{
 let calls=0;
 const session=new AvailabilitySession({getAvailability:async r=>{calls++;return normalizeAvailability({success:false,statusCode:400,code:'SECTION_NOT_BOOKABLE',error:'Booking not allowed between these stations'},r);}},20,undefined,undefined,true);
 const check=await session.get(request);
 assert.equal(check.status,'SECTION_NOT_BOOKABLE');
 await session.get(request);assert.equal(calls,1);
 for(const edit of [{trainNumber:'15566'},{fromStationCode:'AAA'},{toStationCode:'BBB'},{journeyDate:'23-11-2026'},{travelClass:'SL'}])await session.get({...request,...edit});
 assert.equal(calls,6);assert.equal(session.unsupported.size,0);assert.equal(session.statistics().providerErrors,0);
 assert.notEqual(requestKey(request),requestKey({...request,quota:'TQ'} as unknown as typeof request));
 const trace=new SelectedAvailabilityTrace();trace.evidence(check.evidence!);trace.boundedResult(request,check);
 for(const result of [check.evidence,trace.trace[0],trace.boundedGapProbeResults[0]]){
  assert.equal(result?.failureCategory,'SECTION_NOT_BOOKABLE');assert.equal(result?.providerErrorCode,'SECTION_NOT_BOOKABLE');
  assert.equal(result?.providerErrorMessage,'Booking not allowed between these stations');
 }
});
test('HTTP rejection details survive SDK, normalization, session and bounded selected traces',async t=>{
 const previousFetch=globalThis.fetch,previousKey=process.env.RAILKIT_API_KEY;
 process.env.RAILKIT_API_KEY='offline-details-key';let calls=0;
 globalThis.fetch=async(input,init)=>{
  calls++;assert.equal(String(input),'https://api.railkit.in/api/v1/seats/15565/BNZ/ASH/22-11-2026/3A/GN');assert.equal(init?.body,undefined);
  return new Response(JSON.stringify({success:false,error:'Booking not allowed for given pair of stations',code:'INVALID_STATION_PAIR',headers:{authorization:'PRIVATE_HEADER'},token:'PRIVATE_TOKEN'}),{status:422});
 };
 t.after(()=>{globalThis.fetch=previousFetch;if(previousKey===undefined)delete process.env.RAILKIT_API_KEY;else process.env.RAILKIT_API_KEY=previousKey;});
 const provider=new RailKitProvider(new AvailabilityScheduler(hardeningConfig({})));
 const check=await new AvailabilitySession(provider,1).get(request),trace=new SelectedAvailabilityTrace();
 trace.evidence(check.evidence!);trace.boundedResult(request,check);
 assert.equal(calls,1);assert.equal(check.errorCategory,'INVALID_REQUEST');
 for(const details of [check.rawDetails?.transportEvidence,check.evidence,trace.trace[0],trace.boundedGapProbeResults[0]]){
  assert.equal(details?.providerHttpStatus,422);assert.equal(details?.providerErrorCode,'INVALID_STATION_PAIR');
  assert.equal(details?.providerErrorMessage,'Booking not allowed for given pair of stations');
 }
 for(let i=0;i<200;i++)trace.boundedResult(request,check);
 assert.equal(trace.boundedGapProbeResults.length,64);assert.equal(trace.boundedGapProbeResultsDropped,137);
 assert.ok(!JSON.stringify({check,trace}).includes('PRIVATE'));
});
test('sanitizer rejects arbitrary bodies, keys, URLs, headers and credential values',t=>{
 const previous=process.env.RAILKIT_API_KEY;process.env.RAILKIT_API_KEY='available';
 t.after(()=>{if(previous===undefined)delete process.env.RAILKIT_API_KEY;else process.env.RAILKIT_API_KEY=previous;});
 const input={statusCode:400,error:'Invalid station pair available Bearer SECRET_ONE https://private.invalid/key\napi_key=SECRET_TWO\nUNKNOWN_PAYLOAD',code:'SECRET_CODE',headers:{authorization:'SECRET_HEADER'},body:'PRIVATE_BODY'};
 const output=JSON.stringify(providerTransportEvidence(input));
 for(const secret of ['available','SECRET','PRIVATE','UNKNOWN_PAYLOAD','private.invalid','api_key','authorization','headers'])assert.ok(!output.includes(secret),secret);
 assert.equal(providerTransportEvidence(input).failureCategory,'INVALID_REQUEST');
 assert.equal(safeProviderErrorDetails(input).providerErrorCode,undefined);
});
test('messages and all fields stay bounded across serialization and repeat sanitization',()=>{
 const detail=safeProviderErrorDetails({error:'Invalid station pair '.repeat(1000),statusCode:400});
 assert.ok(detail.providerErrorMessage!.length<=240);
 const bounded=safeProviderErrorDetails({error:'Invalid station pair '.repeat(100),code:'INVALID_STATION_PAIR',statusCode:400});
 assert.ok(bounded.providerErrorMessage!.length<=240);assert.ok(bounded.providerErrorMessage!.endsWith('...'));
 assert.deepEqual(safeProviderErrorDetails(JSON.parse(JSON.stringify(bounded))),bounded);
 assert.equal(safeProviderErrorMessage({secret:'PRIVATE'}),undefined);
});
test('thrown SDK error preserves allowlisted name/code and nested response reason',()=>{
 const error=Object.assign(new Error('Invalid station pair'),{code:'ERR_BAD_REQUEST',response:{status:400,data:{error:'Invalid station pair'}}});
 const detail=providerTransportEvidence(error);
 assert.equal(detail.failureCategory,'INVALID_REQUEST');assert.equal(detail.providerHttpStatus,400);
 assert.equal(detail.providerSdkErrorName,'Error');assert.equal(detail.providerSdkErrorCode,'ERR_BAD_REQUEST');
 assert.equal(detail.providerErrorMessage,'Invalid station pair');
});
