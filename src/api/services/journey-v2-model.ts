import type {AvailabilityMetrics} from '../../providers/availability-observation.js';
import type {JourneyPresentation,PresentationMetadata} from '../../journey/presentation/types.js';
export type JourneyV2Status = 'FULLY_RESERVED_USABLE'|'FULLY_RESERVED_WITH_SPLIT_CLASS'|'PARTIAL_RESERVED_RECOVERY'|'SCHEDULED_BUT_NOT_FULLY_AVAILABLE'|'INVENTORY_CHECK_INCOMPLETE';
export interface JourneyV2Request { from:string; to:string; date:string; classes:string[]|'ALL'; mode?:'QUICK'|'STANDARD'|'DEEP'; quota?:'GN' }
export type JourneyV2Segment = {type:'RESERVED';fromStation:string;toStation:string;selectedClass:string;availabilityStatus:'AVAILABLE'|'RAC';availabilityText?:string;distanceKm:number;fare:number|null;departureDateTime:string;arrivalDateTime:string;reservationCount:number}|{type:'SELF_MANAGED';fromStation:string;toStation:string;distanceKm:number};
export interface JourneyV2Result {
 presentation?:JourneyPresentation;
 id:string;status:JourneyV2Status;from:string;to:string;departureDateTime:string;arrivalDateTime:string;totalDurationMinutes:number;totalDistanceKm:number;trainChanges:number;classChanges:number;reservedCoverageRatio:number;unknownDistanceKm:number;
 totalFare:{status:'COMPLETE'|'PARTIAL'|'UNKNOWN';amount:number|null;currency:'INR'};
 connections:{station:string;waitMinutes:number;safety:'TIGHT'|'GOOD'|'LONG'}[];
 legs:{trainNumber:string;trainName:string;scheduledFrom:string;scheduledTo:string;departureDateTime:string;arrivalDateTime:string;distanceKm:number;recoveryStatus:string;unknownDistanceKm:number;segments:JourneyV2Segment[]}[];
}
export interface JourneyV2Diagnostics extends Omit<AvailabilityMetrics,'unsupportedEvidenceCacheHits'|'providerUnsupportedResponses'> {
 /** availabilityCalls, wholeLegCalls, recoveryCalls and budgetUsed count checks, not HTTP requests. */
 plannerCandidates:number;availabilityCalls:number;wholeLegCalls:number;recoveryCalls:number;cacheHits:number;budgetLimit:number;budgetUsed:number;budgetRemaining:number;recoveryReserveInitial:number;recoveryReserveUsed:number;recoveryReserveReleased:number;availableResponses:number;racResponses:number;waitlistResponses:number;unsupportedClassResponses:number;providerErrors:number;discoveryCalls:0;trainInfoCalls:0;truncated:boolean;
}
export interface JourneyV2Response {
 requestId:string;search:JourneyV2Request & {mode:'QUICK'|'STANDARD'|'DEEP';quota:'GN'};results:(JourneyV2Result & {presentation:JourneyPresentation})[];presentation:PresentationMetadata;
 summary:{totalResults:number;fullyReserved:number;fullSplitClass:number;partialRecovery:number;scheduledFallback:number;inventoryIncomplete:number};
 diagnostics?:JourneyV2Diagnostics;
}
