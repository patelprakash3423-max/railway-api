import { RailwayDatabase, stopRow } from './database.js';
/** Indexed station membership followed by train/sequence lookups. No network-wide stop scan. */
export const membershipSql = 'SELECT * FROM train_stops WHERE station_code=? AND departure_time IS NOT NULL ORDER BY train_number,sequence LIMIT ?';
export const pairSql = `SELECT a.* FROM train_stops a WHERE a.station_code=? AND a.departure_time IS NOT NULL
 AND EXISTS (SELECT 1 FROM train_stops b WHERE b.station_code=? AND b.train_number=a.train_number AND b.sequence>a.sequence AND b.arrival_time IS NOT NULL)
 ORDER BY a.train_number,a.sequence LIMIT ?`;
export class TimetableIndexes {
  rowsRead = 0;
  constructor(private readonly database: RailwayDatabase) {}
  private read(sql: string, args: (string | number)[]) { const rows = this.database.db.prepare(sql).all(...args); this.rowsRead += rows.length; return rows.map(stopRow); }
  departures(station: string, limit: number, destination?: string) { return destination ? this.read(pairSql, [station, destination, limit]) : this.read(membershipSql, [station, limit]); }
  onward(train: string, sequence: number, limit: number, destination?: string) {
    return destination ? this.read('SELECT * FROM train_stops WHERE train_number=? AND sequence>? AND station_code=? AND arrival_time IS NOT NULL ORDER BY sequence LIMIT ?', [train, sequence, destination, limit]) : this.read('SELECT * FROM train_stops WHERE train_number=? AND sequence>? AND arrival_time IS NOT NULL ORDER BY sequence LIMIT ?', [train, sequence, limit]);
  }
  traversed(train: string, fromSequence: number, toSequence: number) { return this.read('SELECT * FROM train_stops WHERE train_number=? AND sequence>? AND sequence<=? ORDER BY sequence', [train, fromSequence, toSequence]); }
}
