import type { ReservedTrainSegment, ReservedCoverage, StationRef } from '../recovery/types.js';
import type { ScheduledRun, ConnectionSafety } from '../../journey/connection/timing.js';
export interface MultiConfig { beamWidth: number; trainsPerStation: number; availability: number; discovery: number; trainInfo: number; detour: number; deep: boolean }
export const multiModes: Record<'QUICK'|'STANDARD'|'DEEP', MultiConfig> = {
 QUICK:{beamWidth:3,trainsPerStation:2,availability:8,discovery:3,trainInfo:3,detour:1.35,deep:false},
 STANDARD:{beamWidth:5,trainsPerStation:3,availability:14,discovery:5,trainInfo:5,detour:1.6,deep:false},
 DEEP:{beamWidth:8,trainsPerStation:4,availability:22,discovery:8,trainInfo:8,detour:2,deep:true},
};
export interface ConnectionSummary { station: StationRef; minutes: number; safety: ConnectionSafety }
export interface MultiTrainJourneyCandidate {
 type:'MULTI_TRAIN_JOURNEY'; requestedFrom: StationRef; requestedTo: StationRef; segments: ReservedTrainSegment[];
 reservedCoverage: ReservedCoverage; reservedSegmentCount: number; trainChangeCount: number; classChangeCount: number;
 totalReservedFare?: number; totalScheduledDurationMinutes: number; connectionCount: number; connections: ConnectionSummary[];
 score: number; quality:'EXCELLENT'|'STRONG'|'USEFUL'; warnings: string[]; explanation:string;
}
/** Timetable frontier: seats are checked bottleneck-first only after a complete temporal path exists. */
export interface PartialJourneyPath { runs: ScheduledRun[]; visitedStations: Set<string>; visitedTrains: Set<string>; progress: number; distance?: number; score: number }
export interface MultiDiagnostics {
 multiInterchangeActivated:boolean; multiInterchangePartialPathsGenerated:number; multiInterchangePathsExpanded:number;
 multiInterchangeBeamPruned:number; multiInterchangeDominancePruned:number; multiInterchangeUpperBoundPruned:number;
 multiInterchangeTimingPruned:number; multiInterchangeLoopPruned:number; multiInterchangeDetourPruned:number;
 multiInterchangeAvailabilityChecks:number; multiInterchangeCacheHits:number; multiInterchangeCompletedPaths:number; multiInterchangeStrongStopCount:number;
 multiInterchangeMaxFrontier:number;
}
export function multiDiagnostics():MultiDiagnostics { return { multiInterchangeActivated:false,multiInterchangePartialPathsGenerated:0,multiInterchangePathsExpanded:0,
 multiInterchangeBeamPruned:0,multiInterchangeDominancePruned:0,multiInterchangeUpperBoundPruned:0,multiInterchangeTimingPruned:0,multiInterchangeLoopPruned:0,
 multiInterchangeDetourPruned:0,multiInterchangeAvailabilityChecks:0,multiInterchangeCacheHits:0,multiInterchangeCompletedPaths:0,multiInterchangeStrongStopCount:0,multiInterchangeMaxFrontier:0 }; }
