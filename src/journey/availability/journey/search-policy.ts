/** Emergency logical-work bounds, including whole-leg checks; AUTO scheduling
 * normally stops much earlier. These are not provider-call targets or limits. */
export const deepJourneySearchPolicy = Object.freeze({
  maxAvailabilityChecks: 32768,
  maxChecksPerDirectCandidate: 8192,
  initialVisibleJourneys: 5,
});
