import type { JourneyResult } from '../journey/types/journey-result.js';
import type { PublicJourneyResult, PublicJourneySegment } from './public-models.js';
import { redact } from '../utils/errors.js';
export function serializeJourney(result: JourneyResult): PublicJourneyResult {
  const segments: PublicJourneySegment[] = result.segments.map((s) => ({
    trainNumber: s.trainNumber, fromStationCode: s.fromStationCode, toStationCode: s.toStationCode,
    journeyDate: s.journeyDate, travelClass: s.travelClass, availabilityState: s.availabilityState,
    availabilityText: s.availabilityText === undefined ? undefined : redact(s.availabilityText),
    fare: s.fare === undefined ? undefined : { totalFare: s.fare.totalFare, currency: 'INR' },
  }));
  const base: PublicJourneyResult = { type: result.type, segments, totalFare: result.totalFare };
  if (result.type === 'DIFFERENT_TRAIN_CONNECTION') {
    base.connection = { stationCode: result.connectionStationCode,
      stationName: result.connectionStationName === undefined ? undefined : redact(result.connectionStationName),
      minutes: result.connectionMinutes, safety: result.connectionSafety };
    base.totalScheduledDurationMinutes = result.totalScheduledDurationMinutes;
  } else {
    base.trainNumber = result.trainNumber;
    if (result.type === 'SAME_TRAIN_SPLIT') base.split = { stationCode: result.splitStationCode, stationName: result.splitStationName };
  }
  return base;
}

/** Explicit allowlist: internal score, keys and provider payloads never become public fields. */
export function serializeRecovery(c: import('../domain/recovery/types.js').JourneyRecoveryCandidate): import('./public-models.js').PublicRecoveryResult {
  const ref = (s: import('../domain/recovery/types.js').StationRef) => ({ code: s.code, name: s.name });
  return { type: 'JOURNEY_RECOVERY', requestedFrom: ref(c.requestedFrom), requestedTo: ref(c.requestedTo),
    recoveryType: c.recoveryType, quality: c.quality, reservedCoverage: { ratio: c.reservedCoverage.ratio, percentage: c.reservedCoverage.percentage, method: c.reservedCoverage.method },
    reservedSegmentCount: c.reservedSegmentCount, selfManagedSegmentCount: c.selfManagedSegmentCount,
    trainChangeCount: c.trainChangeCount, classChangeCount: c.classChangeCount, totalReservedFare: c.totalReservedFare,
    warnings: [...c.warnings], explanation: c.explanation,
    segments: c.segments.map((s) => s.type === 'SELF_MANAGED' ? { type: s.type, from: ref(s.from), to: ref(s.to), reason: s.reason, distanceKm: s.distanceKm, note: s.note } :
      { type: s.type, trainNumber: s.trainNumber, trainName: s.trainName, from: ref(s.from), to: ref(s.to), journeyDate: s.journeyDate,
        classCode: s.classCode, quota: s.quota, availability: s.availability, availabilityText: s.availabilityText, fare: s.fare,
        scheduledDeparture: s.scheduledDeparture, scheduledArrival: s.scheduledArrival, distanceKm: s.distanceKm }) };
}
