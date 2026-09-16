import type { RailwayProvider } from '../providers/railway-provider.js';
import type { AvailabilityRequest, AvailabilityResult } from '../domain/types/availability.js';
/** Explicit offline demo inventory, never a prediction of actual seats. */
export class DeterministicAvailabilityProvider implements RailwayProvider {
  readonly calls: AvailabilityRequest[]=[];
  discoveryCalls=0;infoCalls=0;
  async searchTrainsBetweenStations(): Promise<never> {this.discoveryCalls++;throw new Error('Discovery forbidden in V2 inventory validation');}
  async getTrainInfo(): Promise<never> {this.infoCalls++;throw new Error('Train info forbidden in V2 inventory validation');}
  async getAvailability(request: AvailabilityRequest): Promise<AvailabilityResult> {
    this.calls.push({...request});const hash=[...request.trainNumber].reduce((n,c)=>n+Number(c),0),preferred=hash%2?'3A':'SL';
    const state=request.travelClass===preferred?(hash%5===0?'RAC':'AVAILABLE'):'WAITLIST';
    return {request:{...request},provider:'railkit',providerState:'SUCCESS',days:[{date:request.journeyDate,state,availabilityText:`FAKE ${state}`}],fare:{currency:'INR',totalFare:100+hash*10}};
  }
}
