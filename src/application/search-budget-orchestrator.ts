export const searchStages = ['direct','sameTrainRecovery','oneChange','multiInterchange'] as const;
export type SearchStage = typeof searchStages[number];
export type AttemptState = 'NOT_APPLICABLE'|'NOT_STARTED'|'STARTED'|'MEANINGFUL_ATTEMPT'|'COMPLETED'|'STOPPED';
export const stageFloors = {
 QUICK:{direct:2,sameTrainRecovery:2,oneChange:2,multiInterchange:3},
 STANDARD:{direct:3,sameTrainRecovery:3,oneChange:5,multiInterchange:5},
 DEEP:{direct:4,sameTrainRecovery:4,oneChange:8,multiInterchange:8},
};
export interface StageBudgetUsage {
 externalAvailabilityCalls:number;cacheHits:number;protectedFloor:number;meaningfulAttempt:boolean;state:AttemptState;
 pausedForLaterStageProtection:boolean;adaptiveCallsBorrowed:number;initialClassChecks:number;deferredClassChecks:number;resumedClassChecks:number;classChecksSkippedForBudgetProtection:number;
}
/** Single request-local gate. Floors reserve opportunity, never mandate calls. */
export class SearchBudgetOrchestrator {
 readonly stageUsage:Record<SearchStage,StageBudgetUsage>;
 private released=new Set<SearchStage>(); private used=0; private resumed=false;
 strongResultExists=false;
 preventedByReservation=0;preventedByAtomicCost=0;insufficientRemainingBudget=false;
 constructor(readonly limit:number,readonly mode:keyof typeof stageFloors){
  if(!Number.isSafeInteger(limit)||limit<0)throw new Error('Invalid availability limit');
  const floors=stageFloors[mode],sum=Object.values(floors).reduce((a,b)=>a+b,0);
  // Custom smaller test/deployment caps cannot create extra capacity.
  this.stageUsage=Object.fromEntries(searchStages.map(s=>[s,{externalAvailabilityCalls:0,cacheHits:0,protectedFloor:Math.floor(floors[s]*Math.min(1,limit/sum)),meaningfulAttempt:false,state:'NOT_STARTED',pausedForLaterStageProtection:false,adaptiveCallsBorrowed:0,initialClassChecks:0,deferredClassChecks:0,resumedClassChecks:0,classChecksSkippedForBudgetProtection:0}])) as Record<SearchStage,StageBudgetUsage>;
 }
 remaining(){return this.limit-this.used;}
 protectedFor(stage:SearchStage){return searchStages.filter(s=>searchStages.indexOf(s)>searchStages.indexOf(stage)&&!this.released.has(s)).reduce((n,s)=>n+Math.max(0,this.stageUsage[s].protectedFloor-this.stageUsage[s].externalAvailabilityCalls),0);}
 canSpend(stage:SearchStage,cost:number,atomic=false){
  if(cost===0)return true;
  const protectedCalls=this.protectedFor(stage),u=this.stageUsage[stage];
  if(cost>this.remaining()-protectedCalls){
   if(cost<=this.remaining()&&protectedCalls){this.preventedByReservation++;u.pausedForLaterStageProtection=true;u.classChecksSkippedForBudgetProtection++;}
   if(atomic){this.preventedByAtomicCost++;if(cost>this.remaining())this.insufficientRemainingBudget=true;}
   return false;
  }
  return true;
 }
 start(stage:SearchStage){if(this.stageUsage[stage].state==='NOT_STARTED')this.stageUsage[stage].state='STARTED';}
 recordSpend(stage:SearchStage){this.used++;const u=this.stageUsage[stage];u.externalAvailabilityCalls++;u.adaptiveCallsBorrowed=Math.max(0,u.externalAvailabilityCalls-u.protectedFloor);if(this.resumed)u.resumedClassChecks++;else u.initialClassChecks++;}
 recordCacheHit(stage:SearchStage){this.stageUsage[stage].cacheHits++;}
 markMeaningfulAttempt(stage:SearchStage){this.stageUsage[stage].meaningfulAttempt=true;this.stageUsage[stage].state='MEANINGFUL_ATTEMPT';this.released.add(stage);}
 releaseStageProtection(stage:SearchStage,applicable=true){this.released.add(stage);this.stageUsage[stage].state=applicable?'COMPLETED':'NOT_APPLICABLE';}
 defer(stage:SearchStage,count=1){this.stageUsage[stage].deferredClassChecks+=count;}
 resume(){this.resumed=true;}
 snapshot(){return {searchMode:this.mode,strongResultExists:this.strongResultExists,globalAvailabilityLimit:this.limit,globalAvailabilityUsed:this.used,stageUsage:structuredClone(this.stageUsage),protectedRemainingForLaterStages:searchStages.filter(s=>!this.released.has(s)).reduce((n,s)=>n+Math.max(0,this.stageUsage[s].protectedFloor-this.stageUsage[s].externalAvailabilityCalls),0),preventedByReservation:this.preventedByReservation,preventedByAtomicCost:this.preventedByAtomicCost,adaptivePoolUsed:searchStages.reduce((n,s)=>n+this.stageUsage[s].adaptiveCallsBorrowed,0)};}
}
export type BudgetOrchestrationDiagnostics=ReturnType<SearchBudgetOrchestrator['snapshot']>;

export interface DeferredValidation { run:()=>Promise<void>; value:number }
/** Scheduling only: prioritize completing ranked candidates over low-priority class widening. */
export function adaptiveCallValue(coverage:number,classPriority:number,uncachedCost:number,trainChanges:number):number {
 return 100*coverage + 40 - 12*classPriority - 4*uncachedCost - 10*trainChanges;
}
