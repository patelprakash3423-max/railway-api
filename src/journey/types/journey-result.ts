import type { JourneySegment } from './journey-segment.js';
import type { ConnectionSafety } from '../connection/timing.js';
interface JourneyResultBase {
  totalFare?: number;
  /** Total availability calls for the entire search, not an incremental result cost. */
  totalLiveAvailabilityCallsUsed: number;
}
export interface SameTrainJourneyResult extends JourneyResultBase {
  type: 'DIRECT' | 'SAME_TRAIN_SPLIT';
  trainNumber: string;
  segments: JourneySegment[];
  splitStationCode?: string;
  splitStationName?: string;
}
export interface DifferentTrainJourneyResult extends JourneyResultBase {
  type: 'DIFFERENT_TRAIN_CONNECTION';
  connectionStationCode: string;
  connectionStationName?: string;
  connectionMinutes: number;
  connectionSafety: ConnectionSafety;
  totalScheduledDurationMinutes: number;
  segments: [JourneySegment, JourneySegment];
}
export type JourneyResult = SameTrainJourneyResult | DifferentTrainJourneyResult;
export type JourneyType = JourneyResult['type'];
