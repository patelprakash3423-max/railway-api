import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { RailwayDatabase } from '../../../local-railway/database.js';
import { searchModeConfig,type SearchMode } from '../../../application/search-mode.js';
import { AvailabilitySession } from '../session.js';
import { localRecoveryLeg } from './local-leg.js';
import { FakeRecoveryProvider } from '../../../test-support/recovery-fake-provider.js';
import { recoverSingleTrainLeg } from './recover.js';
let database:RailwayDatabase|undefined;
try{
  const {values,positionals}=parseArgs({allowPositionals:true,strict:true,options:{fake:{type:'boolean'},json:{type:'boolean'},db:{type:'string',default:'data/local-railway/railway.sqlite'},classes:{type:'string',default:'ALL'},mode:{type:'string',default:'STANDARD'},budget:{type:'string'},scenario:{type:'string',default:'SPLIT'},'min-coverage':{type:'string',default:'0.5'}}});
  if(!values.fake||positionals.length!==4)throw new Error('Usage: railway:recover:v2 -- TRAIN FROM TO DD-MM-YYYY --fake [--scenario SPLIT|PARTIAL] [--classes ALL]');
  if(!['SPLIT','PARTIAL'].includes(values.scenario)||!['QUICK','STANDARD','DEEP'].includes(values.mode))throw new Error('Invalid scenario or mode');
  database=new RailwayDatabase(resolve(values.db),true);
  const input=localRecoveryLeg(database,positionals[0],positionals[1],positionals[2],positionals[3],values.classes.split(','));
  const provider=new FakeRecoveryProvider(database,input,values.scenario as 'SPLIT'|'PARTIAL'),session=new AvailabilitySession(provider,values.budget===undefined?searchModeConfig(values.mode as SearchMode).budget!.maxAvailabilityCalls!:Number(values.budget));
  const result=await recoverSingleTrainLeg(database,session,input,{minimumReservedCoverageRatio:Number(values['min-coverage'])});
  if(values.json)console.log(JSON.stringify({inventoryMode:'FAKE_OFFLINE',dataset:database.metadata().label,...result},null,2));
  else{console.log(`FAKE_OFFLINE — synthetic inventory only\n${result.best.recoveryStatus}\nReserved coverage: ${(result.best.reservedCoverageRatio*100).toFixed(2)}%; class changes: ${result.best.classChanges}`);for(const s of result.best.segments)console.log(`${s.type}: ${s.fromStation} → ${s.toStation}, ${s.distanceKm} km${s.type==='RESERVED'?`, ${s.selectedClass} ${s.availabilityStatus}`:`, ${s.notice}`}`);console.log(JSON.stringify(result.diagnostics,null,2));}
}catch(error){console.error((error as Error).message);process.exitCode=1;}finally{database?.close();}
