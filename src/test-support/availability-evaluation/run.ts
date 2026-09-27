import {writeFile,mkdir} from 'node:fs/promises';
import {evaluateScenario} from './harness.js';
import {scenarios} from './scenarios.js';
import {evaluateSuite} from './suite.js';
import type {EvaluationResult} from './harness.js';
import {evaluationReport} from './report.js';
const selected=process.argv.slice(2);
const log=(r:EvaluationResult)=>{
 console.log(JSON.stringify({id:r.id,calls:r.actualProviderCalls,coverage:r.diagnostics.matrixCoverage,full:r.fullJourneys,partial:r.partialJourneys,stop:r.diagnostics.stopReason,first:r.providerCallsUntilFirstFullPath,solves:r.structural.solverInvocations}));
};
const results:EvaluationResult[]=[];
if(!selected.length)results.push(...await evaluateSuite(log));
else for(const scenario of scenarios.filter(s=>selected.includes(s.id))){const r=await evaluateScenario(scenario);results.push(r);log(r);}
await mkdir('docs/evaluation',{recursive:true});
await writeFile(selected.length?'phase4-selected.log':'docs/evaluation/phase4-results.json',JSON.stringify(results.map(({trace,journeys,...r})=>({...r,journeys:journeys.map(({segments,...j})=>j)})),null,2)+'\n');
if(!selected.length)await writeFile('docs/AVAILABILITY-PHASE4-EVALUATION.md',evaluationReport(results));
