export const defaultBounds = { maxDirectResults: 20, maxInterchangeStationsPerExpansion: 50, maxTrainsPerExpansion: 30, beamWidth: 30, maxCandidateJourneys: 100, finalResultLimit: 20 };
export type SearchBounds = typeof defaultBounds;
export function searchBounds(input: Partial<SearchBounds> = {}): SearchBounds {
  const result = { ...defaultBounds, ...input };
  if (Object.values(result).some(n => !Number.isSafeInteger(n) || n < 1 || n > 10000)) throw new Error('Local search bounds must be integers from 1 to 10000');
  return result;
}
