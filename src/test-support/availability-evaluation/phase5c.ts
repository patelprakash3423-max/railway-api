import {writeFile} from 'node:fs/promises';
import {evaluateScenario,type EvaluationResult} from './harness.js';
import {scenarios} from './scenarios.js';

function brief(r:EvaluationResult){
 const strong=new Set<number>();let fifthStrong:number|null=null;
 for(const t of r.trace)if(t.edge.a===0&&t.edge.b===r.nodes-1&&t.result.providerState==='SUCCESS'&&t.result.days.some(d=>d.state==='AVAILABLE'&&d.canBook!==false)){
  strong.add(t.edge.train);if(strong.size>=5){fifthStrong=t.calls;break;}
 }
 return {calls:r.actualProviderCalls,fifthFull:r.providerCallsUntilBestFiveWhereMeasurable,fifthStrong,
  afterFifthFull:r.callsAfterFifthFull,afterFifthStrong:fifthStrong===null?null:r.actualProviderCalls-fifthStrong,
  full:r.fullJourneys,partial:r.partialJourneys,bestFive:r.journeys.slice(0,5),results:r.journeys,
  firstOpportunity:[...new Set(r.trace.map(t=>t.edge.train))],stop:r.diagnostics.stopReason};
}
const rows=[];
for(const s of scenarios){
 const before=brief(await evaluateScenario({...s,candidateRevisit:true,balancedFairness:true,sufficientDirectResults:false}));
 const after=brief(await evaluateScenario({...s,candidateRevisit:true,balancedFairness:true,sufficientDirectResults:true}));
 const row={id:s.id,before,after};rows.push(row);
 console.log(JSON.stringify({id:s.id,before:before.calls,after:after.calls,sameResults:JSON.stringify(before.results)===JSON.stringify(after.results)}));
}
await writeFile('docs/evaluation/phase5c-results.json',JSON.stringify(rows,null,2)+'\n');
