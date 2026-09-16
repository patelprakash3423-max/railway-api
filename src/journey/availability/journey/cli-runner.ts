import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {RailwayDatabase} from '../../../local-railway/database.js';
import {LocalJourneyPlannerV2} from '../../../local-railway/planner/v2/planner.js';
import type {SearchMode} from '../../../application/search-mode.js';
import {JourneyRecoveryOrchestrator} from './orchestrator.js';
import {FakeJourneyProvider} from '../../../test-support/journey-fake-provider.js';
import type {AvailabilityProvider} from '../types.js';

async function createLiveProvider(): Promise<AvailabilityProvider> {
  const {RailKitProvider}=await import('../../../providers/railkit/railkit-provider.js');
  if(!process.env.RAILKIT_API_KEY?.trim()||process.env.RAILKIT_API_KEY.trim()==='your_api_key_here')throw Error('Live mode requires RAILKIT_API_KEY configuration');
  const railkit=new RailKitProvider();
  return {getAvailability:request=>railkit.getAvailability(request)};
}
/** Dependency injection is for offline tests; the executable uses the existing RailKit provider. */
export async function runJourneyCli(args:string[], dependencies:{createLiveProvider?:()=>Promise<AvailabilityProvider>;log?:(text:string)=>void;summary?:(text:string)=>void}={}) {
 const log=dependencies.log??console.log;
 let db:RailwayDatabase|undefined;
 try{
  const {values,positionals}=parseArgs({args,allowPositionals:true,strict:true,options:{fake:{type:'boolean'},live:{type:'boolean'},'confirm-live':{type:'boolean'},classes:{type:'string',default:'ALL'},mode:{type:'string',default:'STANDARD'},db:{type:'string',default:'data/local-railway/railway.sqlite'},json:{type:'boolean'}}});
  if(Boolean(values.fake)===Boolean(values.live)||positionals.length!==3)throw Error('Require exactly one of --fake or --live. Usage: railway:journey:v2 -- FROM TO DD-MM-YYYY --fake|--live [--confirm-live] [--classes ALL] [--mode STANDARD] [--json]');
  if(values.live&&!values['confirm-live'])throw Error('Live execution requires --confirm-live; no provider calls were made.');
  const mode=values.mode.toUpperCase() as SearchMode;
  if(!['QUICK','STANDARD','DEEP'].includes(mode))throw Error('Invalid mode');
  db=new RailwayDatabase(resolve(values.db),true);
  const [source,destination,journeyDate]=positionals;
  const planner=new LocalJourneyPlannerV2(db).search({from:source,to:destination,date:journeyDate});
  const fake=values.fake?new FakeJourneyProvider(db,planner.journeys):undefined;
  const provider:AvailabilityProvider=fake??await (dependencies.createLiveProvider??createLiveProvider)();
  // Explicit STANDARD ceiling on the existing session; whole-leg and recovery share it.
  const options=values.live&&mode==='STANDARD'?{budgetLimit:30}:{};
  const result=await new JourneyRecoveryOrchestrator(db,{getAvailability:r=>provider.getAvailability(r)},options).validate({source,destination,journeyDate,requestedClasses:values.classes.split(','),mode,plannerCandidates:planner.journeys,plannerDiagnostics:planner.diagnostics,supportedClassesByTrain:fake?.supportedClassesByTrain});
  log(JSON.stringify({inventoryMode:values.live?'LIVE':'FAKE_OFFLINE',...(fake?{syntheticSupportedClasses:['SL','3A']}:{}),...result},null,values.json?2:undefined));
  if(values.live){
    const d=result.diagnostics;
    const summary=[`Planner candidates: ${d.plannerCandidatesReceived}`,`Whole-leg requests: ${d.wholeLegRequests}`,`Recovery requests: ${d.recoveryIntervalRequests}`,`Availability calls: ${d.availabilityRequestsUsed}`,`Cache hits: ${d.availabilityCacheHits}`,`Budget used: ${d.availabilityRequestsUsed}/${d.availabilityBudgetLimit}`,'',`Fully reserved: ${d.fullReservedJourneys}`,`Full split: ${d.fullSplitClassJourneys}`,`Partial recovery: ${d.partialRecoveryJourneys}`,`Scheduled fallback: ${d.scheduledFallbackJourneys}`,`Inventory incomplete: ${d.inventoryIncompleteJourneys}`,'',`Global budget: ${d.availabilityBudgetLimit}`,`Whole-leg calls: ${d.wholeLegRequests}`,`Recovery calls: ${d.recoveryIntervalRequests}`,`Released reserve calls: ${d.releasedReserveCalls}`,`Budget remaining: ${d.budgetRemaining}`,'',`Recovery reserve initial: ${d.recoveryReserveInitial}`,`Recovery reserve used: ${d.recoveryReserveUsed}`,`Recovery reserve released: ${d.recoveryReserveReleased}`,'',`Candidates checked whole-leg: ${d.candidatesCheckedWholeLeg}`,`Candidates sent to recovery: ${d.candidatesSentToRecovery}`,`Recovery attempts: ${d.legsRecoveryAttempted}`,`Recovery successes: ${d.legsRecoverySucceeded}`,'',`AVAILABLE: ${d.availableResponses}`,`RAC: ${d.racResponses}`,`WAITLIST: ${d.waitlistResponses}`,`UNSUPPORTED_CLASS: ${d.unsupportedClassResponses}`,`PROVIDER_ERROR: ${d.providerErrors}`,'','Discovery calls: 0','Train-info calls: 0'].join('\n');
    // Keep --json stdout machine-readable, as in fake mode.
    (dependencies.summary??(values.json?console.error:log))(summary);
  }
  return result;
 }finally{db?.close();}
}
