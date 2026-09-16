export interface Fare {
  baseFare?: number;
  reservationCharge?: number;
  superfastCharge?: number;
  serviceTax?: number;
  cateringCharge?: number;
  dynamicFare?: number;
  totalFare: number;
  currency: 'INR';
}
