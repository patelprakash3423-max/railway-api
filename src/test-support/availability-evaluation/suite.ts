import {evaluateScenario,type EvaluationResult,type Scenario} from './harness.js';
import {scenarios} from './scenarios.js';
/** Evaluation-only continuation: new search, same retained fresh evidence, only unspent budget. */
export function revisitScenario(baseline:EvaluationResult):Scenario {
 const original=scenarios.find(s=>s.id==='no-revisit')!;
 const retained=new Set(baseline.trace.filter(t=>t.edge.train===0&&t.result.providerState==='SUCCESS').map(t=>`${t.edge.a}:${t.edge.b}:${t.edge.c}`));
 return {...original,id:'no-revisit-retained-evidence',sizes:[20],budget:baseline.diagnostics.providerCallBudgetRemaining,
  warmEdge:e=>retained.has(`${e.a}:${e.b}:${e.c}`)};
}
export async function evaluateSuite(onResult?:(r:EvaluationResult)=>void){
 const results:EvaluationResult[]=[];
 for(const scenario of scenarios){const r=await evaluateScenario(scenario);results.push(r);onResult?.(r);}
 const replay=await evaluateScenario(revisitScenario(results.find(r=>r.id==='no-revisit')!));results.push(replay);onResult?.(replay);
 return results;
}
