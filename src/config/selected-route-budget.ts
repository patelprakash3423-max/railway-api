export interface SelectedRouteBudgetPolicy {base:number;callsPerStop:number;minimum:number;maximum:number}
export function selectedRouteBudgetPolicy(env:NodeJS.ProcessEnv=process.env):SelectedRouteBudgetPolicy {
 const value=(key:string,fallback:number)=>{const raw=env[key]?.trim(),n=raw?Number(raw):fallback;if(!Number.isSafeInteger(n)||n<1||n>500)throw Error(`Invalid ${key}`);return n;};
 const policy={base:value('SELECTED_ROUTE_PROVIDER_CALL_BASE',20),callsPerStop:value('SELECTED_ROUTE_PROVIDER_CALLS_PER_STOP',6),minimum:value('SELECTED_ROUTE_PROVIDER_CALL_MIN',60),maximum:value('SELECTED_ROUTE_PROVIDER_CALL_MAX',500)};
 validateSelectedRouteBudgetPolicy(policy);return policy;
}
export function validateSelectedRouteBudgetPolicy(p:SelectedRouteBudgetPolicy){
 if(Object.values(p).some(n=>!Number.isSafeInteger(n)||n<1||n>500)||p.minimum>p.maximum)throw Error('Invalid selected-route budget policy: require positive integers <=500 and minimum <= maximum');
}
export function calculateSelectedRouteBudget(stops:number,policy:SelectedRouteBudgetPolicy,override?:number){
 validateSelectedRouteBudgetPolicy(policy);
 if(!Number.isSafeInteger(stops)||stops<2)throw Error('Invalid traversed scheduled stop count');
 if(override!==undefined&&(!Number.isSafeInteger(override)||override<1||override>500))throw Error('Invalid selected-route budget override');
 const calculatedDynamicBudget=Math.min(policy.maximum,Math.max(policy.minimum,policy.base+stops*policy.callsPerStop));
 return {traversedScheduledStopCount:stops,dynamicBudgetBase:policy.base,callsPerStop:policy.callsPerStop,calculatedDynamicBudget,configuredMaximumBudget:policy.maximum,dynamicBudgetMinimum:policy.minimum,explicitBudgetOverride:override,selectedLimit:Math.min(override??calculatedDynamicBudget,policy.maximum)};
}
