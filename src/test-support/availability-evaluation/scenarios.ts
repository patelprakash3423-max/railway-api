import {fiveClasses,type Edge,type Inventory,type Scenario} from './harness.js';
const split=(at:number,c?:string)=>(e:Edge):Inventory=>(e.a===0&&e.b===at||e.a===at&&e.b===19)&&(!c||e.c===c)?'AVAILABLE':'WAITLIST';
const mixed=(e:Edge):Inventory=>e.a===0&&e.b===18&&e.c==='SL'||e.a===18&&e.b===19&&e.c==='3A'?'AVAILABLE':'WAITLIST';
const bridge=(e:Edge):Inventory=>e.a===0&&e.b===5||e.a===14&&e.b===19||e.a===5&&e.b===6&&e.c==='SL'||e.a===6&&e.b===14&&e.c==='3A'?'AVAILABLE':'WAITLIST';
export const scenarios:Scenario[]=[
 {id:'small-exact',group:'size',nodes:5,classes:['SL','3A']},
 {id:'representative-cold',group:'size',nodes:9},
 {id:'representative-warm90',group:'size',nodes:9,warmPercent:90},
 {id:'large-adaptive',group:'size',nodes:20},
 {id:'very-large-adaptive',group:'size',nodes:30},
 {id:'very-large-dense',group:'complexity',nodes:30,inventory:e=>e.a!==0&&e.b!==29?'AVAILABLE':'WAITLIST'},
 {id:'very-large-branching',group:'complexity',nodes:30,inventory:e=>e.b!==29?'AVAILABLE':'WAITLIST'},
 ...[5,10,20,50,100,300].map(budget=>({id:`budget-${budget}`,group:'budget',nodes:20,budget})),
 ...[0,25,50,75,90,100].map(warmPercent=>({id:`cache-${warmPercent}`,group:'cache',nodes:20,warmPercent})),
 ...[0,25,50,75,90,100].map(warmPercent=>({id:`cache-path-${warmPercent}`,group:'cache-path',nodes:20,warmPercent,inventory:mixed})),
 ...(['hot','redis','persistent'] as const).map(cacheLayer=>({id:`cache-only-${cacheLayer}`,group:'cache',nodes:9,warmPercent:100,cacheLayer})),
 {id:'cache-logical-global',group:'limits',nodes:20,sizes:[20,20,20],warmPercent:100,logicalLimit:25},
 {id:'cache-logical-candidate',group:'limits',nodes:20,warmPercent:100,candidateLogicalLimit:30},
 ...[1,10,17,18].map(at=>({id:`position-${at}`,group:'position',nodes:20,budget:25,classes:['SL' as const],inventory:split(at)})),
 ...[0,2,4].map(i=>({id:`class-${fiveClasses[i]}`,group:'class',nodes:20,budget:50,inventory:split(18,fiveClasses[i])})),
 {id:'class-mixed',group:'class',nodes:20,budget:150,inventory:mixed},
 {id:'class-explicit',group:'class',nodes:20,budget:150,inventory:mixed,requestedClasses:['SL']},
 {id:'class-explicit-multiple',group:'class',nodes:20,budget:150,inventory:mixed,requestedClasses:['SL','3A']},
 ...[0,1,2].map(position=>({id:`train-position-${position}`,group:'train',nodes:20,sizes:[20,20,20],order:position===0?[0,1,2]:position===1?[1,0,2]:[1,2,0],budget:60,classes:['SL' as const],inventory:(e:Edge):Inventory=>e.train===0?split(10)(e):'WAITLIST'})),
 ...[0,1,2].map(position=>({id:`train-position-${position}-100`,group:'train',nodes:20,sizes:[20,20,20],order:position===0?[0,1,2]:position===1?[1,0,2]:[1,2,0],budget:100,classes:['SL' as const],inventory:(e:Edge):Inventory=>e.train===0?split(10)(e):'WAITLIST'})),
 ...[30,60,100].map(budget=>({id:`heterogeneous-${budget}`,group:'train',nodes:20,sizes:[20,20,4],budget,inventory:(e:Edge):Inventory=>e.train===1&&e.a===0&&e.b===18||e.train===2&&(e.a===0&&e.b===1||e.a===1&&e.b===19)?'AVAILABLE':'WAITLIST'})),
 // A yields while holding A-S1; B's tiny exact matrix leaves capacity unused.
 // A-S1-B needs a different class, reached in a later spine pass.
 {id:'no-revisit',group:'revisit',nodes:20,sizes:[20,3],budget:80,inventory:(e):Inventory=>e.train===0&&(e.a===0&&e.b===1&&e.c==='SL'||e.a===1&&e.b===19&&e.c==='2S')?'AVAILABLE':'WAITLIST'},
 {id:'no-revisit-counterfactual',group:'revisit',nodes:20,sizes:[20,3],order:[1,0],budget:80,inventory:(e):Inventory=>e.train===0&&(e.a===0&&e.b===1&&e.c==='SL'||e.a===1&&e.b===19&&e.c==='2S')?'AVAILABLE':'WAITLIST'},
 ...[50,150].flatMap(budget=>[false,true].map(warm=>({id:`bridge-${budget}-${warm?'warm':'cold'}`,group:'gap',nodes:20,budget,inventory:bridge,warmEdge:warm?(e:Edge)=>e.a===5&&e.b===6&&e.c==='SL'||e.a===6&&e.b===14&&e.c==='3A':undefined}))),
 {id:'gap-no-bridge',group:'gap',nodes:20,budget:150,inventory:(e):Inventory=>e.a===0&&e.b===5||e.a===14&&e.b===19?'AVAILABLE':'WAITLIST'},
 ...[1,5,7].flatMap(count=>(['AVAILABLE','RAC'] as const).map(state=>({id:`direct-${count}-${state}`,group:'direct',nodes:20,sizes:Array.from({length:count},()=>20),inventory:(e:Edge):Inventory=>e.a===0&&e.b===19?state:'WAITLIST'}))),
 {id:'partials-only',group:'direct',nodes:20,sizes:[20,20,20,20,20],inventory:(e):Inventory=>e.a===0&&e.b===18?'AVAILABLE':'WAITLIST'},
 ...[90000,1000,30].map(deadlineMs=>({id:`deadline-${deadlineMs}`,group:'deadline',nodes:20,classes:['SL' as const],deadlineMs,attemptMs:10,inventory:(e:Edge):Inventory=>e.a===0&&e.b===1?'AVAILABLE':'WAITLIST'})),
 ...(['rate','unavailable','individual'] as const).map(failure=>({id:`failure-${failure}`,group:'failure',nodes:9,classes:['SL' as const],failure,failureAt:8,inventory:(e:Edge):Inventory=>e.a===0&&e.b===7?'AVAILABLE':'NOT_AVAILABLE'})),
];
