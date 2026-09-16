import assert from 'node:assert/strict';
import {RailwayDatabase} from '../dist/local-railway/database.js';
import {LocalJourneyPlannerV2} from '../dist/local-railway/planner/v2/planner.js';
const db=new RailwayDatabase(process.env.LOCAL_RAILWAY_DB_PATH||'data/local-railway/railway.sqlite',true);
try{
 assert.equal(db.readOnly,true);assert.equal(db.metadata().source,'RAILPULL_NTES');assert.ok(db.station('NDLS'));assert.ok(db.station('SV'));
 const tomorrow=new Date(Date.now()+86400000+330*60000).toISOString().slice(0,10).split('-').reverse().join('-');
 const result=new LocalJourneyPlannerV2(db).search({from:'NDLS',to:'SV',date:tomorrow});assert.ok(result.journeys.length);
 console.log(JSON.stringify({readOnly:db.readOnly,stations:['NDLS','SV'],scheduledCandidates:result.journeys.length,providerCalls:0}));
}finally{db.close();}
