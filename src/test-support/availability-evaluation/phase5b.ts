import {writeFile} from 'node:fs/promises';
import {evaluateScenario,type EvaluationResult} from './harness.js';
import {scenarios} from './scenarios.js';

// Compare only the scheduling order: both sides retain Phase 5A reinvestment.
const brief=(r:EvaluationResult)=>({calls:r.actualProviderCalls,full:r.fullJourneys,partial:r.partialJourneys,checked:r.diagnostics.checkedMatrixEdges,stop:r.diagnostics.stopReason,revisit:r.diagnostics.candidateRevisit});
const results:{id:string;group:string;budget:number;before:ReturnType<typeof brief>;after:ReturnType<typeof brief>}[]=[];
for(const s of scenarios){
 const before=await evaluateScenario({...s,candidateRevisit:true,balancedFairness:false});
 const after=await evaluateScenario({...s,candidateRevisit:true,balancedFairness:true});
 const row={id:s.id,group:s.group,budget:s.budget??300,before:brief(before),after:brief(after)};
 results.push(row);console.log(JSON.stringify(row));
}
await writeFile('docs/evaluation/phase5b-results.json',JSON.stringify(results,null,2)+'\n');
const lines=['# Phase 5B: station/class fairness evaluation','','Deterministic offline comparison using the unchanged Phase 4 fixtures. Both sides enable Phase 5A bounded revisit; only balancedFairness changes. No live provider or Redis. Run `node --import ./src/test-support/local-network-only.mjs --import tsx src/test-support/availability-evaluation/phase5b.ts` to regenerate this comparison and its JSON artifact.','',
 'Adaptive endpoint exploration first samples early, late and middle representatives across every eligible class, one station/class endpoint pair at a time. It then widens over the remaining stations in breadth-first regional order with rotating classes. Every station/class pair appears once. The pass length, solver batching, gap refinement cadence, whole-leg breadth, exact selector, provider gate and bounded revisit remain unchanged. No randomness or extra provider allowance is introduced.','',
 'Regional ordering retains early, tail, midpoint and second-tail opportunities, then bisects remaining route sections breadth-first. Left/right midpoint rounding is symmetric around the route center. It is based on route indices, not station names. Explicit-class filtering remains upstream; ALL alone permits mixed-class paths. The historical harness defaults to the previous order to preserve Phase 4/5A baseline artifacts; production AUTO enables the new order.','',
 '| Scenario | Cap | Calls before | Calls after | Full trains before | Full trains after | Partial trains before | Partial trains after |',
 '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
for(const r of results)lines.push(`| ${r.id} | ${r.budget} | ${r.before.calls} | ${r.after.calls} | ${r.before.full} | ${r.after.full} | ${r.before.partial} | ${r.after.partial} |`);
const total=(side:'before'|'after')=>results.reduce((sum,r)=>sum+r[side].calls,0);
lines.push('',`Total across these ${results.length} synthetic fixtures: ${total('before')} -> ${total('after')} provider calls. This is an unweighted fixture total, not a production cost forecast. Per-fixture changes above matter more than the aggregate.`, '',
 'Full validation results and limitations are recorded in [the architecture handoff](AVAILABILITY-ENGINE.md#phase-5b-stationclass-fairness). The original Phase 4/5A reports remain historical baselines.','');
await writeFile('docs/AVAILABILITY-PHASE5B-EVALUATION.md',lines.join('\n'));
