import type {JourneyV2Result,JourneyV2Status} from '../../api/services/journey-v2-model.js';
import type {JourneyBadge,JourneyPresentation,JourneyPresentationGroup,PresentationMetadata} from './types.js';
export type PresentedJourney = JourneyV2Result & {presentation:JourneyPresentation};
const tiers:Record<JourneyV2Status,number>={FULLY_RESERVED_USABLE:1,FULLY_RESERVED_WITH_SPLIT_CLASS:2,PARTIAL_RESERVED_RECOVERY:3,SCHEDULED_BUT_NOT_FULLY_AVAILABLE:4,INVENTORY_CHECK_INCOMPLETE:5};
const group=(status:JourneyV2Status):JourneyPresentationGroup=>tiers[status]<=2?'RECOMMENDED':tiers[status]===3?'RECOVERY':'OTHER';
const distance=(n:number)=>Number.isFinite(n)?Math.max(0,n):0;
export function journeySignature(j:JourneyV2Result):string {
 // JSON tuples preserve delimiters and structure without hashing collisions. Classes are excluded.
 return JSON.stringify([j.from,j.to,j.departureDateTime.slice(0,10),j.legs.map(l=>l.trainNumber),j.connections.map(c=>c.station)]);
}
export function inventoryQualityScore(j:JourneyV2Result):number {
 const weighted=j.legs.flatMap(l=>l.segments).reduce((n,s)=>n+(s.type==='RESERVED'?distance(s.distanceKm)*(s.availabilityStatus==='AVAILABLE'?1:s.availabilityStatus==='RAC'?.8:0):0),0);
 return j.totalDistanceKm>0?Math.min(1,weighted/j.totalDistanceKm):0;
}
function knownFare(j:JourneyV2Result):number|undefined {
 return j.totalFare.status==='COMPLETE'&&j.totalFare.amount!==null&&Number.isFinite(j.totalFare.amount)&&j.totalFare.amount>=0?j.totalFare.amount:undefined;
}
export function comparePresentation(a:PresentedJourney,b:PresentedJourney):number {
 const x=a.presentation,y=b.presentation;
 return tiers[a.status]-tiers[b.status] || b.reservedCoverageRatio-a.reservedCoverageRatio || y.inventoryQualityScore-x.inventoryQualityScore || x.selfManagedDistanceKm-y.selfManagedDistanceKm || a.trainChanges-b.trainChanges || a.classChanges-b.classChanges || a.totalDurationMinutes-b.totalDurationMinutes || x.connectionSafetyPenalty-y.connectionSafetyPenalty || a.totalDistanceKm-b.totalDistanceKm || compareFare(a,b) || x.engineRank-y.engineRank;
}
function compareFare(a:JourneyV2Result,b:JourneyV2Result):number {
 const x=knownFare(a),y=knownFare(b);
 return x===undefined?(y===undefined?0:1):y===undefined?-1:x-y;
}
export function presentJourneys(input:readonly JourneyV2Result[]):{results:PresentedJourney[];presentation:PresentationMetadata} {
 const results:PresentedJourney[]=input.map((j,i)=>{
  const signature=journeySignature(j);
  return {...j,presentation:{engineRank:i+1,displayRank:0,group:group(j.status),badges:[],inventoryQualityScore:inventoryQualityScore(j),selfManagedDistanceKm:j.legs.flatMap(l=>l.segments).reduce((n,s)=>n+(s.type==='SELF_MANAGED'?distance(s.distanceKm):0),0),
   // Preserve existing Planner V2 ranking semantics: GOOD=0, TIGHT=1, LONG=2.
   connectionSafetyPenalty:j.connections.reduce((n,c)=>n+({GOOD:0,TIGHT:1,LONG:2}[c.safety]),0),journeySignature:signature,variantGroupId:signature,isPrimaryVariant:false,alternateVariantCount:0,initiallyVisible:false}};
 }).sort(comparePresentation);
 const variants=new Map<string,PresentedJourney[]>();
 results.forEach((j,i)=>{j.presentation.displayRank=i+1;const key=j.presentation.variantGroupId;const items=variants.get(key)??[];items.push(j);variants.set(key,items);});
 const primaries=[...variants.values()].map(items=>{items[0].presentation.isPrimaryVariant=true;items[0].presentation.alternateVariantCount=items.length-1;return items[0];});
 const eligible=primaries.filter(j=>tiers[j.status]<=3);
 const best=results[0];
 if(best)best.presentation.badges.push(tiers[best.status]<=3?'BEST_OPTION':'BEST_SCHEDULED_OPTION');
 const award=(badge:JourneyBadge,pool:PresentedJourney[],compare:(a:PresentedJourney,b:PresentedJourney)=>number)=>{
  const winner=[...pool].sort((a,b)=>compare(a,b)||a.presentation.displayRank-b.presentation.displayRank)[0];
  if(winner)winner.presentation.badges.push(badge);
 };
 // Performance badges apply only to usable/recovery primary routes. Unchecked schedules get no implied ticket claims.
 award('FASTEST',eligible,(a,b)=>a.totalDurationMinutes-b.totalDurationMinutes);
 award('CHEAPEST',eligible.filter(j=>knownFare(j)!==undefined),(a,b)=>knownFare(a)!-knownFare(b)!);
 award('FEWEST_CHANGES',eligible,(a,b)=>a.trainChanges-b.trainChanges);
 award('MOST_RESERVED',eligible,(a,b)=>b.reservedCoverageRatio-a.reservedCoverageRatio||b.presentation.inventoryQualityScore-a.presentation.inventoryQualityScore);
 eligible.slice(0,5).forEach(j=>{j.presentation.initiallyVisible=true;});
 const count=(status:JourneyV2Status)=>primaries.filter(j=>j.status===status).length;
 return {results,presentation:{version:1,initialVisibleCount:5,groups:[{id:'RECOMMENDED',collapsedByDefault:false},{id:'RECOVERY',collapsedByDefault:false},{id:'OTHER',collapsedByDefault:true}],summary:{totalJourneys:results.length,primaryJourneys:primaries.length,fullyReserved:count('FULLY_RESERVED_USABLE'),fullSplitClass:count('FULLY_RESERVED_WITH_SPLIT_CLASS'),partialRecovery:count('PARTIAL_RESERVED_RECOVERY'),scheduledFallback:count('SCHEDULED_BUT_NOT_FULLY_AVAILABLE'),inventoryIncomplete:count('INVENTORY_CHECK_INCOMPLETE'),bestJourneyId:best?.id??null,hiddenAlternativeCount:results.length-eligible.slice(0,5).length}}};
}
