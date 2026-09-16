import type { AvailabilityRequest } from '../domain/types/availability.js';

export function availabilityFromArgs(args: string[]): AvailabilityRequest {
  if (args.length !== 6 || args.some((value) => !value.trim())) {
    throw new Error('Usage: npm run test:availability:diagnostic -- <train> <from> <to> <DD-MM-YYYY> <class> <quota>');
  }
  const [trainNo, fromStnCode, toStnCode, date, coach, quota] = args;
  if (!/^\d{5}$/.test(trainNo)) {
    throw new Error('Train number must contain exactly five digits.');
  }
  if (!/^[A-Z]{1,5}$/.test(fromStnCode) || !/^[A-Z]{1,5}$/.test(toStnCode)) {
    throw new Error('Source and destination must be uppercase station codes of 1–5 letters.');
  }
  if (fromStnCode === toStnCode) {
    throw new Error('Source and destination must differ.');
  }
  if (!/^\d{2}-\d{2}-\d{4}$/.test(date)) {
    throw new Error('Journey date must use DD-MM-YYYY format.');
  }
  const day = Number(date.slice(0, 2));
  const month = Number(date.slice(3, 5));
  const year = Number(date.slice(6));
  const journey = new Date(Date.UTC(year, month - 1, day));
  if (journey.getUTCFullYear() !== year || journey.getUTCMonth() !== month - 1 || journey.getUTCDate() !== day) {
    throw new Error('Journey date must be a real calendar date.');
  }
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const part = (name: string) => Number(today.find((item) => item.type === name)?.value);
  if (journey.getTime() < Date.UTC(part('year'), part('month') - 1, part('day'))) {
    throw new Error('Journey date cannot be in the past (Asia/Kolkata).');
  }
  if (!['2S', 'SL', '3A', '3E', '2A', '1A', 'CC', 'EC'].includes(coach)) {
    throw new Error('Class must be one of: 2S, SL, 3A, 3E, 2A, 1A, CC, EC.');
  }
  if (quota !== 'GN') {
    throw new Error('This playground supports GN quota only.');
  }

  return { trainNumber: trainNo, fromStationCode: fromStnCode, toStationCode: toStnCode, journeyDate: date, travelClass: coach, quota };
}

export function validateAvailabilityRequest(request: AvailabilityRequest): void {
  availabilityFromArgs([request.trainNumber, request.fromStationCode, request.toStationCode, request.journeyDate, request.travelClass, request.quota]);
}
