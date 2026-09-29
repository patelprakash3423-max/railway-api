import assert from 'node:assert/strict';
import {directConcurrencyFixture} from './direct-concurrency.js';

// Real sleeps, fake responses, production scheduler. No SDK/network calls.
const results=[];
for(const concurrency of [1,2] as const){
 const h=directConcurrencyFixture({rule:()=> 'WAITLIST',wait:()=>new Promise<void>(resolve=>setTimeout(resolve,634))});
 try{
  const start=performance.now();
  const result=await h.run({directWholeLegConcurrency:concurrency,providerCallBudgetLimit:91});
  const row={concurrency,wallMs:Math.round(performance.now()-start),providerCalls:h.calls.length,
   wholeLegCalls:result.diagnostics.wholeLegRequests,recoveryCalls:result.diagnostics.recoveryIntervalRequests,maxActive:h.counts().maxActive};
  console.log(JSON.stringify(row));results.push({row,result,calls:h.calls});
 }finally{h.db.close();}
}
assert.deepEqual(results[0].calls,results[1].calls);
assert.deepEqual(results[0].result.journeys,results[1].result.journeys);
console.log(JSON.stringify({sameCalls:true,sameRankedJourneys:true,savedMs:results[0].row.wallMs-results[1].row.wallMs}));
