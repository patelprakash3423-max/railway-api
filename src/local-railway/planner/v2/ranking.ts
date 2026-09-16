import { journeyIdentity } from '../ranking.js';
import type { V2Journey } from './types.js';
const safety = (j: V2Journey) => j.connections.reduce((n, c) => n + (c.safety === 'TIGHT' ? 1 : c.safety === 'LONG' ? 2 : 0), 0);
const tiers = (j: V2Journey) => j.interchangeTiers.reduce((n, t) => n + ({ MAJOR: 0, MEDIUM: 1, SMALL: 2 }[t]), 0);
export function rankV2(a: V2Journey, b: V2Journey): number { return a.changes - b.changes || a.durationMinutes - b.durationMinutes || a.totalDistanceKm - b.totalDistanceKm || safety(a) - safety(b) || tiers(a) - tiers(b) || a.departureDateTime.localeCompare(b.departureDateTime) || journeyIdentity(a).localeCompare(journeyIdentity(b)); }
/** Different departure times represent different useful choices, not dominance. */
export function candidateDominates(a: V2Journey, b: V2Journey): boolean { return a.departureDateTime === b.departureDateTime && a.changes <= b.changes && a.durationMinutes <= b.durationMinutes && a.totalDistanceKm <= b.totalDistanceKm && (a.changes < b.changes || a.durationMinutes < b.durationMinutes || a.totalDistanceKm < b.totalDistanceKm); }
export function diversify(journeys: V2Journey[]): V2Journey[] {
  const groups = new Map<string, V2Journey[]>();
  return [...journeys].sort(rankV2).filter(j => {
    // Preserve direct service choices. For connections, a 3h departure or 2h
    // duration difference is meaningful enough to keep another signature member.
    if (!j.changes) return true;
    const key = j.segments.slice(0, -1).map(s => s.to).join('>'), group = groups.get(key) ?? [];
    const similar = group.filter(p => Math.abs(Date.parse(p.departureDateTime) - Date.parse(j.departureDateTime)) < 180 * 60000 && Math.abs(p.durationMinutes - j.durationMinutes) < 120);
    if (similar.length >= 3) return false;
    group.push(j); groups.set(key, group); return true;
  });
}
