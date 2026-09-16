import { DatabaseSync } from 'node:sqlite';
import { schema } from './schema.js';
import type { LocalDataset, LocalStation, LocalTrain, LocalTrainStop, RailwayDatasetMetadata } from './types.js';
export class RailwayDatabase {
  readonly db: DatabaseSync;
  constructor(path: string, readonly readOnly = false) {
    this.db = new DatabaseSync(path, { readOnly });
    try {
      const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      if (![1, 2].includes(version) && (readOnly || version !== 0)) throw new Error(`Unsupported local railway schema version ${version}; import/rebuild the dataset`);
      if (!readOnly) {
        if (version === 1) this.db.exec('BEGIN; ALTER TABLE train_stops ADD COLUMN arrival_day_offset INTEGER CHECK(arrival_day_offset >= 0); PRAGMA user_version=2; COMMIT;');
        this.db.exec(schema);
      }
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  replace(data: LocalDataset) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM train_stops; DELETE FROM trains; DELETE FROM stations; DELETE FROM dataset_metadata;');
      const station = this.db.prepare('INSERT INTO stations VALUES (?,?,?,?)');
      for (const s of data.stations) station.run(s.code, s.name, s.latitude ?? null, s.longitude ?? null);
      const train = this.db.prepare('INSERT INTO trains VALUES (?,?,?,?,?,?,?)');
      for (const t of data.trains) train.run(t.number, t.name, t.type ?? null, t.sourceCode, t.destinationCode, t.runningDaysRaw, JSON.stringify(t.runningDays));
      const stop = this.db.prepare('INSERT INTO train_stops (train_number,sequence,station_code,arrival_time,departure_time,day_offset,distance_km,arrival_day_offset) VALUES (?,?,?,?,?,?,?,?)');
      for (const s of data.stops) stop.run(s.trainNumber, s.sequence, s.stationCode, s.arrivalTime ?? null, s.departureTime ?? null, s.dayOffset, s.distanceKm ?? null, s.arrivalDayOffset ?? null);
      this.db.prepare('INSERT INTO dataset_metadata VALUES (1,?)').run(JSON.stringify(data.metadata));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  metadata(): RailwayDatasetMetadata {
    const row = this.db.prepare('SELECT json FROM dataset_metadata WHERE id=1').get();
    if (!row) throw new Error('No railway dataset imported');
    return JSON.parse(String(row.json));
  }
  station(code: string): LocalStation | undefined {
    return this.db.prepare('SELECT code,name,latitude,longitude FROM stations WHERE code=?').get(code) as unknown as LocalStation | undefined;
  }
  train(number: string): LocalTrain {
    const r = this.db.prepare('SELECT * FROM trains WHERE number=?').get(number)!;
    return { number: String(r.number), name: String(r.name), type: r.type === null ? undefined : String(r.type), sourceCode: String(r.source_code), destinationCode: String(r.destination_code), runningDaysRaw: String(r.running_days_raw), runningDays: JSON.parse(String(r.running_days_normalized)) };
  }
}
export function stopRow(r: Record<string, unknown>): LocalTrainStop {
  return { trainNumber: String(r.train_number), stationCode: String(r.station_code), sequence: Number(r.sequence), arrivalTime: r.arrival_time == null ? undefined : String(r.arrival_time), departureTime: r.departure_time == null ? undefined : String(r.departure_time), dayOffset: Number(r.day_offset), arrivalDayOffset: r.arrival_day_offset == null ? undefined : Number(r.arrival_day_offset), distanceKm: r.distance_km == null ? undefined : Number(r.distance_km) };
}
