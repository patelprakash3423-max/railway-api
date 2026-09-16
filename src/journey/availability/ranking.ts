import type { TravelClass } from '../types/journey-segment.js';
const comfort: TravelClass[] = ['1A','EC','2A','3A','3E','CC','SL','2S'];
import type { InventoryCheck, ValidatedJourney } from './types.js';
import { usable } from './inventory.js';
const switches = (checks: InventoryCheck[]) => checks.reduce((n,c,i)=>n+Number(i>0&&c.travelClass!==checks[i-1].travelClass),0);
const compareChoices = (a: InventoryCheck[], b: InventoryCheck[]) =>
  a.filter(c=>c.status==='RAC').length-b.filter(c=>c.status==='RAC').length || switches(a)-switches(b) ||
  a.filter(c=>!c.fare).length-b.filter(c=>!c.fare).length || a.reduce((n,c)=>n+(c.fare?.totalFare??0),0)-b.reduce((n,c)=>n+(c.fare?.totalFare??0),0) ||
  a.map(c=>comfort.indexOf(c.travelClass)).join(',').localeCompare(b.map(c=>comfort.indexOf(c.travelClass)).join(','));
/** Dynamic programming: at most one optimal prefix per last class (<=8 states).
 * Future class-change costs depend only on the previous class. */
export function chooseClasses(legs: InventoryCheck[][]): InventoryCheck[] | undefined {
  let states: InventoryCheck[][] = [[]];
  for (const checks of legs) {
    const next = new Map<string, InventoryCheck[]>();
    for (const prefix of states) for (const c of checks.filter(usable)) { const path=[...prefix,c], previous=next.get(c.travelClass); if(!previous||compareChoices(path,previous)<0)next.set(c.travelClass,path); }
    states=[...next.values()];if(!states.length)return undefined;
  }
  return states.sort(compareChoices)[0];
}
export function rankValidated(a: ValidatedJourney,b: ValidatedJourney): number {
  const status = { FULLY_RESERVED_USABLE: 0, SCHEDULED_BUT_NOT_FULLY_AVAILABLE: 1, INVENTORY_CHECK_INCOMPLETE: 2 };
  const safety = (j: ValidatedJourney) => j.scheduleCandidate.connections.filter(c=>c.safety!=='GOOD').length;
  // Among usable journeys fewer RAC legs wins; avoids rewarding gratuitous extra
  // AVAILABLE legs. Schedule rank breaks ties after inventory/travel quality.
  return status[a.status]-status[b.status] || (a.status==='FULLY_RESERVED_USABLE' ? a.racLegCount-b.racLegCount : 0) ||
    a.trainChanges-b.trainChanges || a.classChanges-b.classChanges || a.totalDurationMinutes-b.totalDurationMinutes || a.totalDistanceKm-b.totalDistanceKm || safety(a)-safety(b) ||
    Number(a.totalFare.amount===null)-Number(b.totalFare.amount===null) || (a.totalFare.amount??0)-(b.totalFare.amount??0) || a.legs.reduce((n,l)=>n+(l.selectedClass?comfort.indexOf(l.selectedClass):8),0)-b.legs.reduce((n,l)=>n+(l.selectedClass?comfort.indexOf(l.selectedClass):8),0) || a.scheduleRank-b.scheduleRank || a.scheduleCandidateId.localeCompare(b.scheduleCandidateId);
}
export { switches as classChanges };
