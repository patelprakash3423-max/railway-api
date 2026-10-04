import type {JourneyV2ApiService} from '../api/services/journey-v2-service.js';
/** Inventory regressions explicitly discover and then select one route. */
export async function checkFirstRoute(service:Pick<JourneyV2ApiService,'search'|'checkAvailability'>,input:unknown,requestId?:string){
 const discovery=await service.search(input,requestId);
 return service.checkAvailability({...input as object,routeId:discovery.results[0]?.id},requestId);
}
