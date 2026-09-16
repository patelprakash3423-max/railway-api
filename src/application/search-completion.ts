import type { ConnectionSearchDiagnostics } from '../journey/connection/types.js';

export type SearchInterruption = 'CRITICAL_PROVIDER_FAILURE' | 'TIMEOUT' | 'CANCELLED';

/** Completion of the chosen policy, not exhaustive discovery of all railway journeys. */
export function classifySearchCompletion(
  diagnostics: ConnectionSearchDiagnostics,
  interruption?: SearchInterruption,
): { searchCompleted: boolean; partialResults: boolean } {
  // Aggregate provider/missing-data counters describe candidate-level failures, not
  // whether the selected policy finished. Require explicit critical interruption.
  const criticalFailure = interruption !== undefined ||
    diagnostics.earlyStopReason === 'DIRECT_DISCOVERY_FAILED_NO_CONNECTION_SEEDS';
  // These goals may be achieved on the last permitted call. In that case a zero
  // remaining balance is not evidence that execution was cut short.
  const goalReached = diagnostics.earlyStopReason === 'MAX_RESULTS_REACHED' ||
    diagnostics.earlyStopReason === 'ENOUGH_STRONG_DIRECT_RESULTS';
  const budgetTruncated = !goalReached && (diagnostics.availabilityBudgetExhausted ||
    diagnostics.trainDiscoveryBudgetExhausted || diagnostics.trainInfoBudgetExhausted || diagnostics.insufficientRemainingBudgetForNextExpansion);
  const searchCompleted = !criticalFailure && !budgetTruncated;
  return { searchCompleted, partialResults: !searchCompleted };
}
