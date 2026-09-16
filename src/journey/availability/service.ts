import { LocalJourneyPlannerV2 } from '../../local-railway/planner/v2/planner.js';
import type { RailwayDatabase } from '../../local-railway/database.js';
import { AvailabilityOrchestrator } from './orchestrator.js';
import type { AvailabilityProvider, ValidationInput, ValidationOptions } from './types.js';
export class PlannerV2AvailabilityService {
  constructor(private readonly database: RailwayDatabase, private readonly provider: AvailabilityProvider, private readonly options: ValidationOptions = {}) {}
  async search(input: Omit<ValidationInput,'plannerCandidates'|'plannerDiagnostics'>) {
    // Local snapshot finishes before any provider invocation.
    const planner=new LocalJourneyPlannerV2(this.database).search({from:input.source,to:input.destination,date:input.journeyDate});
    const inventory=await new AvailabilityOrchestrator(this.provider,this.options).validate({...input,plannerCandidates:planner.journeys,plannerDiagnostics:planner.diagnostics});
    return {kind:'SCHEDULE_AND_INVENTORY_VALIDATION' as const,dataset:planner.dataset,plannerDiagnostics:planner.diagnostics,...inventory};
  }
}
