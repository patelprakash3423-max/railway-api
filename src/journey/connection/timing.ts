import type { TrainCandidate } from '../../domain/types/train-search.js';
export const minutesPerDay = 1440;
export function parseDate(value: string): number {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value);
  if (!match) throw new Error('Date must use DD-MM-YYYY.');
  const [day, month, year] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error('Invalid calendar date.');
  return date.getTime() / 60000;
}
export function formatDate(absoluteMinutes: number): string {
  const date = new Date(absoluteMinutes * 60000);
  return `${String(date.getUTCDate()).padStart(2, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${date.getUTCFullYear()}`;
}
export function addDays(value: string, days: number): string {
  if (!Number.isSafeInteger(days)) throw new Error('Day offset must be an integer.');
  return formatDate(parseDate(value) + days * minutesPerDay);
}
export function clockMinutes(value: string | null): number | undefined {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return undefined;
  const [hour, minute] = value.split(':').map(Number);
  return hour < 24 && minute < 60 ? hour * 60 + minute : undefined;
}
export function routeDayOffset(sourceDay: number, destinationDay: number): number {
  if (!Number.isInteger(sourceDay) || !Number.isInteger(destinationDay) || sourceDay < 1 || destinationDay < sourceDay) throw new Error('Invalid route day offset.');
  return destinationDay - sourceDay;
}
export interface ScheduledRun { train: TrainCandidate; boardingDate: string; departure: number; arrival: number }
export function scheduledRun(train: TrainCandidate, boardingDate: string): ScheduledRun | undefined {
  const departureClock = clockMinutes(train.departureTime);
  const arrivalClock = clockMinutes(train.arrivalTime);
  if (departureClock === undefined || arrivalClock === undefined) return undefined;
  let duration = train.durationMinutes;
  if (duration === undefined && train.sourceDayNumber !== undefined && train.destinationDayNumber !== undefined) {
    try { duration = routeDayOffset(train.sourceDayNumber, train.destinationDayNumber) * minutesPerDay + arrivalClock - departureClock; }
    catch { return undefined; }
  }
  if (duration === undefined || !Number.isSafeInteger(duration) || duration <= 0 || (departureClock + duration) % minutesPerDay !== arrivalClock) return undefined;
  const departure = parseDate(boardingDate) + departureClock;
  return { train, boardingDate, departure, arrival: departure + duration };
}
export type ConnectionSafety = 'TIGHT' | 'GOOD' | 'LONG';
export interface ConnectionTimeConfig {
  minimumConnectionMinutes: number;
  preferredConnectionMinutes: number;
  maximumConnectionMinutes: number;
  /** Explicit opt-in only. Also provides a finite upper bound. */
  allowLongConnections: boolean;
  longConnectionLimitMinutes: number;
}
export const defaultConnectionTimes: Readonly<ConnectionTimeConfig> = Object.freeze({
  minimumConnectionMinutes: 60, preferredConnectionMinutes: 120, maximumConnectionMinutes: 360,
  allowLongConnections: false, longConnectionLimitMinutes: 720,
});
export function connectionTimes(input: Partial<ConnectionTimeConfig> = {}): ConnectionTimeConfig {
  const config = { ...defaultConnectionTimes, ...input };
  if ([config.minimumConnectionMinutes, config.preferredConnectionMinutes, config.maximumConnectionMinutes, config.longConnectionLimitMinutes]
    .some((n) => !Number.isSafeInteger(n) || n <= 0) || config.minimumConnectionMinutes > config.preferredConnectionMinutes ||
    config.preferredConnectionMinutes > config.maximumConnectionMinutes || config.longConnectionLimitMinutes < config.maximumConnectionMinutes) throw new Error('Invalid connection time limits.');
  return config;
}
export function connectionSafety(minutes: number, config: ConnectionTimeConfig): ConnectionSafety | undefined {
  if (minutes < config.minimumConnectionMinutes) return undefined;
  if (minutes <= config.maximumConnectionMinutes) return minutes < config.preferredConnectionMinutes ? 'TIGHT' : 'GOOD';
  return config.allowLongConnections && minutes <= config.longConnectionLimitMinutes ? 'LONG' : undefined;
}
export function departureDates(arrival: number, config: ConnectionTimeConfig): string[] {
  const start = arrival + config.minimumConnectionMinutes;
  const end = arrival + (config.allowLongConnections ? config.longConnectionLimitMinutes : config.maximumConnectionMinutes);
  const dates: string[] = [];
  for (let day = Math.floor(start / minutesPerDay); day <= Math.floor(end / minutesPerDay); day += 1) dates.push(formatDate(day * minutesPerDay));
  return dates;
}
