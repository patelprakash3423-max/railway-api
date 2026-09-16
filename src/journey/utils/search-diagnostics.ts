export interface SearchDiagnostics {
  trainInfoCalls: number;
  availabilityCalls: number;
  cacheHits: number;
  directChecks: number;
  splitChecks: number;
  intermediateStationsConsidered: number;
  stationCandidates: { stationCode: string; score: number }[];
  intermediateStationsQueried: string[];
  providerUnavailableCount: number;
  providerErrorCount: number;
  waitlistCount: number;
  notAvailableCount: number;
  missingRequestedDateCount: number;
  unbookableCount: number;
  resultsCount: number;
  budgetExhausted: boolean;
  earlyStopReason?: string;
}
export function createSearchDiagnostics(): SearchDiagnostics {
  return { trainInfoCalls: 0, availabilityCalls: 0, cacheHits: 0, directChecks: 0, splitChecks: 0,
    intermediateStationsConsidered: 0, stationCandidates: [], intermediateStationsQueried: [],
    providerUnavailableCount: 0, providerErrorCount: 0, waitlistCount: 0, notAvailableCount: 0,
    missingRequestedDateCount: 0, unbookableCount: 0, resultsCount: 0, budgetExhausted: false };
}
export class JourneySearchError extends Error {
  constructor(message: string, public readonly diagnostics: SearchDiagnostics) {
    super(message);
    this.name = 'JourneySearchError';
  }
}
