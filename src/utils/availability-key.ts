import type {AvailabilityRequest} from '../domain/types/availability.js';

/** Canonical identity only; this does not relax provider/API input validation. */
export function availabilityRequestKey(request: AvailabilityRequest): string {
 const code=(value:string)=>value.trim().toUpperCase();
 const rawDate=request.journeyDate.trim();
 const iso=/^(\d{4})-(\d{2})-(\d{2})$/.exec(rawDate);
 const dmy=/^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(rawDate);
 let date=rawDate;
 if(iso||dmy){
  const [day,month,year]=iso?[Number(iso[3]),Number(iso[2]),Number(iso[1])]:dmy!.slice(1).map(Number);
  const parsed=new Date(Date.UTC(year,month-1,day));
  if(parsed.getUTCFullYear()===year&&parsed.getUTCMonth()===month-1&&parsed.getUTCDate()===day)
   date=`${String(day).padStart(2,'0')}-${String(month).padStart(2,'0')}-${year}`;
 }
 // Preserve leading zeroes: a train number is a code, not a numeric quantity.
 return JSON.stringify([request.trainNumber.trim(),code(request.fromStationCode),code(request.toStationCode),date,code(request.travelClass),code(request.quota)]);
}
