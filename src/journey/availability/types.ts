import type { RailwayProvider } from '../../providers/railway-provider.js';
import type { AvailabilityResult } from '../../domain/types/availability.js';
import type { Fare } from '../../domain/types/fare.js';
import type { SearchMode } from '../../application/search-mode.js';
import type { TravelClass } from '../types/journey-segment.js';
import type { V2Journey, V2Result } from '../../local-railway/planner/v2/types.js';
import type {AvailabilityMetrics} from '../../providers/availability-observation.js';
/** The integration cannot access discovery or train-info methods. */
export type AvailabilityProvider = Pick<RailwayProvider, 'getAvailability'> & {
  assertConfigured?: () => void;
  /** Other injected providers retain conservative adapter-invocation accounting. */
  quotaAccounting?: 'SDK_INVOCATION';
};
export type InventoryStatus = 'AVAILABLE' | 'RAC' | 'WAITLIST' | 'UNAVAILABLE' | 'UNSUPPORTED_CLASS' | 'PROVIDER_ERROR';
export type ErrorCategory = 'RATE_LIMITED' | 'INVALID_REQUEST' | 'UNSUPPORTED_CLASS' | 'BOOKING_UNSUPPORTED' | 'PROVIDER_UNAVAILABLE' | 'INVALID_PROVIDER_RESPONSE' | 'UNKNOWN_PROVIDER_ERROR';
export interface InventoryCheck { unsupportedScope?: 'EXACT_REQUEST'; travelClass: TravelClass; status: InventoryStatus; availabilityText?: string; fare?: Fare; errorCategory?: ErrorCategory; rawDetails?: AvailabilityResult }
export type ValidationStatus = 'FULLY_RESERVED_USABLE' | 'SCHEDULED_BUT_NOT_FULLY_AVAILABLE' | 'INVENTORY_CHECK_INCOMPLETE';
export interface ValidatedLeg { trainNumber: string; fromStation: string; toStation: string; boardingDate: string; departureDateTime: string; arrivalDateTime: string; distanceKm: number; selectedClass: TravelClass | null; quota: 'GN'; availabilityStatus: InventoryStatus | null; availabilityText?: string; fare?: Fare; checks: InventoryCheck[] }
export interface ValidatedJourney {
  scheduleCandidateId: string; status: ValidationStatus; scheduleCandidate: V2Journey; legs: ValidatedLeg[];
  availableLegCount: number; racLegCount: number; waitlistedLegCount: number; classChanges: number; trainChanges: number;
  totalDurationMinutes: number; totalDistanceKm: number; detourPercent: number;
  totalFare: { status: 'COMPLETE' | 'PARTIAL' | 'UNKNOWN'; amount: number | null; knownSubtotal: number; knownLegCount: number; currency: 'INR' };
  scheduleRank: number; finalRank: number;
}
export interface AvailabilityDiagnostics extends AvailabilityMetrics {
  plannerCandidatesReceived: number; candidatesValidationStarted: number; candidatesFullyValidated: number; candidatesRejectedByInventory: number; candidatesDeferredByBudget: number;
  availabilityBudgetLimit: number; availabilityRequestsUsed: number; availabilityCacheHits: number; budgetRemaining: number;
  classRoundsAttempted: TravelClass[][]; classChecksByClass: Partial<Record<TravelClass, number>>;
  availableResponses: number; racResponses: number; waitlistResponses: number; unavailableResponses: number; unsupportedClassResponses: number; providerErrors: number; providerErrorCategories: Partial<Record<ErrorCategory, number>>;
  bottleneckEarlyExits: number; atomicBudgetDeferrals: number; usableJourneysFound: number; fallbackJourneysReturned: number; batchesAttempted: number;
}
export interface ValidationInput {
  source: string; destination: string; journeyDate: string; requestedClasses: string[]; quota?: 'GN'; mode?: SearchMode; plannerCandidates: readonly V2Journey[];
  /** Already-known authoritative metadata only; absence means unknown, not unsupported. */
  supportedClassesByTrain?: Readonly<Record<string, readonly string[]>>;
  plannerDiagnostics?: V2Result['diagnostics'];
}
export interface AllocationDiagnostics {
  breadthCandidatesConsidered: number; breadthCandidatesChecked: number; breadthRequests: number;
  completionCandidatesConsidered: number; completionCandidatesChecked: number; completionRequests: number;
  deepWideningCandidates: number; deepWideningRequests: number;
  candidatesDeferredByAtomicCost: number; candidatesDeferredByBreadthLimit: number;
}
export interface ValidationOptions { progressiveAllocation?: boolean; /** Evaluate other legs after a bottleneck, for journey recovery only. */ completeFailedCandidates?: boolean; budgetLimit?: number; usableTarget?: number; batchSizes?: number[]; classRounds?: TravelClass[][] }
export interface ValidationResult { journeys: ValidatedJourney[]; diagnostics: AvailabilityDiagnostics; allocationDiagnostics?: AllocationDiagnostics; plannerDiagnostics?: V2Result['diagnostics']; message: string }
