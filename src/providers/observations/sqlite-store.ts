import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,realpathSync,existsSync,statSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import type {AvailabilityStateConfig} from '../../config/availability-state.js';
import {availabilityStateConfig} from '../../config/availability-state.js';
import {canonicalAvailabilityIdentity,journeyMidnight,observationKey,validateObservation,type AvailabilityIdentity,type AvailabilityObservation,type AvailabilityObservationStore} from './model.js';
const applicationId=0x41564f42;
/** Separate mutable state; lazy opening failures are handled by the cache facade. */
export class SqliteAvailabilityObservationStore implements AvailabilityObservationStore {
 private database?:DatabaseSync;
 private closed=false;
 private lastCleanup=0;
 constructor(private readonly config:AvailabilityStateConfig=availabilityStateConfig(),private readonly now=Date.now,private readonly timetablePath=process.env.LOCAL_RAILWAY_DB_PATH??'data/local-railway/railway.sqlite'){}
 private connection():DatabaseSync {
  if(this.closed)throw Error('Observation store closed');if(this.database)return this.database;
  const path=this.config.path;
  if(path!==':memory:'){
   const target=resolve(path),timetable=resolve(this.timetablePath);
   const samePath=process.platform==='win32'?target.toLowerCase()===timetable.toLowerCase():target===timetable;
   if(samePath)throw Error('Observation database must be separate from timetable');
   if(existsSync(target)&&existsSync(timetable)){
    const a=statSync(target),b=statSync(timetable);
    if(realpathSync(target)===realpathSync(timetable)||(a.dev===b.dev&&a.ino===b.ino))throw Error('Observation database aliases timetable');
   }
   mkdirSync(dirname(target),{recursive:true});
  }
  const db=new DatabaseSync(path);
  try{
   const version=Number(db.prepare('PRAGMA user_version').get()!.user_version),app=Number(db.prepare('PRAGMA application_id').get()!.application_id);
   const tables=Number(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get()!.n);
   if(!((version===0&&app===0&&tables===0)||(version===1&&app===applicationId)))throw Error('Invalid availability state schema');
   db.exec('PRAGMA busy_timeout='+this.config.busyTimeoutMs);
   if(version===0){
    db.exec('BEGIN IMMEDIATE');
    try{
     db.exec(`CREATE TABLE availability_latest (
      identity_key TEXT PRIMARY KEY,namespace TEXT NOT NULL,train_number TEXT NOT NULL,from_station TEXT NOT NULL,to_station TEXT NOT NULL,
      journey_date TEXT NOT NULL,class_code TEXT NOT NULL,quota TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('AVAILABLE','RAC','WAITLIST','NOT_AVAILABLE')),
      observed_at INTEGER NOT NULL,journey_end INTEGER NOT NULL,evidence_json TEXT NOT NULL CHECK(length(evidence_json)<=8192),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE INDEX availability_latest_age ON availability_latest(observed_at,identity_key);
      CREATE INDEX availability_latest_journey ON availability_latest(journey_end);
      PRAGMA user_version=1; PRAGMA application_id=`+applicationId+'; COMMIT;');
    }catch(error){db.exec('ROLLBACK');throw error;}
   }
   db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=100; PRAGMA journal_size_limit=1048576; PRAGMA max_page_count=65536;');
   this.database=db;return db;
  }catch(error){db.close();throw error;}
 }
 getLatest(value:AvailabilityIdentity):AvailabilityObservation|undefined {
  const identity=canonicalAvailabilityIdentity(value),key=observationKey(identity);
  const row=this.connection().prepare('SELECT * FROM availability_latest WHERE identity_key=?').get(key);
  if(!row)return undefined;
  if(typeof row.evidence_json!=='string'||row.evidence_json.length>8192)throw Error('Invalid observation row');
  const observation=validateObservation(JSON.parse(row.evidence_json),identity);
  const pairs={namespace:observation.namespace,train_number:identity.trainNumber,from_station:identity.fromStationCode,to_station:identity.toStationCode,journey_date:identity.journeyDate,class_code:identity.travelClass,quota:identity.quota,status:observation.result.days[0].state,observed_at:observation.observedAt,journey_end:journeyMidnight(identity.journeyDate)+86400000};
  if(Object.entries(pairs).some(([k,v])=>row[k]!==v))throw Error('Conflicting observation columns');
  return observation;
 }
 upsertLatest(value:AvailabilityObservation):void {
  const observation=validateObservation(value),r=observation.identity,time=this.now();
  if(observation.observedAt>time)throw Error('Future observation');
  if(journeyMidnight(r.journeyDate)+86400000<=time||observation.observedAt<time-this.config.retentionMs)return;
  const json=JSON.stringify(observation);if(json.length>8192)throw Error('Observation exceeds storage bound');
  const db=this.connection();db.exec('BEGIN IMMEDIATE');
  try{
   db.prepare(`INSERT INTO availability_latest VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(identity_key) DO UPDATE SET status=excluded.status,observed_at=excluded.observed_at,evidence_json=excluded.evidence_json,updated_at=excluded.updated_at
    WHERE excluded.observed_at>availability_latest.observed_at`).run(observationKey(r),observation.namespace,r.trainNumber,r.fromStationCode,r.toStationCode,r.journeyDate,r.travelClass,r.quota,observation.result.days[0].state,observation.observedAt,journeyMidnight(r.journeyDate)+86400000,json,time,time);
   // Hard row bound applies on every write; equal timestamps keep the existing row.
   db.prepare('DELETE FROM availability_latest WHERE identity_key IN (SELECT identity_key FROM availability_latest ORDER BY observed_at DESC,identity_key DESC LIMIT -1 OFFSET ?)').run(this.config.maxRows);
   db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  if(time-this.lastCleanup>=60000){this.cleanup(time);this.lastCleanup=time;}
 }
 cleanup(now:number):number {
  if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid cleanup time');
  return Number(this.connection().prepare('DELETE FROM availability_latest WHERE journey_end<=? OR observed_at<?').run(now,now-this.config.retentionMs).changes);
 }
 close(){this.closed=true;this.database?.close();this.database=undefined;}
}
