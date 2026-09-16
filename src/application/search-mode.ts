import { multiModes } from '../domain/planner/types.js';
import { recoveryModes } from '../domain/recovery/types.js';
import type { ConnectionSearchOptions } from '../journey/connection/connection-search-engine.js';
import { defaultConnectionBudget, defaultConnectionPolicy } from '../journey/connection/budget.js';
export type SearchMode = 'QUICK' | 'STANDARD' | 'DEEP';
// Fresh nested objects each time; no request mutates shared configuration.
export function searchModeConfig(mode: SearchMode): ConnectionSearchOptions {
  const standard = { orchestration: 'STANDARD' as const, multi: { ...multiModes.STANDARD }, recovery: { ...recoveryModes.STANDARD }, budget: { ...defaultConnectionBudget }, policy: { ...defaultConnectionPolicy } };
  switch (mode) {
    case 'QUICK': return { orchestration: 'QUICK', multi: { ...multiModes.QUICK }, recovery: { ...recoveryModes.QUICK }, budget: { ...standard.budget, maxAvailabilityCalls: 12, maxConnectionStations: 1,
      maxTrainDiscoveryCalls: 4, maxTrainInfoCalls: 2, maxTrainsPerLeg: 3, maxTrainPairsPerConnection: 3, maxResults: 2 },
      policy: { ...standard.policy, strongDirectSkipThreshold: 1, directOptionsPerTrain: 1 } };
    case 'STANDARD': return standard;
    case 'DEEP': return { orchestration: 'DEEP', multi: { ...multiModes.DEEP }, recovery: { ...recoveryModes.DEEP }, budget: { ...standard.budget, maxAvailabilityCalls: 40, maxConnectionStations: 4,
      maxTrainDiscoveryCalls: 10, maxTrainInfoCalls: 10, maxTrainPairsPerConnection: 8, maxResults: 8 },
      policy: { ...standard.policy, broadenDirectClassAlternatives: true, directAvailableWideningTarget: 3,
        strongDirectSkipThreshold: 5, strongDirectReduceThreshold: 3 } };
  }
}
