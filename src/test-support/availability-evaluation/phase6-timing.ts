// Offline sensitivity probe. Fake latency advances a clock; it is not a real sleep.
import {RailwayDatabase} from '../../local-railway/database.js';
import {LocalJourneyPlannerV2} from '../../local-railway/planner/v2/planner.js';
import {JourneyRecoveryOrchestrator} from '../../journey/availability/journey/orchestrator.js';
import type {AvailabilityProvider} from '../../journey/availability/types.js';
import {withSearchTiming} from '../../utils/search-timing.js';
const [source,destination,journeyDate]=process.argv.slice(2);
if(!source||!destination||!journeyDate)throw Error('Usage: phase6-timing.ts FROM TO DD-MM-YYYY');
const db=new RailwayDatabase('data/local-railway/railway.sqlite',true);
try{
 const plan=new LocalJourneyPlannerV2(db,{},true).search({from:source,to:destination,date:journeyDate});
 console.log(JSON.stringify({direct:plan.journeys.filter(j=>j.changes===0).map(j=>j.segments[0].trainNumber),candidates:plan.journeys.length}));
 for(const latency of [1,150,500,1000,2000,5000,15000]){
  let used=0,calls=0;const start=performance.now();
  const provider:AvailabilityProvider={currentTimeMs:()=>Date.UTC(2026,8,28)+used,remainingTimeMs:()=>Math.max(0,55366-used),assertActive:()=>{if(used>=55366)throw Error('fake deadline');},getAvailability:async request=>{
   calls++;used+=latency;return {request,provider:'railkit',providerState:'SUCCESS',days:[{date:request.journeyDate,state:'WAITLIST'}]};
  }};
  try{
   const r=await withSearchTiming('fake-'+latency,x=>console.log(JSON.stringify(x)),()=>new JourneyRecoveryOrchestrator(db,provider,{providerCallBudgetLimit:300}).validate({source,destination,journeyDate,requestedClasses:['ALL'],mode:'STANDARD',plannerCandidates:plan.journeys,plannerDiagnostics:plan.diagnostics}));
   console.log(JSON.stringify({latency,calls,used,wallMs:performance.now()-start,stop:r.diagnostics.stopReason}));
  }catch(error){console.log(JSON.stringify({latency,calls,used,wallMs:performance.now()-start,error:(error as Error).message}));}
 }
}finally{db.close();}
