export type JourneyPresentationGroup = 'RECOMMENDED'|'RECOVERY'|'OTHER';
export type JourneyBadge = 'BEST_OPTION'|'BEST_SCHEDULED_OPTION'|'FASTEST'|'CHEAPEST'|'FEWEST_CHANGES'|'MOST_RESERVED';
export interface JourneyPresentation {
 engineRank:number; displayRank:number; group:JourneyPresentationGroup; badges:JourneyBadge[];
 inventoryQualityScore:number; selfManagedDistanceKm:number; connectionSafetyPenalty:number;
 journeySignature:string; variantGroupId:string; isPrimaryVariant:boolean; alternateVariantCount:number;
 initiallyVisible:boolean;
}
export interface PresentationMetadata {
 version:1; initialVisibleCount:5;
 groups:{id:JourneyPresentationGroup;collapsedByDefault:boolean}[];
 summary:{totalJourneys:number;primaryJourneys:number;fullyReserved:number;fullSplitClass:number;partialRecovery:number;scheduledFallback:number;inventoryIncomplete:number;bestJourneyId:string|null;hiddenAlternativeCount:number};
}
