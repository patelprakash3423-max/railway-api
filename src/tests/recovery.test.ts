import test from 'node:test';
import assert from 'node:assert/strict';
import { searchRecovery } from '../application/journey-recovery-engine.js';
import { JourneySearchService } from '../application/journey-search-service.js';
import { ConnectionProviderSession } from '../journey/connection/provider-session.js';
import { ConnectionBudget } from '../journey/connection/budget.js';
import { connectionDiagnostics } from '../journey/connection/types.js';
import { coverage } from '../domain/recovery/coverage.js';
import { recoveryModes, recoveryDiagnostics } from '../domain/recovery/types.js';
import { rankRecovery, dominates, reserved, scoreRecovery } from '../domain/recovery/ranking.js';
import type { RailwayProvider } from '../providers/railway-provider.js';
import type { TrainStop } from '../domain/types/station.js';
import type { AvailabilityDay } from '../domain/types/availability.js';
const request = { fromStationCode: 'A', toStationCode: 'D', journeyDate: '20-09-2099', classes: ['3A'] as ['3A'], quota: 'GN' as const };
const train = { trainNumber: '12345', trainName: 'Fixture', fromStationCode: 'A', toStationCode: 'D', departureTime: '20:00', arrivalTime: '10:00', durationMinutes: 840 };
function fixture(states: Record<string, string> = {}, distances = [0,100,850,1000], max = 30) {
  const route: TrainStop[] = distances.map((distanceKm, i) => ({ stationCode: ['A','B','C','D'][i] ?? `S${i}`, stationName: `Station ${i}`, distanceKm,
    departureTime: '20:00', arrivalTime: '19:55', haltMinutes: 5, dayNumber: i ? 2 : 1 }));
  const calls: string[] = [];
  const provider: RailwayProvider = {
    async searchTrainsBetweenStations(r) { return { provider: 'fake', providerState: 'SUCCESS', trains: r.fromStationCode === 'A' && r.toStationCode === 'D' ? [train] : [] }; },
    async getTrainInfo() { return { trainNumber: '12345', trainName: 'Fixture', sourceStationCode: 'A', sourceStationName: 'A', destinationStationCode: 'D', destinationStationName: 'D', sourceDepartureTime: '20:00', destinationArrivalTime: '10:00', route }; },
    async getAvailability(r) {
      const key = `${r.fromStationCode}:${r.toStationCode}`; calls.push(key);
      if (states[key] === 'THROW') throw new Error('private provider failure');
      return { provider: 'railkit', providerState: states[key] === 'FAIL' ? 'PROVIDER_UNAVAILABLE' : 'SUCCESS', request: r,
        days: [{ date: r.journeyDate, state: (states[key] ?? 'WAITLIST') as AvailabilityDay['state'] }], fare: { totalFare: 1500, currency: 'INR' } };
    },
  };
  const session = new ConnectionProviderSession(provider, new ConnectionBudget({ maxAvailabilityCalls: max }), connectionDiagnostics(), 3);
  return { route, calls, provider, session, run: (config = recoveryModes.STANDARD, full = new Set<string>()) => searchRecovery(request, [train], session, config, full) };
}
for (const [name, states, ratio, type] of [
  ['boarding', { 'B:D': 'AVAILABLE' }, .9, 'ALTERNATE_BOARDING'],
  ['drop', { 'A:C': 'AVAILABLE' }, .85, 'ALTERNATE_DROP'],
  ['both', { 'B:C': 'AVAILABLE' }, .75, 'ALTERNATE_BOARDING_AND_DROP'],
] as const) test(`${name} recovery coverage and contiguous segments`, async () => {
  const f = fixture(states); const { candidates } = await f.run(); const c = candidates[0];
  assert.equal(c.recoveryType, type); assert.equal(c.reservedCoverage.ratio, ratio); assert.equal(c.reservedCoverage.method, 'DISTANCE');
  assert.equal(c.segments[0].from.code, 'A'); assert.equal(c.segments.at(-1)?.to.code, 'D');
  for (let i = 0; i < c.segments.length; i++) {
    assert.notEqual(c.segments[i].from.code, c.segments[i].to.code);
    if (i) assert.equal(c.segments[i-1].to.code, c.segments[i].from.code);
  }
  assert.equal(c.totalReservedFare, 1500); assert.equal(c.trainChangeCount, 0);
});
test('coverage-first pruning prevents sub-50% availability checks', async () => {
  const f = fixture({ 'B:D':'AVAILABLE' }, [0,600,900,1000]); const r = await f.run();
  assert.ok(!f.calls.includes('B:D')); assert.ok(r.diagnostics.recoveryCandidatesCoveragePruned > 0); assert.equal(r.candidates.length, 0);
});
test('RAC usable but not excellent or guaranteed berth', async () => {
  const r = await fixture({ 'B:D':'RAC' }, [0,80,850,1000]).run();
  assert.equal(r.candidates[0].reservedCoverage.percentage, 92); assert.ok(r.candidates[0].warnings.includes('RAC_NOT_CONFIRMED_BERTH'));
  assert.equal(r.candidates[0].quality, 'STRONG');
});
test('dominance removes worse coverage availability and fare', async () => {
  const a = (await fixture({ 'B:D':'AVAILABLE' }).run()).candidates[0];
  const b = structuredClone(a); b.reservedCoverage.ratio = .7; reserved(b).availability = 'RAC'; b.totalReservedFare = 1800; reserved(b).from.code = 'C';
  assert.equal(dominates(a,b), true); const d = recoveryDiagnostics(); assert.equal(rankRecovery([a,b],d).length,1); assert.equal(d.recoveryDominatedCandidatesRemoved,1);
});
test('coverage versus availability/fare tradeoff preserved', async () => {
  const a = (await fixture({ 'B:D':'AVAILABLE' }).run()).candidates[0]; const b = structuredClone(a);
  a.reservedCoverage.ratio = .95; reserved(a).availability = 'RAC'; a.totalReservedFare = 1900;
  b.reservedCoverage.ratio = .85; b.totalReservedFare = 1300; assert.equal(dominates(a,b),false); assert.equal(dominates(b,a),false);
});
for (const mode of ['QUICK','STANDARD','DEEP'] as const) test(`${mode} recovery and global budget upper bounds`, async () => {
  const f = fixture({}, [0,100,850,1000], 3); const r = await f.run(recoveryModes[mode]);
  assert.ok(f.calls.length <= Math.min(3,recoveryModes[mode].availabilityCalls)); assert.equal(r.diagnostics.recoveryAvailabilityChecks,f.calls.length);
});
test('request-local cache is free even with recovery allowance zero', async () => {
  const f = fixture({ 'B:D':'AVAILABLE' }); await f.session.availability({ ...request, trainNumber: '12345', fromStationCode: 'B', travelClass: '3A', journeyDate: '21-09-2099' });
  const before = f.calls.length; const r = await f.run({ ...recoveryModes.STANDARD, availabilityCalls: 0 });
  assert.equal(f.calls.length,before); assert.equal(r.candidates.length,1); assert.equal(r.diagnostics.recoveryCacheHits,1);
});
test('one provider error does not abort another interval', async () => {
  const r = await fixture({ 'B:D':'THROW', 'A:C':'AVAILABLE' }).run(); assert.equal(r.candidates[0].recoveryType,'ALTERNATE_DROP');
});
test('provider circuit breaker stops new live calls', async () => {
  const f = fixture({ 'B:D':'FAIL','A:C':'FAIL','B:C':'FAIL' }); await f.run(); const before=f.calls.length; await f.run(); assert.equal(f.calls.length,before);
});
test('full reserved direct suppresses same-train recovery', async () => {
  const f=fixture({ 'B:D':'AVAILABLE' }); const r=await f.run(recoveryModes.STANDARD,new Set(['12345'])); assert.equal(r.candidates.length,0); assert.equal(f.calls.length,0);
});
test('unreliable distances use route span consistently', () => {
  const f=fixture({},[0,0,0,0]); const c=coverage(f.route,0,3,1,3); assert.equal(c.method,'ROUTE_SPAN'); assert.equal(c.ratio,2/3);
});
test('coverage invariants across all ordered intervals', () => {
  for (const ds of [[0,100,850,1000],[0,0,0,0],[0,500,400,1000]]) {
    const f=fixture({},ds); for(let a=0;a<3;a++) for(let b=a+1;b<=3;b++) { const c=coverage(f.route,0,3,a,b); assert.ok(c.ratio>=0&&c.ratio<=1); }
  }
});
test('strong recovery stops before drop and doubles, boarding date rolls over', async () => {
  const f=fixture({ 'B:D':'AVAILABLE' }); const r=await f.run(); assert.deepEqual(f.calls,['B:D']); assert.equal(reserved(r.candidates[0]).journeyDate,'21-09-2099'); assert.equal(r.diagnostics.recoveryStrongStopCount,1);
});
test('deduplication and score availability ordering', async () => {
  const a=(await fixture({ 'B:D':'AVAILABLE' }).run()).candidates[0]; const b=structuredClone(a); reserved(b).availability='RAC';
  assert.ok(scoreRecovery(a,['3A'])>scoreRecovery(b,['3A'])); const d=recoveryDiagnostics(); rankRecovery([a,a],d); assert.equal(d.recoveryDuplicatesRemoved,1);
});
test('public service returns recovery without internal score or kind', async () => {
  const f=fixture({ 'B:D':'AVAILABLE' }); const r=await new JourneySearchService(f.provider,{logger:()=>{}}).search({from:'A',to:'D',date:request.journeyDate,classes:['3A']});
  const c=r.results.find((c)=>c.type==='JOURNEY_RECOVERY'); assert.ok(c); assert.ok(!('score' in c)); assert.ok(!('kind' in c)); assert.equal(r.meta.resultCount,r.results.length);
});
test('35-stop route stays bounded and class rounds do not multiply live budget', async () => {
  const f=fixture(); f.route.splice(0,f.route.length,...Array.from({length:35},(_,i)=>({ stationCode:i===0?'A':i===34?'D':`X${i}`,stationName:`Stop ${i}`,distanceKm:i*100,dayNumber:1,arrivalTime:'10:00',departureTime:'10:05',haltMinutes:5 })));
  const r=await searchRecovery({...request,classes:['3A','SL','2A']},[train],f.session,recoveryModes.STANDARD,new Set());
  assert.equal(f.calls.length,12); assert.equal(r.diagnostics.recoveryAvailabilityChecks,12); assert.ok(r.diagnostics.recoveryCandidatesGenerated<=14);
});
test('double-edge calls occur only after single edges; all usable returned intervals meet threshold',async()=>{
 const f=fixture({'B:C':'AVAILABLE'}); const r=await f.run(); assert.ok(f.calls.indexOf('B:C')>f.calls.indexOf('B:D')); assert.ok(f.calls.indexOf('B:C')>f.calls.indexOf('A:C'));
 for(const c of r.candidates) { assert.ok(c.reservedCoverage.ratio>=.5); assert.ok(['AVAILABLE','RAC'].includes(reserved(c).availability)); }
});
test('unknown fare prevents unsupported dominance inference',async()=>{
 const a=(await fixture({'B:D':'AVAILABLE'}).run()).candidates[0]; const b=structuredClone(a); b.totalReservedFare=undefined;
 assert.equal(dominates(a,b),false); assert.equal(dominates(b,a),false);
});
test('invalid route indices reject instead of fabricating coverage',()=>{
 const f=fixture(); assert.throws(()=>coverage(f.route,0,3,2,1)); assert.throws(()=>coverage(f.route,0,9,0,2));
});
test('public recovery serialization allowlists nested fields',async()=>{
 const {serializeRecovery}=await import('../application/serializers.js');
 const a=(await fixture({'B:D':'AVAILABLE'}).run()).candidates[0];
 Object.assign(a,{rawProvider:'secret'}); Object.assign(a.segments[0],{rawProvider:'secret'}); Object.assign(a.requestedFrom,{rawProvider:'secret'});
 const serialized=JSON.stringify(serializeRecovery(a)); assert.ok(!serialized.includes('secret')); assert.ok(!serialized.includes('score'));
});
