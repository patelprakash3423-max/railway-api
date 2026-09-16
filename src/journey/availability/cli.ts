import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { RailwayDatabase } from '../../local-railway/database.js';
import { PlannerV2AvailabilityService } from './service.js';
import type { AvailabilityProvider } from './types.js';
import type { SearchMode } from '../../application/search-mode.js';
let database: RailwayDatabase|undefined;
try {
  const {values,positionals}=parseArgs({allowPositionals:true,strict:true,options:{db:{type:'string',default:'data/local-railway/railway.sqlite'},classes:{type:'string',default:'ALL'},mode:{type:'string',default:'STANDARD'},quota:{type:'string',default:'GN'},fake:{type:'boolean'},live:{type:'boolean'},json:{type:'boolean'},budget:{type:'string'},target:{type:'string'}}});
  if(positionals.length!==3||Boolean(values.fake)===Boolean(values.live))throw new Error('Usage: railway:availability:v2 -- FROM TO DD-MM-YYYY --fake|--live [--classes ALL] [--mode STANDARD]');
  if(values.quota!=='GN')throw new Error('Only GN quota is supported');
  let provider:AvailabilityProvider;
  if(values.live){
    const {RailKitProvider}=await import('../../providers/railkit/railkit-provider.js');
    if(!process.env.RAILKIT_API_KEY?.trim()||process.env.RAILKIT_API_KEY.trim()==='your_api_key_here')throw new Error('Live mode requires existing RAILKIT_API_KEY configuration');
    const railkit=new RailKitProvider();provider={getAvailability:r=>railkit.getAvailability(r)};
  }else{const {DeterministicAvailabilityProvider}=await import('../../test-support/availability-fake-provider.js');provider=new DeterministicAvailabilityProvider();}
  database=new RailwayDatabase(resolve(values.db),true);
  const result=await new PlannerV2AvailabilityService(database,provider,{budgetLimit:values.budget===undefined?undefined:Number(values.budget),usableTarget:values.target===undefined?undefined:Number(values.target)}).search({source:positionals[0],destination:positionals[1],journeyDate:positionals[2],requestedClasses:values.classes.split(','),mode:values.mode.toUpperCase() as SearchMode,quota:'GN'});
  const payload={inventoryMode:values.live?'LIVE':'FAKE_OFFLINE',...result};
  if(values.json)console.log(JSON.stringify(payload,null,2));
  else{console.log(`Inventory mode: ${payload.inventoryMode}\n${result.message}`);for(const j of result.journeys){console.log(`${j.finalRank}. ${j.status}; ${j.totalDurationMinutes} min; fare ${j.totalFare.amount??'unknown/partial'}`);for(const l of j.legs)console.log(`   ${l.trainNumber} ${l.fromStation} → ${l.toStation} ${l.boardingDate} ${l.selectedClass??'unchecked'} ${l.availabilityStatus??'unchecked'}`);}console.log(JSON.stringify({planner:result.plannerDiagnostics,availability:result.diagnostics},null,2));}
}catch(error){console.error((error as Error).message);process.exitCode=1;}finally{database?.close();}
