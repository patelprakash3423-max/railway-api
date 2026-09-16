import { travelClasses, type TravelClass } from '../journey/types/journey-segment.js';
import { parseDate } from '../journey/connection/timing.js';
import { PublicError } from './errors.js';
import type { NormalizedPublicSearch } from './public-models.js';
export function validatePublicSearch(value: unknown): NormalizedPublicSearch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PublicError('INVALID_REQUEST', 'A JSON request object is required.');
  const body = value as Record<string, unknown>;
  const station = (value: unknown): string => {
    if (typeof value !== 'string' || !/^[A-Z]{1,5}$/.test(value.trim().toUpperCase())) throw new PublicError('INVALID_STATION', 'Station codes must contain 1–5 letters.');
    return value.trim().toUpperCase();
  };
  const from = station(body.from); const to = station(body.to);
  if (from === to) throw new PublicError('INVALID_STATION', 'Source and destination must differ.');
  if (typeof body.date !== 'string') throw new PublicError('INVALID_DATE', 'A DD-MM-YYYY date is required.');
  try {
    const date = parseDate(body.date);
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(new Date());
    const part = (name: string) => parts.find((p) => p.type === name)!.value;
    if (date < parseDate(`${part('day')}-${part('month')}-${part('year')}`)) throw new Error('past');
  } catch { throw new PublicError('INVALID_DATE', 'Use a real current or future date in DD-MM-YYYY format (Asia/Kolkata).'); }
  const values = body.classes === undefined ? ['3A', 'SL', '2A'] : body.classes;
  if (!Array.isArray(values) || !values.length || !values.every((c): c is TravelClass => travelClasses.some((supported) => supported === c))) throw new PublicError('INVALID_CLASS', 'Supply a nonempty array of supported classes.');
  if (body.quota !== undefined && body.quota !== 'GN') throw new PublicError('UNSUPPORTED_QUOTA', 'Only GN quota is supported.');
  const mode = body.searchMode === undefined ? 'STANDARD' : body.searchMode;
  if (mode !== 'QUICK' && mode !== 'STANDARD' && mode !== 'DEEP') throw new PublicError('INVALID_SEARCH_MODE', 'Use QUICK, STANDARD or DEEP.');
  return { from, to, date: body.date, classes: [...new Set(values)], quota: 'GN', mode };
}
