import type { SearchMode } from '../../application/search-mode.js';
export interface SearchApiUsage {
  externalCalls: number; callsByType: { discovery: number; trainInfo: number; availability: number }; cacheHits: number;
  budgets: { availabilityLimit: number; availabilityUsed: number; availabilityRemaining: number; percentUsed: number }; searchMode: SearchMode;
}
export function searchApiUsage(calls: SearchApiUsage['callsByType'], cacheHits: number, limit: number, searchMode: SearchMode): SearchApiUsage {
  return { externalCalls: calls.discovery + calls.trainInfo + calls.availability, callsByType: { ...calls }, cacheHits,
    budgets: { availabilityLimit: limit, availabilityUsed: calls.availability, availabilityRemaining: Math.max(0, limit - calls.availability),
      percentUsed: limit > 0 ? Math.min(100, Math.max(0, Math.round(100 * calls.availability / limit))) : 0 }, searchMode };
}
