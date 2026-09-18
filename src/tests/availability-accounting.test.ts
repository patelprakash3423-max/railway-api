import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {RailwayDatabase} from '../local-railway/database.js';
import {RailKitProvider} from '../providers/railkit/railkit-provider.js';
import {AvailabilitySession} from '../journey/availability/session.js';
import {AvailabilityOrchestrator} from '../journey/availability/orchestrator.js';
import {LocalJourneyPlannerV2} from '../local-railway/planner/v2/planner.js';
import {ProtectedJourneyService, guardedProvider} from '../api/services/protected-journey-service.js';
import {SearchProtection} from '../api/search-protection.js';
import {hardeningConfig} from '../config/hardening.js';
import {createRouter} from '../api/router.js';
import {ProviderConfigurationError} from '../application/errors.js';
import type {AvailabilityRequest} from '../domain/types/availability.js';

const date = '20-09-2099';
const now = () => Date.UTC(2099, 8, 20);
const request: AvailabilityRequest = {trainNumber:'30001',fromStationCode:'AAA',toStationCode:'CCC',journeyDate:date,travelClass:'3A',quota:'GN'};
const input = {from:'AAA',to:'CCC',date,classes:['3A'],mode:'STANDARD'};
function mockSdk(t: TestContext, key: string | undefined = 'offline-test-placeholder', failure = false) {
  const previousKey = process.env.RAILKIT_API_KEY, previousFetch = globalThis.fetch;
  if (key === undefined) delete process.env.RAILKIT_API_KEY;
  else process.env.RAILKIT_API_KEY = key;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    return new Response(JSON.stringify(failure ? {success:false,error:'Offline provider failure'} :
      {success:true,data:{availability:[{date,status:'AVAILABLE'}]}}), {status:failure ? 500 : 200});
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.RAILKIT_API_KEY;
    else process.env.RAILKIT_API_KEY = previousKey;
  });
  return () => fetches;
}
function database(t: TestContext) {
  const db = new RailwayDatabase(':memory:');
  t.after(() => db.close());
  db.replace({stations:['AAA','CCC'].map(code=>({code,name:code})),
    trains:[{number:'30001',name:'Fixture',sourceCode:'AAA',destinationCode:'CCC',runningDaysRaw:'Daily',runningDays:['MON','TUE','WED','THU','FRI','SAT','SUN']}],
    stops:[{trainNumber:'30001',stationCode:'AAA',sequence:1,dayOffset:0,departureTime:'06:00',distanceKm:0},
      {trainNumber:'30001',stationCode:'CCC',sequence:2,dayOffset:0,arrivalTime:'12:00',distanceKm:600}],
    metadata:{source:'RAILPULL_NTES',importedAt:'2099-09-20T00:00:00Z',trainCount:1,stationCount:2,stopCount:2}});
  return db;
}
function harness(t: TestContext, provider = new RailKitProvider(), patch = {}) {
  const logs: Record<string,unknown>[] = [];
  const service = new ProtectedJourneyService(database(t),provider,{...hardeningConfig({}),...patch},{diagnostics:true,logger:r=>logs.push(r)},now);
  const router = createRouter({search:async()=>{throw Error('Legacy forbidden');}},{journeyV2:service,logger:r=>logs.push(r)});
  const search = (requestId='accounting-request') => router({method:'POST',path:'/api/journeys/v2/search',contentType:'application/json',body:JSON.stringify(input),clientId:'test-client',requestId});
  return {search,router,logs};
}

for (const key of [undefined, '', '   ', 'your_api_key_here', 'invalid key', 'invalid\nkey']) {
  test(`invalid local configuration (${key === undefined ? 'missing' : JSON.stringify(key)}) fails before checks or quota`, async t => {
    const fetches = mockSdk(t);
    if (key === undefined) delete process.env.RAILKIT_API_KEY;
    else process.env.RAILKIT_API_KEY = key;
    let configurationChecks = 0, adapterCalls = 0;
    class ObservedProvider extends RailKitProvider {
      override assertConfigured() { configurationChecks++; super.assertConfigured(); }
      override async getAvailability(r: AvailabilityRequest) { adapterCalls++; return super.getAvailability(r); }
    }
    const h = harness(t,new ObservedProvider(),{monthly:30,burst:30});
    // More failures than the normal search-rate allowance must not spend provider quota.
    for (let i=0;i<6;i++) {
      const reply = await h.search(`missing-${i}`);
      assert.equal(reply.status,503);
      const body = JSON.parse(reply.body);
      assert.equal(body.error.code,'PROVIDER_CONFIGURATION_ERROR');
      assert.equal(body.requestId,`missing-${i}`);
      assert.equal(body.results,undefined);
      assert.doesNotMatch(reply.body,/NOT_AVAILABLE|UNAVAILABLE|RAILKIT_API_KEY/);
      const log = h.logs.at(-1)!;
      assert.equal(log.event,'journey_v2_search_rejected');
      assert.equal(log.failureCategory,'LOCAL_CONFIGURATION_FAILURE');
      assert.equal(log.requestId,body.requestId);
      assert.equal(log.localConfigurationFailures,1);
      for(const metric of ['attemptedAvailabilityChecks','actualSdkInvocations','providerSuccesses','providerErrors','budgetUsed','availabilityCalls']) assert.equal(log[metric],0);
      const protection = log.protection as Record<string,number>;
      assert.equal(protection.monthlyUsed,0);
      assert.equal(protection.burstUsed,0);
      assert.equal(protection.reservedProviderCalls,0);
      assert.equal(protection.clientSearches,0);
    }
    assert.equal(configurationChecks,6);
    assert.equal(adapterCalls,0);
    assert.equal(fetches(),0);
    const health = await h.router({method:'GET',path:'/health',requestId:'health-id'});
    assert.equal(health.status,200);
    assert.deepEqual(JSON.parse(health.body),{requestId:'health-id',status:'ok'});
    assert.equal(configurationChecks,6);
    // Proves failures did not consume quota or search admission: the full 30 reservation still fits.
    process.env.RAILKIT_API_KEY='offline-test-placeholder';
    const success = await h.search();
    assert.equal(success.status,200);
    const d = JSON.parse(success.body).diagnostics;
    assert.equal(d.attemptedAvailabilityChecks,1);
    assert.equal(d.actualSdkInvocations,1);
    assert.equal(d.providerSuccesses,1);
    assert.equal(d.localConfigurationFailures,0);
    assert.equal(d.actualExternalRequests,undefined);
    assert.equal(d.availabilityCalls,d.attemptedAvailabilityChecks);
    assert.equal(fetches(),1);
    // One real SDK invocation leaves insufficient capacity for a second 30 reservation.
    assert.equal((await h.search('quota-rejection')).status,429);
    const rejected = h.logs.at(-1)!;
    assert.equal(rejected.failureCategory,'MONTHLY_PROVIDER_QUOTA');
    assert.equal(rejected.requestId,'quota-rejection');
    assert.equal((rejected.protection as Record<string,number>).monthlyUsed,1);
    assert.equal((rejected.protection as Record<string,number>).reservedProviderCalls,0);
    assert.doesNotMatch(JSON.stringify(h.logs),/offline-test-placeholder|invalid key/);
  });
}

test('a missing-key session latches one configuration failure before spending its budget', async t => {
  mockSdk(t);
  delete process.env.RAILKIT_API_KEY;
  let configurations=0;
  const provider=new RailKitProvider();
  const session=new AvailabilitySession({assertConfigured:()=>{configurations++;provider.assertConfigured();},getAvailability:r=>provider.getAvailability(r)},30);
  for(let i=0;i<3;i++)await assert.rejects(session.get(request),ProviderConfigurationError);
  assert.equal(configurations,1);
  const d=session.statistics();
  assert.equal(d.localConfigurationFailures,1);
  assert.equal(d.attemptedAvailabilityChecks,0);
  assert.equal(d.actualSdkInvocations,0);
  assert.equal(d.providerErrors,0);
  assert.equal(d.unavailableResponses,0);
  assert.equal(d.budgetRemaining,30);
});

test('cache and in-flight hits do not invoke the SDK or charge quota twice', async t => {
  const fetches=mockSdk(t);
  let charges=0;
  const session=new AvailabilitySession(guardedProvider(new RailKitProvider(),new AbortController().signal,1000,()=>{charges++;}),30);
  const [a,b]=await Promise.all([session.get(request),session.get(request)]);
  await session.get(request);
  assert.deepEqual(a,b);
  assert.equal(a.status,'AVAILABLE');
  const d=session.statistics();
  assert.equal(d.attemptedAvailabilityChecks,1);
  assert.equal(d.actualSdkInvocations,1);
  assert.equal(d.providerSuccesses,1);
  assert.equal(d.providerErrors,0);
  assert.equal(d.cacheHits,2);
  assert.equal(charges,1);
  assert.equal(fetches(),1);
});

test('SDK provider failure remains unverified, is cached, and counts one charged invocation', async t => {
  const fetches=mockSdk(t,'offline-test-placeholder',true);
  let charges=0;
  const session=new AvailabilitySession(guardedProvider(new RailKitProvider(),new AbortController().signal,1000,()=>{charges++;}),30);
  const check=await session.get(request);
  await session.get(request);
  assert.equal(check.status,'PROVIDER_ERROR');
  const d=session.statistics();
  assert.equal(d.actualSdkInvocations,1);
  assert.equal(d.providerErrors,1);
  assert.equal(d.providerSuccesses,0);
  assert.equal(d.unavailableResponses,0);
  assert.equal(charges,1);
  assert.equal(fetches(),1);
  const reply=await harness(t).search();
  assert.equal(reply.status,200);
  assert.equal(JSON.parse(reply.body).results[0].status,'INVENTORY_CHECK_INCOMPLETE');
});

test('30 distinct checks still exhaust STANDARD; a 31st starts no SDK invocation', async t => {
  const fetches=mockSdk(t);
  const session=new AvailabilitySession(new RailKitProvider(),30);
  for(let i=0;i<30;i++)await session.get({...request,trainNumber:String(30000+i)});
  await assert.rejects(session.get({...request,trainNumber:'40000'}),/allowance exhausted/);
  const d=session.statistics();
  assert.equal(d.attemptedAvailabilityChecks,30);
  assert.equal(d.actualSdkInvocations,30);
  assert.equal(d.providerSuccesses,30);
  assert.equal(d.budgetRemaining,0);
  assert.equal(fetches(),30);
});

test('adapter validation failure spends a check but no SDK invocation or provider quota', async t => {
  const fetches=mockSdk(t);
  let charges=0;
  const session=new AvailabilitySession(guardedProvider(new RailKitProvider(),new AbortController().signal,1000,()=>{charges++;}),30);
  assert.equal((await session.get({...request,trainNumber:'invalid'})).status,'PROVIDER_ERROR');
  assert.equal(session.statistics().attemptedAvailabilityChecks,1);
  assert.equal(session.statistics().actualSdkInvocations,0);
  assert.equal(charges,0);
  assert.equal(fetches(),0);
});

test('concurrent sessions keep SDK invocation counters isolated', async t => {
  mockSdk(t);
  const one=new AvailabilitySession(new RailKitProvider(),30),two=new AvailabilitySession(new RailKitProvider(),30);
  await Promise.all([one.get(request),two.get(request),two.get({...request,travelClass:'SL'})]);
  assert.equal(one.statistics().actualSdkInvocations,1);
  assert.equal(two.statistics().actualSdkInvocations,2);
});

test('existing metadata exclusions are counted without adding calls or changing eligibility', async t => {
  const db=database(t),planner=new LocalJourneyPlannerV2(db).search({from:'AAA',to:'CCC',date});
  let calls=0;
  const result=await new AvailabilityOrchestrator({getAvailability:async r=>{calls++;return {request:r,provider:'railkit',providerState:'SUCCESS',days:[{date,state:'AVAILABLE'}]};}})
    .validate({source:'AAA',destination:'CCC',journeyDate:date,requestedClasses:['ALL'],supportedClassesByTrain:{'30001':['CC']},plannerCandidates:planner.journeys});
  assert.equal(result.diagnostics.unsupportedClassSkips,7);
  assert.equal(result.diagnostics.attemptedAvailabilityChecks,1);
  assert.equal(result.diagnostics.actualSdkInvocations,0); // Injected provider never entered RailKit SDK.
  assert.equal(result.diagnostics.providerSuccesses,1);
  assert.equal(calls,1);
  assert.equal(result.journeys[0].legs[0].selectedClass,'CC');
});

for(const [patch,category] of [[{rateMax:1},'CLIENT_SEARCH_RATE'],[{burst:30},'BURST_PROVIDER_QUOTA']] as const) {
  test(`admission rejection logs ${category} with request ID and counters`,async t=>{
    mockSdk(t);
    const h=harness(t,new RailKitProvider(),patch);
    assert.equal((await h.search()).status,200);
    assert.equal((await h.search('rejected-id')).status,429);
    const log=h.logs.at(-1)!;
    assert.equal(log.failureCategory,category);
    assert.equal(log.requestId,'rejected-id');
    assert.equal((log.protection as Record<string,number>).burstUsed,1);
    assert.equal(log.actualSdkInvocations,0);
  });
}

test('concurrency admission keeps existing limits and exposes safe counter snapshots',()=>{
  const protection=new SearchProtection(hardeningConfig({}),now);
  const lease=protection.acquire('client',30);
  assert.throws(()=>protection.acquire('client',30),error=>{
    assert.equal((error as {failureCategory:string}).failureCategory,'CLIENT_CONCURRENCY');
    assert.equal(protection.snapshot('client').clientActive,1);
    assert.equal(protection.snapshot('client').reservedProviderCalls,30);
    return true;
  });
  lease.release();
});
