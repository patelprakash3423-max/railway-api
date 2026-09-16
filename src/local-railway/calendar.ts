import { parseDate, addDays } from '../journey/connection/timing.js';
import { weekdays, type RunningDays } from './types.js';
const names = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
export function parseRunningDays(raw: string): RunningDays {
  if (raw.trim().toLowerCase() === 'daily') return [...weekdays];
  const tokens = raw.split(',').map(s => s.trim().toLowerCase());
  const indexes = tokens.map(s => names.findIndex(n => s === n || s === n.slice(0, 3)));
  if (!tokens.length || indexes.some(i => i < 0)) throw new Error(`Unknown running days: ${JSON.stringify(raw)}`);
  return weekdays.filter((_, i) => indexes.includes(i));
}
/** Date is the train's origin departure date, not necessarily the boarding date. Weekly schedule only. */
export function runsOnDate(train: { runningDays: RunningDays }, date: string): boolean {
  const day = new Date(parseDate(date) * 60000).getUTCDay();
  return train.runningDays.includes(weekdays[(day + 6) % 7]);
}
export function runsOnBoardingDate(train: { runningDays: RunningDays }, boardingDate: string, dayOffset: number): boolean {
  return runsOnDate(train, addDays(boardingDate, -dayOffset));
}
