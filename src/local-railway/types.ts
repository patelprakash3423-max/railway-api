export const weekdays = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
export type Weekday = typeof weekdays[number];
export type RunningDays = Weekday[];
export interface LocalStation { code: string; name: string; latitude?: number; longitude?: number }
export interface LocalTrain { number: string; name: string; type?: string; sourceCode: string; destinationCode: string; runningDaysRaw: string; runningDays: RunningDays }
export interface LocalTrainStop { trainNumber: string; stationCode: string; sequence: number; arrivalTime?: string; departureTime?: string; dayOffset: number; arrivalDayOffset?: number; distanceKm?: number }
export interface RailwayDatasetMetadata { source: 'RAILPULL_NTES'; importedAt: string; sourceGeneratedAt?: string; trainCount: number; stationCount: number; stopCount: number; label?: string; warnings?: string[]; excludedTrains?: { number: string; reason: string }[]; haltMismatchCount?: number; haltMismatchTrainCount?: number; excludedTrainCount?: number; excludedStopCount?: number }
export interface LocalDataset { stations: LocalStation[]; trains: LocalTrain[]; stops: LocalTrainStop[]; metadata: RailwayDatasetMetadata }
