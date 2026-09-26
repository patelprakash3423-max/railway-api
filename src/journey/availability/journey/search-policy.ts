/** Hard bounds on budgeted checks, including whole-leg checks. Provider protections still apply. */
export const deepJourneySearchPolicy = Object.freeze({
  maxAvailabilityChecks: 32768,
  maxChecksPerDirectCandidate: 8192,
  initialVisibleJourneys: 5,
});
