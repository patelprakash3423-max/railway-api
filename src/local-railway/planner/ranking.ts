import type { ScheduledJourney } from './types.js';
export function journeyIdentity(j: ScheduledJourney): string { return JSON.stringify(j.segments.map(s => [s.trainNumber, s.from, s.to, s.departureDateTime, s.arrivalDateTime])); }
export function rankScheduled(a: ScheduledJourney, b: ScheduledJourney): number {
  const penalty = (j: ScheduledJourney) => j.connections.reduce((n, c) => n + (c.safety === 'GOOD' ? 0 : c.safety === 'TIGHT' ? 1 : 2), 0);
  const distance = (a.totalDistanceKm ?? Infinity) - (b.totalDistanceKm ?? Infinity);
  return a.changes - b.changes || penalty(a) - penalty(b) || a.durationMinutes - b.durationMinutes || distance || a.arrivalDateTime.localeCompare(b.arrivalDateTime) || journeyIdentity(a).localeCompare(journeyIdentity(b));
}
