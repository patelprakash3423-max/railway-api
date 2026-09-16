export const schema = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS stations(code TEXT PRIMARY KEY, name TEXT NOT NULL, latitude REAL, longitude REAL);
CREATE TABLE IF NOT EXISTS trains(number TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT,
 source_code TEXT NOT NULL REFERENCES stations(code), destination_code TEXT NOT NULL REFERENCES stations(code),
 running_days_raw TEXT NOT NULL, running_days_normalized TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS train_stops(train_number TEXT NOT NULL REFERENCES trains(number),
 sequence INTEGER NOT NULL CHECK(sequence >= 0), station_code TEXT NOT NULL REFERENCES stations(code),
 arrival_time TEXT, departure_time TEXT, day_offset INTEGER NOT NULL CHECK(day_offset >= 0), distance_km REAL, arrival_day_offset INTEGER CHECK(arrival_day_offset >= 0),
 PRIMARY KEY(train_number, sequence));
CREATE INDEX IF NOT EXISTS stops_station_train_sequence ON train_stops(station_code, train_number, sequence);
CREATE TABLE IF NOT EXISTS dataset_metadata(id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
PRAGMA user_version = 2;
`;
