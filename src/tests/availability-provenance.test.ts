import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {AvailabilitySession} from '../journey/availability/session.js';
import {usable} from '../journey/availability/inventory.js';
import {RailKitProvider} from '../providers/railkit/railkit-provider.js';
import {AvailabilityScheduler} from '../providers/railkit/availability-scheduler.js';
import {normalizeAvailability} from '../providers/railkit/railkit-normalizers.js';
import {hardeningConfig} from '../config/hardening.js';
import {identityPresenceFields,safeAvailabilityText,withAvailabilityEvidenceLogger,type AvailabilityEvidence} from '../providers/availability-evidence.js';
import type {AvailabilityRequest} from '../domain/types/availability.js';
import type {LocalDataset} from '../local-railway/types.js';
import {RailwayDatabase} from '../local-railway/database.js';
import {JourneyV2ApiService} from '../api/services/journey-v2-service.js';
const request:AvailabilityRequest={trainNumber:'12565',fromStationCode:'SV',toStationCode:'NDLS',journeyDate:'18-11-2026',travelClass:'SL',quota:'GN'};
const payload=()=>({success:true,data:{train:{trainNo:'12565',from:'SV',to:'NDLS',travelClass:'SL',quota:'GN',journeyDate:request.journeyDate},availability:[{date:request.journeyDate,status:'AVAILABLE',availabilityText:'AVL 2',canBook:true}]}});
const tick=()=>new Promise<void>(r=>setImmediate(r));
function mocked(t:TestContext,body:()=>unknown|Promise<unknown>=payload){
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-01T00:00:00Z')});
 const oldKey=process.env.RAILKIT_API_KEY,oldFetch=globalThis.fetch;let sdkCalls=0;
 process.env.RAILKIT_API_KEY='offline-provenance-test';
 globalThis.fetch=async()=>{sdkCalls++;return new Response(JSON.stringify(await body()));};
 t.after(()=>{globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.RAILKIT_API_KEY;else process.env.RAILKIT_API_KEY=oldKey;});
 const scheduler=new AvailabilityScheduler({...hardeningConfig({}),burst:100,monthly:1000}),provider=new RailKitProvider(scheduler);
 return {provider,scheduler,session:()=>new AvailabilitySession(provider,30),sdkCalls:()=>sdkCalls};
}
function database(t:TestContext){
 const db=new RailwayDatabase(':memory:');t.after(()=>db.close());
 db.replace({stations:['SV','NDLS'].map(code=>({code,name:code})),trains:[{number:'12565',name:'BIHAR S KRANTI',sourceCode:'SV',destinationCode:'NDLS',runningDaysRaw:'Daily',runningDays:['MON','TUE','WED','THU','FRI','SAT','SUN']}],stops:[{trainNumber:'12565',stationCode:'SV',sequence:1,dayOffset:0,departureTime:'06:00',distanceKm:0},{trainNumber:'12565',stationCode:'NDLS',sequence:2,dayOffset:0,arrivalTime:'18:00',distanceKm:800}],metadata:{source:'RAILPULL_NTES',importedAt:'2026-10-01T00:00:00Z',trainCount:1,stationCount:2,stopCount:2,label:'SYNTHETIC_TEST_FIXTURE'}});
 return db;
}
const search={from:'SV',to:'NDLS',date:request.journeyDate,classes:['SL'],mode:'STANDARD'};
test('D1 screenshot shape traces exact accepted AVL 2 to the serialized V2 segment',async t=>{
 const h=mocked(t),logs:Record<string,unknown>[]=[],db=database(t);
 const result=await new JourneyV2ApiService(db,h.provider,{diagnostics:true,logger:r=>logs.push(r)}).search(search,'evidence-request');
 const segment=result.results[0].legs[0].segments[0];
 assert.equal(segment.type,'RESERVED');if(segment.type==='RESERVED'){assert.equal(segment.availabilityStatus,'AVAILABLE');assert.equal(segment.availabilityText,'AVL 2');}
 const events=logs.filter(l=>l.event==='journey_v2_availability_evidence');assert.equal(events.length,1);
 assert.equal(events[0].requestId,'evidence-request');assert.equal(events[0].level,'debug');
 assert.deepEqual(events[0].evidence,{trainNumber:'12565',from:'SV',to:'NDLS',requestedDate:'18-11-2026',travelClass:'SL',quota:'GN',resultStatus:'AVAILABLE',...Object.fromEntries(identityPresenceFields.map(k=>[k,true])),providerIdentityValidation:'VALIDATED',availabilityText:'AVL 2',canBook:true,matchingAvailabilityRows:1,exactRequestedDateFound:true,evidenceSource:'FRESH_PROVIDER',sdkInvokedForCheck:true});
 assert.doesNotMatch(JSON.stringify(result),/identityEvidence|evidenceSource|matchingAvailabilityRows|canBook|sdkInvokedForCheck/);
 assert.equal(h.sdkCalls(),1);
});
test('D1 exact requested date WL 200 never becomes AVAILABLE',async t=>{
 const h=mocked(t,()=>{const p=payload();p.data.availability[0].status='WAITLIST';p.data.availability[0].availabilityText='WL 200';return p;});
 const check=await h.session().get(request);assert.equal(check.status,'WAITLIST');assert.equal(usable(check),false);assert.equal(check.evidence?.availabilityText,'WL 200');assert.equal(check.evidence?.matchingAvailabilityRows,1);
});
for(const dates of [['19-11-2026'],[],['18-11-2026','18-11-2026']])test(`D1 exact-date row count rejects ${JSON.stringify(dates)}`,async t=>{
 const h=mocked(t,()=>{const p=payload();p.data.availability=dates.map(date=>({...p.data.availability[0],date}));return p;});
 const c=await h.session().get(request);assert.equal(c.errorCategory,'INVALID_PROVIDER_RESPONSE');assert.equal(usable(c),false);
 const count=dates.filter(d=>d===request.journeyDate).length;assert.equal(c.evidence?.matchingAvailabilityRows,count);assert.equal(c.evidence?.exactRequestedDateFound,count>0);assert.equal(c.evidence?.availabilityText,undefined);
});
for(const [field,value,present] of [['trainNo','12566','providerTrainIdentityPresent'],['from','GKP','providerFromIdentityPresent'],['to','DLI','providerToIdentityPresent'],['travelClass','3A','providerClassIdentityPresent'],['quota','TQ','providerQuotaIdentityPresent'],['journeyDate','19-11-2026','providerJourneyDateIdentityPresent']] as const)test(`D1 explicit conflicting ${field} is rejected and remains observable across scheduler`,async t=>{
 const h=mocked(t,()=>{const p=payload();p.data.train[field]=value;return p;});
 const c=await h.session().get(request);assert.equal(c.status,'PROVIDER_ERROR');assert.equal(c.errorCategory,'INVALID_PROVIDER_RESPONSE');assert.equal(usable(c),false);
 assert.equal(c.evidence?.[present],true);assert.equal(c.evidence?.providerIdentityValidation,'REJECTED');assert.equal(c.evidence?.evidenceSource,'FRESH_PROVIDER');assert.equal(c.evidence?.matchingAvailabilityRows,null);
});
test('D1 conflicting data-level journeyDate is rejected',async t=>{
 const h=mocked(t,()=>{const p=payload();return {...p,data:{...p.data,journeyDate:'19-11-2026'}};});
 const c=await h.session().get(request);assert.equal(c.errorCategory,'INVALID_PROVIDER_RESPONSE');assert.equal(c.evidence?.providerJourneyDateIdentityPresent,true);assert.equal(c.evidence?.providerIdentityValidation,'REJECTED');
});
for(const state of ['AVAILABLE','RAC'])test(`D1 ${state} canBook false remains unusable with exact evidence`,async t=>{
 const h=mocked(t,()=>{const p=payload();p.data.availability[0].status=state;p.data.availability[0].canBook=false;return p;});
 const c=await h.session().get(request);assert.equal(c.errorCategory,'BOOKING_UNSUPPORTED');assert.equal(usable(c),false);assert.equal(c.evidence?.canBook,false);assert.equal(c.evidence?.matchingAvailabilityRows,1);
 const result=await new JourneyV2ApiService(database(t),h.provider).search(search);assert.ok(result.results.every(j=>j.legs.every(l=>l.segments.every(s=>s.type!=='RESERVED'))));
});
test('D1 absent canBook and optional identities are not reported as verified',async t=>{
 const h=mocked(t,()=>({success:true,data:{availability:[{date:request.journeyDate,status:'AVAILABLE',availabilityText:'AVL 2'}]}}));
 const c=await h.session().get(request);assert.equal(c.status,'AVAILABLE');assert.equal(c.evidence?.canBook,'ABSENT');assert.equal(c.evidence?.providerIdentityValidation,'NOT_PROVIDED');for(const key of identityPresenceFields)assert.equal(c.evidence?.[key],false);
});
test('D1 partial identity presence does not verify absent fields',async t=>{
 const h=mocked(t,()=>({success:true,data:{train:{trainNo:'12565'},availability:payload().data.availability}}));
 const c=await h.session().get(request);assert.equal(c.evidence?.providerIdentityValidation,'VALIDATED');assert.equal(c.evidence?.providerTrainIdentityPresent,true);assert.equal(c.evidence?.providerFromIdentityPresent,false);
});
test('D1 shared and local cache sources preserve evidence and accounting',async t=>{
 const h=mocked(t),a=h.session(),events:AvailabilityEvidence[]=[];
 const first=await withAvailabilityEvidenceLogger(e=>events.push(e),()=>a.get(request));
 const local=await withAvailabilityEvidenceLogger(e=>events.push(e),()=>a.get(request));
 const b=h.session(),shared=await withAvailabilityEvidenceLogger(e=>events.push(e),()=>b.get(request));
 assert.deepEqual(events.map(e=>e.evidenceSource),['FRESH_PROVIDER','SEARCH_LOCAL_CACHE','SHARED_CACHE']);assert.equal(first.evidence?.evidenceSource,'FRESH_PROVIDER');
 for(const c of [local,shared]){assert.equal(c.evidence?.sdkInvokedForCheck,false);assert.equal(c.evidence?.availabilityText,'AVL 2');assert.equal(c.evidence?.providerTrainIdentityPresent,true);}
 assert.equal(a.statistics().attemptedAvailabilityChecks,1);assert.equal(a.statistics().availabilityCacheHits,1);assert.equal(b.statistics().attemptedAvailabilityChecks,1);assert.equal(b.statistics().actualSdkInvocations,0);assert.equal(h.sdkCalls(),1);
});
test('D1 shared inflight follower is distinguished from the invoking leader',async t=>{
 let resolve!:(v:unknown)=>void;const response=new Promise(r=>{resolve=r;}),h=mocked(t,()=>response),a=h.session(),b=h.session();
 const first=a.get(request);await tick();const second=b.get(request);await tick();resolve(payload());
 const [leader,follower]=await Promise.all([first,second]);assert.equal(leader.evidence?.evidenceSource,'FRESH_PROVIDER');assert.equal(follower.evidence?.evidenceSource,'SHARED_INFLIGHT');assert.equal(follower.evidence?.sdkInvokedForCheck,false);assert.equal(follower.evidence?.providerIdentityValidation,'VALIDATED');assert.equal(h.sdkCalls(),1);
});
test('D1 search-local in-flight reuse does not masquerade as fresh evidence',async t=>{
 let resolve!:(v:unknown)=>void;const response=new Promise(r=>{resolve=r;}),h=mocked(t,()=>response),session=h.session();
 const first=session.get(request),second=session.get(request);await tick();resolve(payload());
 const [a,b]=await Promise.all([first,second]);assert.equal(a.evidence?.evidenceSource,'FRESH_PROVIDER');assert.equal(b.evidence?.evidenceSource,'SEARCH_LOCAL_CACHE');assert.equal(h.sdkCalls(),1);
});
test('D1 exact unsupported cache source does not leak to other request contexts',async t=>{
 const h=mocked(t,()=>({success:false,error:'Class does not exist in this train for this train route'}));
 const first=await h.session().get(request),cachedSession=h.session(),cached=await cachedSession.get(request);
 assert.equal(first.evidence?.evidenceSource,'FRESH_PROVIDER');assert.equal(cached.evidence?.evidenceSource,'UNSUPPORTED_EVIDENCE_CACHE');assert.equal(cached.evidence?.failureCategory,'UNSUPPORTED_CLASS');
 assert.equal(cachedSession.statistics().actualSdkInvocations,0);assert.equal(cachedSession.statistics().attemptedAvailabilityChecks,1);assert.equal(h.scheduler.quota.snapshot().monthlyUsed,1);
 for(const patch of [{fromStationCode:'GKP'},{toStationCode:'DLI'},{trainNumber:'12566'},{journeyDate:'19-11-2026'},{travelClass:'3A'}])assert.equal((await h.session().get({...request,...patch})).evidence?.evidenceSource,'FRESH_PROVIDER');
 assert.equal(h.sdkCalls(),6);
});
for(const text of ['Bearer SECRET_TOKEN','AVL 2 Authorization: secret','AVL 2\nsecret','AVL\u20282','AVL\u00002','{"api_key":"secret"}','https://secret.example','1.2.3.4','AVAILABLE '+ '9'.repeat(80)])test(`D1 arbitrary provider text is omitted: ${JSON.stringify(text)}`,async t=>{
 const h=mocked(t,()=>{const p=payload();p.data.availability[0].availabilityText=text;return {...p,authorization:'secret-header',headers:{authorization:'secret-header'},arbitraryBody:'secret-body'};});
 const events:AvailabilityEvidence[]=[];const c=await withAvailabilityEvidenceLogger(e=>events.push(e),()=>h.session().get(request));
 assert.equal(c.status,'AVAILABLE');assert.equal(c.evidence?.availabilityText,undefined);assert.doesNotMatch(JSON.stringify(events),/SECRET_TOKEN|secret|Bearer|api_key|https:|1\.2\.3\.4/);
});
test('D1 recognized inventory text remains exact and unknown SDK source is truthful',async()=>{
 for(const text of ['AVL 2','AVBL 2','AVAILABLE-002','RAC 10','GNWL 200/WL 190','WL 200'])assert.equal(safeAvailabilityText(text),text);
 const c=await new AvailabilitySession({getAvailability:async r=>normalizeAvailability(payload(),r)},30).get(request);assert.equal(c.evidence?.evidenceSource,'NOT_OBSERVED');assert.equal(c.evidence?.sdkInvokedForCheck,false);
});
test('D1 evidence logging is opt-in and cannot change a search or leak into the response',async t=>{
 const h=mocked(t),db=database(t),off:Record<string,unknown>[]=[];
 const a=await new JourneyV2ApiService(db,h.provider,{logger:r=>off.push(r)}).search(search,'same-request');assert.ok(off.every(l=>l.event!=='journey_v2_availability_evidence'));
 const b=await new JourneyV2ApiService(db,h.provider,{diagnostics:true,logger:()=>{throw Error('logger failure');}}).search(search,'same-request');
 assert.deepEqual(b.results,a.results);assert.equal(h.sdkCalls(),1);
});

test('D1 arbitrary failure bodies and identity conflicts never become log strings',async t=>{
 let failure=true;const h=mocked(t,()=>failure?{success:false,error:'Bearer SECRET_SENTINEL',headers:{authorization:'SECRET_SENTINEL'},body:'SECRET_SENTINEL'}:{...payload(),data:{...payload().data,train:{...payload().data.train,trainNo:'SECRET_SENTINEL'}}});
 const events:AvailabilityEvidence[]=[];
 await withAvailabilityEvidenceLogger(e=>events.push(e),()=>h.session().get(request));failure=false;
 await withAvailabilityEvidenceLogger(e=>events.push(e),()=>h.session().get(request));
 assert.equal(events.length,2);assert.equal(events[0].failureCategory,'UNKNOWN_PROVIDER_ERROR');assert.equal(events[1].providerIdentityValidation,'REJECTED');assert.doesNotMatch(JSON.stringify(events),/SECRET_SENTINEL|Bearer|authorization|headers|body|stack/);
});
test('D1 shared followers keep independent search log contexts',async t=>{
 let resolve!:(v:unknown)=>void;const response=new Promise(r=>{resolve=r;}),h=mocked(t,()=>response),a:AvailabilityEvidence[]=[],b:AvailabilityEvidence[]=[];
 const first=withAvailabilityEvidenceLogger(e=>a.push(e),()=>h.session().get(request));await tick();
 const second=withAvailabilityEvidenceLogger(e=>b.push(e),()=>h.session().get(request));await tick();resolve(payload());await Promise.all([first,second]);
 assert.equal(a.length,1);assert.equal(b.length,1);assert.equal(a[0].evidenceSource,'FRESH_PROVIDER');assert.equal(b[0].evidenceSource,'SHARED_INFLIGHT');assert.equal(a[0].requestedDate,b[0].requestedDate);
});
test('D1 checked AVL segment may belong to an incomplete multi-train journey',async t=>{
 const db=database(t);
 // Reuse the fixture dataset shape to avoid altering planner semantics.
 const first:LocalDataset['trains'][number]={number:'12565',name:'BIHAR S KRANTI',sourceCode:'SV',destinationCode:'NDLS',runningDaysRaw:'Daily',runningDays:['MON','TUE','WED','THU','FRI','SAT','SUN']};
 db.replace({stations:['SV','NDLS','BBB'].map(code=>({code,name:code})),trains:[first,{...first,number:'30002',sourceCode:'NDLS',destinationCode:'BBB'}],stops:[{trainNumber:'12565',stationCode:'SV',sequence:1,dayOffset:0,departureTime:'06:00',distanceKm:0},{trainNumber:'12565',stationCode:'NDLS',sequence:2,dayOffset:0,arrivalTime:'18:00',distanceKm:800},{trainNumber:'30002',stationCode:'NDLS',sequence:1,dayOffset:0,departureTime:'19:30',distanceKm:0},{trainNumber:'30002',stationCode:'BBB',sequence:2,dayOffset:0,arrivalTime:'23:00',distanceKm:200}],metadata:{source:'RAILPULL_NTES',importedAt:'2026-10-01T00:00:00Z',trainCount:2,stationCount:3,stopCount:4}});
 const logs:Record<string,unknown>[]=[];
 const service=new JourneyV2ApiService(db,{getAvailability:async r=>normalizeAvailability(r.trainNumber==='12565'?payload():{success:false,error:'unknown provider failure'},r)},{diagnostics:true,logger:r=>logs.push(r)});
 const result=await service.search({...search,to:'BBB'});
 const journey=result.results.find(j=>j.legs.length===2);assert.ok(journey);assert.equal(journey.status,'INVENTORY_CHECK_INCOMPLETE');
 const segment=journey.legs[0].segments[0];assert.equal(segment.type,'RESERVED');if(segment.type==='RESERVED')assert.equal(segment.availabilityText,'AVL 2');
 const event=logs.find(l=>l.event==='journey_v2_availability_evidence'&&(l.evidence as AvailabilityEvidence).trainNumber==='12565');assert.ok(event);assert.equal(event.to,'BBB');assert.equal((event.evidence as AvailabilityEvidence).to,'NDLS');assert.equal((event.evidence as AvailabilityEvidence).resultStatus,'AVAILABLE');
});
