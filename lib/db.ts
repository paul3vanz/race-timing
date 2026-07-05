import * as Crypto from 'expo-crypto';
import * as SQLite from 'expo-sqlite';

// ── Row types ─────────────────────────────────────────────────────────────────

export interface Event {
  id: string;
  name: string;
  date: string; // ISO8601
  location: string | null;
  status: 'pending' | 'active' | 'finished';
}

export interface Race {
  id: string;
  event_id: string;
  name: string;
  start_time: number | null; // Unix ms
  wave: number;
  max_bib: number; // highest expected bib number — drives auto-submit digit count
}

export interface Participant {
  id: string;
  race_id: string;
  bib_number: string; // TEXT — leading zeros and alphanumeric bibs exist
  name: string | null;
  category: string | null;
  gender: string | null;
  dob: string | null;
}

export interface Timestamp {
  id: string;
  race_id: string;
  recorded_at: number; // Unix ms, Date.now() at moment of tap
  device_id: string;
  sequence_num: number; // order within this race on this device
  synced: 0 | 1;
}

export interface Finish {
  id: string;
  race_id: string;
  bib_number: string;
  timestamp_id: string | null;
  gun_time: number | null; // ms since race start_time
  chip_time: number | null;
  synced: 0 | 1;
}

// ── Migrations ────────────────────────────────────────────────────────────────

// Add new entries to extend the schema; never edit existing ones.
const MIGRATIONS: string[] = [
  // v1 — initial schema
  `
  CREATE TABLE IF NOT EXISTS events (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    date      TEXT NOT NULL,
    location  TEXT,
    status    TEXT NOT NULL DEFAULT 'pending'
  );

  CREATE TABLE IF NOT EXISTS races (
    id          TEXT PRIMARY KEY,
    event_id    TEXT NOT NULL REFERENCES events(id),
    name        TEXT NOT NULL,
    start_time  INTEGER,
    wave        INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS participants (
    id          TEXT PRIMARY KEY,
    race_id     TEXT NOT NULL REFERENCES races(id),
    bib_number  TEXT NOT NULL,
    name        TEXT,
    category    TEXT,
    gender      TEXT,
    dob         TEXT
  );

  CREATE TABLE IF NOT EXISTS timestamps (
    id           TEXT PRIMARY KEY,
    race_id      TEXT NOT NULL REFERENCES races(id),
    recorded_at  INTEGER NOT NULL,
    device_id    TEXT NOT NULL,
    sequence_num INTEGER NOT NULL,
    synced       INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS finishes (
    id           TEXT PRIMARY KEY,
    race_id      TEXT NOT NULL REFERENCES races(id),
    bib_number   TEXT NOT NULL,
    timestamp_id TEXT REFERENCES timestamps(id),
    gun_time     INTEGER,
    chip_time    INTEGER,
    synced       INTEGER NOT NULL DEFAULT 0
  );
  `,

  // v2 — max_bib on races (drives auto-submit digit count on bib entry screen)
  `ALTER TABLE races ADD COLUMN max_bib INTEGER NOT NULL DEFAULT 999;`,
];

export async function migrateDbIfNeeded(db: SQLite.SQLiteDatabase): Promise<void> {
  const result = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  let version = result?.user_version ?? 0;

  for (; version < MIGRATIONS.length; version++) {
    await db.execAsync(MIGRATIONS[version]);
    await db.execAsync(`PRAGMA user_version = ${version + 1}`);
  }

  // Self-heal against schema drift: on web, a Metro Fast Refresh can swap in
  // a database file whose migration got interrupted mid-way (see
  // patches/AccessHandlePoolVFS.js), leaving user_version ahead of the
  // columns that actually exist. Verify rather than trust the counter.
  await ensureColumn(db, 'races', 'max_bib', 'INTEGER NOT NULL DEFAULT 999');
}

async function ensureColumn(
  db: SQLite.SQLiteDatabase,
  table: string,
  column: string,
  definition: string,
): Promise<void> {
  const columns = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
  if (!columns.some((c) => c.name === column)) {
    await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

// ── Internal ──────────────────────────────────────────────────────────────────

function uuid(): string {
  return Crypto.randomUUID();
}

// ── Events ────────────────────────────────────────────────────────────────────

export async function getEvents(db: SQLite.SQLiteDatabase): Promise<Event[]> {
  return db.getAllAsync<Event>('SELECT * FROM events ORDER BY date DESC, name');
}

export async function getEvent(db: SQLite.SQLiteDatabase, id: string): Promise<Event | null> {
  return db.getFirstAsync<Event>('SELECT * FROM events WHERE id = ?', [id]);
}

export async function createEvent(
  db: SQLite.SQLiteDatabase,
  data: Omit<Event, 'id'>,
): Promise<Event> {
  const id = uuid();
  await db.runAsync(
    'INSERT INTO events (id, name, date, location, status) VALUES (?, ?, ?, ?, ?)',
    [id, data.name, data.date, data.location ?? null, data.status],
  );
  return { id, ...data };
}

export async function updateEventStatus(
  db: SQLite.SQLiteDatabase,
  id: string,
  status: Event['status'],
): Promise<void> {
  await db.runAsync('UPDATE events SET status = ? WHERE id = ?', [status, id]);
}

// ── Races ─────────────────────────────────────────────────────────────────────

export async function getRacesByEvent(
  db: SQLite.SQLiteDatabase,
  eventId: string,
): Promise<Race[]> {
  return db.getAllAsync<Race>(
    'SELECT * FROM races WHERE event_id = ? ORDER BY wave, name',
    [eventId],
  );
}

export async function getRace(db: SQLite.SQLiteDatabase, id: string): Promise<Race | null> {
  return db.getFirstAsync<Race>('SELECT * FROM races WHERE id = ?', [id]);
}

export async function createRace(
  db: SQLite.SQLiteDatabase,
  data: Omit<Race, 'id'>,
): Promise<Race> {
  const id = uuid();
  await db.runAsync(
    'INSERT INTO races (id, event_id, name, start_time, wave, max_bib) VALUES (?, ?, ?, ?, ?, ?)',
    [id, data.event_id, data.name, data.start_time ?? null, data.wave, data.max_bib],
  );
  return { id, ...data };
}

export async function setRaceStartTime(
  db: SQLite.SQLiteDatabase,
  raceId: string,
  startTime: number,
): Promise<void> {
  await db.runAsync('UPDATE races SET start_time = ? WHERE id = ?', [startTime, raceId]);
}

export async function deleteRace(db: SQLite.SQLiteDatabase, raceId: string): Promise<void> {
  const race = await getRace(db, raceId);
  if (!race) return;

  await db.runAsync(
    'DELETE FROM finishes WHERE race_id = ?',
    [raceId],
  );
  await db.runAsync('DELETE FROM timestamps WHERE race_id = ?', [raceId]);
  await db.runAsync('DELETE FROM participants WHERE race_id = ?', [raceId]);
  await db.runAsync('DELETE FROM races WHERE id = ?', [raceId]);

  // Each race currently has its own dedicated event — clean it up once orphaned.
  const remaining = await db.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM races WHERE event_id = ?',
    [race.event_id],
  );
  if ((remaining?.count ?? 0) === 0) {
    await db.runAsync('DELETE FROM events WHERE id = ?', [race.event_id]);
  }
}

// ── Participants ──────────────────────────────────────────────────────────────

export async function getParticipantsByRace(
  db: SQLite.SQLiteDatabase,
  raceId: string,
): Promise<Participant[]> {
  return db.getAllAsync<Participant>(
    'SELECT * FROM participants WHERE race_id = ? ORDER BY CAST(bib_number AS INTEGER), bib_number',
    [raceId],
  );
}

export async function upsertParticipant(
  db: SQLite.SQLiteDatabase,
  data: Omit<Participant, 'id'>,
): Promise<Participant> {
  const existing = await db.getFirstAsync<Participant>(
    'SELECT * FROM participants WHERE race_id = ? AND bib_number = ?',
    [data.race_id, data.bib_number],
  );
  if (existing) {
    await db.runAsync(
      'UPDATE participants SET name = ?, category = ?, gender = ?, dob = ? WHERE id = ?',
      [data.name ?? null, data.category ?? null, data.gender ?? null, data.dob ?? null, existing.id],
    );
    return { ...existing, ...data };
  }
  const id = uuid();
  await db.runAsync(
    'INSERT INTO participants (id, race_id, bib_number, name, category, gender, dob) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, data.race_id, data.bib_number, data.name ?? null, data.category ?? null, data.gender ?? null, data.dob ?? null],
  );
  return { id, ...data };
}

// ── Timestamps ────────────────────────────────────────────────────────────────

export async function getTimestampsByRace(
  db: SQLite.SQLiteDatabase,
  raceId: string,
): Promise<Timestamp[]> {
  return db.getAllAsync<Timestamp>(
    'SELECT * FROM timestamps WHERE race_id = ? ORDER BY sequence_num',
    [raceId],
  );
}

export async function getUnassignedTimestamps(
  db: SQLite.SQLiteDatabase,
  raceId: string,
): Promise<Timestamp[]> {
  // Timestamps that have no matching finish record yet
  return db.getAllAsync<Timestamp>(
    `SELECT t.*
     FROM timestamps t
     LEFT JOIN finishes f ON f.timestamp_id = t.id
     WHERE t.race_id = ? AND f.id IS NULL
     ORDER BY t.sequence_num`,
    [raceId],
  );
}

export async function recordTimestamp(
  db: SQLite.SQLiteDatabase,
  raceId: string,
  deviceId: string,
  recordedAt: number,
): Promise<Timestamp> {
  const result = await db.getFirstAsync<{ max_seq: number | null }>(
    'SELECT MAX(sequence_num) AS max_seq FROM timestamps WHERE race_id = ? AND device_id = ?',
    [raceId, deviceId],
  );
  const sequence_num = (result?.max_seq ?? 0) + 1;
  const id = uuid();
  await db.runAsync(
    'INSERT INTO timestamps (id, race_id, recorded_at, device_id, sequence_num) VALUES (?, ?, ?, ?, ?)',
    [id, raceId, recordedAt, deviceId, sequence_num],
  );
  return { id, race_id: raceId, recorded_at: recordedAt, device_id: deviceId, sequence_num, synced: 0 };
}

export async function getUnsyncedTimestamps(db: SQLite.SQLiteDatabase): Promise<Timestamp[]> {
  return db.getAllAsync<Timestamp>(
    'SELECT * FROM timestamps WHERE synced = 0 ORDER BY race_id, sequence_num',
  );
}

export async function markTimestampSynced(
  db: SQLite.SQLiteDatabase,
  id: string,
): Promise<void> {
  await db.runAsync('UPDATE timestamps SET synced = 1 WHERE id = ?', [id]);
}

// ── Review ────────────────────────────────────────────────────────────────────

export interface ReviewRow {
  timestamp_id: string;
  sequence_num: number;
  recorded_at: number;
  finish_id: string | null;
  bib_number: string | null;
  gun_time: number | null;
}

export async function getReviewRows(
  db: SQLite.SQLiteDatabase,
  raceId: string,
): Promise<ReviewRow[]> {
  return db.getAllAsync<ReviewRow>(
    `SELECT
       t.id         AS timestamp_id,
       t.sequence_num,
       t.recorded_at,
       f.id         AS finish_id,
       f.bib_number,
       f.gun_time
     FROM timestamps t
     LEFT JOIN finishes f ON f.timestamp_id = t.id
     WHERE t.race_id = ?
     ORDER BY t.sequence_num`,
    [raceId],
  );
}

// ── Finishes ──────────────────────────────────────────────────────────────────

export async function getFinishesByRace(
  db: SQLite.SQLiteDatabase,
  raceId: string,
): Promise<Finish[]> {
  return db.getAllAsync<Finish>(
    'SELECT * FROM finishes WHERE race_id = ? ORDER BY gun_time',
    [raceId],
  );
}

export async function assignBibToTimestamp(
  db: SQLite.SQLiteDatabase,
  raceId: string,
  bibNumber: string,
  timestamp: Timestamp,
  raceStartTime: number,
): Promise<Finish> {
  const id = uuid();
  const gun_time = timestamp.recorded_at - raceStartTime;
  await db.runAsync(
    'INSERT INTO finishes (id, race_id, bib_number, timestamp_id, gun_time) VALUES (?, ?, ?, ?, ?)',
    [id, raceId, bibNumber, timestamp.id, gun_time],
  );
  return { id, race_id: raceId, bib_number: bibNumber, timestamp_id: timestamp.id, gun_time, chip_time: null, synced: 0 };
}

export async function recordDirectFinish(
  db: SQLite.SQLiteDatabase,
  raceId: string,
  bibNumber: string,
  gunTime: number,
): Promise<Finish> {
  const id = uuid();
  await db.runAsync(
    'INSERT INTO finishes (id, race_id, bib_number, timestamp_id, gun_time) VALUES (?, ?, ?, NULL, ?)',
    [id, raceId, bibNumber, gunTime],
  );
  return { id, race_id: raceId, bib_number: bibNumber, timestamp_id: null, gun_time: gunTime, chip_time: null, synced: 0 };
}

export async function getFinishByBib(
  db: SQLite.SQLiteDatabase,
  raceId: string,
  bibNumber: string,
): Promise<Finish | null> {
  return db.getFirstAsync<Finish>(
    'SELECT * FROM finishes WHERE race_id = ? AND bib_number = ?',
    [raceId, bibNumber],
  );
}

export async function getUnsyncedFinishes(db: SQLite.SQLiteDatabase): Promise<Finish[]> {
  return db.getAllAsync<Finish>(
    'SELECT * FROM finishes WHERE synced = 0 ORDER BY race_id, gun_time',
  );
}

export async function markFinishSynced(db: SQLite.SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync('UPDATE finishes SET synced = 1 WHERE id = ?', [id]);
}
