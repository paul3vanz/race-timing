import * as Crypto from 'expo-crypto';
import * as SQLite from 'expo-sqlite';

// ── Row types ─────────────────────────────────────────────────────────────────

export interface Event {
  id: string;
  name: string;
  date: string; // ISO8601
  location: string | null;
  status: 'pending' | 'active' | 'finished';
  synced: 0 | 1;
}

export interface Race {
  id: string;
  event_id: string;
  name: string;
  start_time: number | null; // Unix ms
  wave: number;
  max_bib: number; // highest expected bib number — drives auto-submit digit count
  synced: 0 | 1;
}

export interface Participant {
  id: string;
  race_id: string;
  bib_number: string; // TEXT — leading zeros and alphanumeric bibs exist
  first_name: string | null;
  last_name: string | null;
  gender: string | null;
  dob: string | null;
  club: string | null;
  category: string | null;
  team_name: string | null; // set for team entries — one row per team, sharing a bib
  sub_category: string | null; // e.g. solo/pair/team — bibs are allocated and results grouped per value
  synced: 0 | 1;
}

// Team entries share one bib_number/team_name row instead of first/last name.
export function participantDisplayName(
  p: Pick<Participant, 'first_name' | 'last_name' | 'team_name'>,
): string {
  return p.team_name ?? ([p.first_name, p.last_name].filter(Boolean).join(' ') || '—');
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

  // v3 — synced flag on events/races/participants (timestamps/finishes already
  // had one). Lets the Supabase sync worker push only rows that changed
  // locally instead of re-uploading the whole race every cycle.
  `
  ALTER TABLE events ADD COLUMN synced INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE races ADD COLUMN synced INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE participants ADD COLUMN synced INTEGER NOT NULL DEFAULT 0;
  `,

  // v4 — team entries. Some participants are a team sharing a single bib
  // (one row per team, timed as one entry) rather than an individual, so
  // every personal field has to become optional. Splits the old combined
  // `name` into first_name/last_name and adds club + team_name. The old
  // `name` column is dropped outright (not left orphaned) — every read here
  // uses `SELECT *`, so a leftover column would silently ride along in every
  // row object and get pushed to Supabase, which no longer has that column.
  // "At least a name or a team" is enforced in application code (see
  // upsertParticipant), not a DB constraint — SQLite can't add a multi-column
  // CHECK to an existing table without a full rebuild.
  `
  ALTER TABLE participants ADD COLUMN first_name TEXT;
  ALTER TABLE participants ADD COLUMN last_name TEXT;
  ALTER TABLE participants ADD COLUMN club TEXT;
  ALTER TABLE participants ADD COLUMN team_name TEXT;
  UPDATE participants SET last_name = name WHERE name IS NOT NULL AND last_name IS NULL;
  ALTER TABLE participants DROP COLUMN name;
  `,

  // v5 — sub-category (e.g. solo/pair/team for a multi-lap event). Bibs are
  // allocated per sub-category block and results are grouped by it, so it
  // needs to travel with the participant rather than being inferred from
  // team_name (a solo entrant still has a name, not a team).
  `ALTER TABLE participants ADD COLUMN sub_category TEXT;`,
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
  await ensureColumn(db, 'events', 'synced', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(db, 'races', 'synced', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(db, 'participants', 'synced', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(db, 'participants', 'first_name', 'TEXT');
  await ensureColumn(db, 'participants', 'last_name', 'TEXT');
  await ensureColumn(db, 'participants', 'club', 'TEXT');
  await ensureColumn(db, 'participants', 'team_name', 'TEXT');
  await ensureColumn(db, 'participants', 'sub_category', 'TEXT');
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
  data: Omit<Event, 'id' | 'synced'>,
): Promise<Event> {
  const id = uuid();
  await db.runAsync(
    'INSERT INTO events (id, name, date, location, status) VALUES (?, ?, ?, ?, ?)',
    [id, data.name, data.date, data.location ?? null, data.status],
  );
  return { id, ...data, synced: 0 };
}

export async function updateEventStatus(
  db: SQLite.SQLiteDatabase,
  id: string,
  status: Event['status'],
): Promise<void> {
  await db.runAsync('UPDATE events SET status = ?, synced = 0 WHERE id = ?', [status, id]);
}

export async function getUnsyncedEvents(db: SQLite.SQLiteDatabase): Promise<Event[]> {
  return db.getAllAsync<Event>('SELECT * FROM events WHERE synced = 0');
}

export async function markEventSynced(db: SQLite.SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync('UPDATE events SET synced = 1 WHERE id = ?', [id]);
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
  data: Omit<Race, 'id' | 'synced'>,
): Promise<Race> {
  const id = uuid();
  await db.runAsync(
    'INSERT INTO races (id, event_id, name, start_time, wave, max_bib) VALUES (?, ?, ?, ?, ?, ?)',
    [id, data.event_id, data.name, data.start_time ?? null, data.wave, data.max_bib],
  );
  return { id, ...data, synced: 0 };
}

export async function setRaceStartTime(
  db: SQLite.SQLiteDatabase,
  raceId: string,
  startTime: number,
): Promise<void> {
  await db.runAsync('UPDATE races SET start_time = ?, synced = 0 WHERE id = ?', [startTime, raceId]);
}

export async function setRaceMaxBib(
  db: SQLite.SQLiteDatabase,
  raceId: string,
  maxBib: number,
): Promise<void> {
  await db.runAsync('UPDATE races SET max_bib = ?, synced = 0 WHERE id = ?', [maxBib, raceId]);
}

export async function getUnsyncedRaces(db: SQLite.SQLiteDatabase): Promise<Race[]> {
  return db.getAllAsync<Race>('SELECT * FROM races WHERE synced = 0');
}

export async function markRaceSynced(db: SQLite.SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync('UPDATE races SET synced = 1 WHERE id = ?', [id]);
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

// A participant is either an individual (first/last name) or a team entry
// sharing one bib (team_name only) — one of the two identities is required.
function hasParticipantIdentity(
  data: Pick<Participant, 'first_name' | 'last_name' | 'team_name'>,
): boolean {
  return Boolean(data.first_name || data.last_name || data.team_name);
}

export async function upsertParticipant(
  db: SQLite.SQLiteDatabase,
  data: Omit<Participant, 'id' | 'synced'>,
): Promise<Participant> {
  if (!hasParticipantIdentity(data)) {
    throw new Error(`Bib ${data.bib_number} needs a first/last name or a team name.`);
  }

  const existing = await db.getFirstAsync<Participant>(
    'SELECT * FROM participants WHERE race_id = ? AND bib_number = ?',
    [data.race_id, data.bib_number],
  );
  if (existing) {
    await db.runAsync(
      `UPDATE participants
       SET first_name = ?, last_name = ?, gender = ?, dob = ?, club = ?, category = ?, team_name = ?,
           sub_category = ?, synced = 0
       WHERE id = ?`,
      [
        data.first_name ?? null,
        data.last_name ?? null,
        data.gender ?? null,
        data.dob ?? null,
        data.club ?? null,
        data.category ?? null,
        data.team_name ?? null,
        data.sub_category ?? null,
        existing.id,
      ],
    );
    return { ...existing, ...data, synced: 0 };
  }
  const id = uuid();
  await db.runAsync(
    `INSERT INTO participants
       (id, race_id, bib_number, first_name, last_name, gender, dob, club, category, team_name, sub_category)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.race_id,
      data.bib_number,
      data.first_name ?? null,
      data.last_name ?? null,
      data.gender ?? null,
      data.dob ?? null,
      data.club ?? null,
      data.category ?? null,
      data.team_name ?? null,
      data.sub_category ?? null,
    ],
  );
  return { id, ...data, synced: 0 };
}

// Bulk import from CSV — wrapped in a transaction so a few hundred rows
// commit as one write instead of one fsync per row.
export async function bulkUpsertParticipants(
  db: SQLite.SQLiteDatabase,
  rows: Omit<Participant, 'id' | 'synced'>[],
): Promise<number> {
  let count = 0;
  await db.withTransactionAsync(async () => {
    for (const row of rows) {
      await upsertParticipant(db, row);
      count++;
    }
  });
  return count;
}

export async function deleteParticipantsByRace(
  db: SQLite.SQLiteDatabase,
  raceId: string,
): Promise<void> {
  await db.runAsync('DELETE FROM participants WHERE race_id = ?', [raceId]);
}

export async function getUnsyncedParticipants(db: SQLite.SQLiteDatabase): Promise<Participant[]> {
  return db.getAllAsync<Participant>('SELECT * FROM participants WHERE synced = 0');
}

export async function markParticipantSynced(db: SQLite.SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync('UPDATE participants SET synced = 1 WHERE id = ?', [id]);
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
  // null for a direct-entry finish (bib typed with no Timer device running —
  // see the second half of the UNION below), never null for a gap row.
  timestamp_id: string | null;
  sequence_num: number | null;
  recorded_at: number | null;
  finish_id: string | null;
  bib_number: string | null;
  gun_time: number | null;
}

export async function getReviewRows(
  db: SQLite.SQLiteDatabase,
  raceId: string,
): Promise<ReviewRow[]> {
  // SQLite has no FULL OUTER JOIN, so this is a manual one via UNION ALL:
  // timestamps left-joined to finishes (covers matched + unmatched-timestamp
  // "gap" rows) UNION finishes that were never joined to a timestamp at all —
  // i.e. bibs typed on this device with no Timer device running. Without the
  // second half, a bib-only race (no timestamps table rows whatsoever) would
  // show as empty even though it has results.
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

     UNION ALL

     SELECT
       NULL AS timestamp_id,
       NULL AS sequence_num,
       NULL AS recorded_at,
       f.id AS finish_id,
       f.bib_number,
       f.gun_time
     FROM finishes f
     WHERE f.race_id = ? AND f.timestamp_id IS NULL

     ORDER BY sequence_num IS NULL, sequence_num`,
    [raceId, raceId],
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
