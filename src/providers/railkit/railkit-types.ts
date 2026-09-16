// Minimal observed SDK payloads. Runtime normalizers still accept unknown and validate.
type Numeric = string | number;
export interface RailKitStop {
  stnCode: string; stnName: string;
  arrival?: string; departure?: string;
  halt?: string; haltMinutes?: Numeric;
  distance: Numeric; day: Numeric;
  platform?: string | number | null;
  coordinates?: { latitude: Numeric; longitude: Numeric };
}
export interface RailKitTrainInfoResponse {
  success: boolean;
  error?: string;
  data?: {
    trainInfo: {
      train_no: string; train_name: string;
      from_stn_code: string; from_stn_name: string;
      to_stn_code: string; to_stn_name: string;
      from_time?: string; to_time?: string;
      travel_time?: string; type?: string; running_days?: string | number;
    };
    route: RailKitStop[];
  };
}
export interface RailKitAvailabilityResponse {
  success: boolean;
  error?: string;
  data?: {
    train?: {
      trainNo?: string; trainName?: string; from?: string; to?: string;
      fromStationName?: string; toStationName?: string;
      distance?: Numeric; travelClass?: string; quota?: string;
    };
    fare?: {
      baseFare?: Numeric; reservationCharge?: Numeric; superfastCharge?: Numeric;
      serviceTax?: Numeric; totalFare: Numeric;
    };
    availability: {
      date: string; status: string; availabilityText?: string; rawStatus?: string;
      prediction?: string; predictionPercentage?: number; canBook?: boolean;
    }[];
  };
}

// Fields observed in the user-supplied live discovery response.
export interface RailKitTrainSearchResponse {
  success: boolean;
  error?: string;
  data?: Array<{
    train_no: string; train_name: string;
    source_stn_code?: string; source_stn_name?: string;
    dstn_stn_code?: string; dstn_stn_name?: string;
    from_stn_code: string; to_stn_code: string;
    from_stn_name?: string; to_stn_name?: string;
    halts?: number;
    from_time?: string; to_time?: string;
    travel_time?: string; running_days?: string; distance?: string | number;
  }>;
}
