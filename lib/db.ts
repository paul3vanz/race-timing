import * as Crypto from 'expo-crypto';
import * as SQLite from 'expo-sqlite';

// ── Row types ─────────────────────────────────────────────────────────────────

export interface Event {
  id: string;
  name: string;
  date: string; // ISO8601
  location: string | null;
  status: 'pending' | 'active' | 'finished';
  join_code: string | null; // short code a second device types to join this event's race
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
  voided: 0 | 1; // operator discarded this as a mistake (e.g. a double-click) — never deleted
  is_manual: 0 | 1; // operator-inserted, backfilling a tap a Timer device missed
  duplicate_of: string | null; // set when a backup device's tap is a corroborating capture of another timestamp's row, not a separate finisher
  synced: 0 | 1;
}

export interface Finish {
  id: string;
  race_id: string;
  bib_number: string;
  timestamp_id: string | null;
  gun_time: number | null; // ms since race start_time
  chip_time: number | null;
  device_id: string; // which device recorded/typed this entry
  flagged: 0 | 1; // low-confidence auto-match from reconciliation, needs an eyeball
  duplicate_of: string | null; // set when a backup device's entry corroborates another finish row, not a separate finisher
  voided: 0 | 1; // operator removed this bib entry as a mistake — never deleted, so the removal syncs
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

  // v6 — join_code on events. Lets a second device find and pull down a race
  // it didn't create locally (see lib/sync.ts pullRace), instead of every
  // device's SQLite only ever knowing about races born on that device.
  `
  ALTER TABLE events ADD COLUMN join_code TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS events_join_code_idx ON events(join_code) WHERE join_code IS NOT NULL;
  `,

  // v7 — multi-device reconciliation columns. `voided`/`is_manual` on
  // timestamps and `duplicate_of` on both tables support the Review screen's
  // reconciliation flow: a backup Timer/Bib device's redundant capture of the
  // same real event is marked `duplicate_of` (kept for audit trail, excluded
  // from matching) rather than `voided` (an operator-confirmed mistake, e.g.
  // a genuine double-click). `finishes.device_id` was missing entirely until
  // now — needed to attribute a bib entry to a device for reconciliation and
  // diagnostics, mirroring what `timestamps` already tracks.
  `
  ALTER TABLE timestamps ADD COLUMN voided INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE timestamps ADD COLUMN is_manual INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE timestamps ADD COLUMN duplicate_of TEXT REFERENCES timestamps(id);
  ALTER TABLE finishes ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE finishes ADD COLUMN device_id TEXT NOT NULL DEFAULT 'unknown';
  ALTER TABLE finishes ADD COLUMN duplicate_of TEXT REFERENCES finishes(id);
  `,

  // v8 — enforce one *confirmed* finish per (race_id, bib_number), matching
  // the constraint the Supabase mirror already had. Deliberately scoped to
  // `timestamp_id IS NOT NULL` (i.e. linked/confirmed), not every row: two
  // devices legitimately produce two *orphan* finishes for the same bib pre-
  // reconciliation (one via assignBibToTimestamp, one via recordDirectFinish
  // on the other device) — lib/reconcile.ts's clustering needs to see both
  // to corroborate them, so a blanket constraint would break the exact
  // multi-device case this feature exists for. Only once reconciliation
  // *links* one of them does it need to be unique. Dedupe any pre-existing
  // clashes among already-linked rows first (keep the earliest gun_time)
  // since the index creation would otherwise fail on a database that
  // predates multi-device sync.
  `
  DELETE FROM finishes
  WHERE duplicate_of IS NULL
    AND timestamp_id IS NOT NULL
    AND id NOT IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY race_id, bib_number
          ORDER BY gun_time
        ) AS rn
        FROM finishes
        WHERE duplicate_of IS NULL AND timestamp_id IS NOT NULL
      )
      WHERE rn = 1
    );

  CREATE UNIQUE INDEX IF NOT EXISTS finishes_race_bib_idx
    ON finishes(race_id, bib_number) WHERE duplicate_of IS NULL AND timestamp_id IS NOT NULL;
  `,

  // v9 — allow the same bib on more than one finish, and add finishes.voided.
  // v8's unique index made a mistyped/duplicated bib throw at entry time,
  // which froze the Bib numpad mid-race. A duplicate is now a *result problem*
  // surfaced and fixed on the Results screen (where the wrong entry can be
  // edited), not something the Bib operator is blocked by while a queue builds
  // up behind them. `voided` lets the Results screen remove a bib entry in a
  // way that syncs to other devices (a hard DELETE would not).
  `
  DROP INDEX IF EXISTS finishes_race_bib_idx;
  CREATE INDEX IF NOT EXISTS finishes_race_bib_idx ON finishes(race_id, bib_number);
  ALTER TABLE finishes ADD COLUMN voided INTEGER NOT NULL DEFAULT 0;
  `,
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
  await ensureColumn(db, 'events', 'join_code', 'TEXT');
  await ensureColumn(db, 'timestamps', 'voided', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(db, 'timestamps', 'is_manual', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(db, 'timestamps', 'duplicate_of', 'TEXT REFERENCES timestamps(id)');
  await ensureColumn(db, 'finishes', 'flagged', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(db, 'finishes', 'device_id', "TEXT NOT NULL DEFAULT 'unknown'");
  await ensureColumn(db, 'finishes', 'duplicate_of', 'TEXT REFERENCES finishes(id)');
  await ensureColumn(db, 'finishes', 'voided', 'INTEGER NOT NULL DEFAULT 0');
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

// Unambiguous alphabet (no 0/O, 1/I) — this gets read aloud and typed on a
// numpad-sized screen by someone stood at a finish line, not copy-pasted.
const JOIN_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const JOIN_CODE_LENGTH = 6;

function generateJoinCode(): string {
  let code = '';
  for (let i = 0; i < JOIN_CODE_LENGTH; i++) {
    code += JOIN_CODE_ALPHABET[Math.floor(Math.random() * JOIN_CODE_ALPHABET.length)];
  }
  return code;
}

// ── Events ────────────────────────────────────────────────────────────────────

export async function getEvents(db: SQLite.SQLiteDatabase): Promise<Event[]> {
  return db.getAllAsync<Event>('SELECT * FROM events ORDER BY date DESC, name');
}

export async function getEvent(db: SQLite.SQLiteDatabase, id: string): Promise<Event | null> {
  return db.getFirstAsync<Event>('SELECT * FROM events WHERE id = ?', [id]);
}

export async function getEventForRace(
  db: SQLite.SQLiteDatabase,
  raceId: string,
): Promise<Event | null> {
  return db.getFirstAsync<Event>(
    'SELECT e.* FROM events e JOIN races r ON r.event_id = e.id WHERE r.id = ?',
    [raceId],
  );
}

export async function createEvent(
  db: SQLite.SQLiteDatabase,
  data: Omit<Event, 'id' | 'synced' | 'join_code'>,
): Promise<Event> {
  const id = uuid();
  // Collisions are astronomically unlikely (32^6 codes) but cheap to guard —
  // a handful of retries costs nothing next to a broken join flow.
  let join_code = generateJoinCode();
  for (let attempt = 0; attempt < 5; attempt++) {
    const clash = await db.getFirstAsync<{ id: string }>(
      'SELECT id FROM events WHERE join_code = ?',
      [join_code],
    );
    if (!clash) break;
    join_code = generateJoinCode();
  }
  await db.runAsync(
    'INSERT INTO events (id, name, date, location, status, join_code) VALUES (?, ?, ?, ?, ?, ?)',
    [id, data.name, data.date, data.location ?? null, data.status, join_code],
  );
  return { id, ...data, join_code, synced: 0 };
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
    'SELECT * FROM timestamps WHERE race_id = ? ORDER BY recorded_at',
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
  return { id, race_id: raceId, recorded_at: recordedAt, device_id: deviceId, sequence_num, voided: 0, is_manual: 0, duplicate_of: null, synced: 0 };
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

// Links a typed bib to a Timer tap. `timestampId` is the cluster's
// representative tap (see lib/merge.ts) and `gunTime` its race-relative time.
export async function assignBibToTimestamp(
  db: SQLite.SQLiteDatabase,
  raceId: string,
  bibNumber: string,
  timestampId: string,
  gunTime: number,
  deviceId: string,
): Promise<Finish> {
  const id = uuid();
  await db.runAsync(
    'INSERT INTO finishes (id, race_id, bib_number, timestamp_id, gun_time, device_id) VALUES (?, ?, ?, ?, ?, ?)',
    [id, raceId, bibNumber, timestampId, gunTime, deviceId],
  );
  return { id, race_id: raceId, bib_number: bibNumber, timestamp_id: timestampId, gun_time: gunTime, chip_time: null, device_id: deviceId, flagged: 0, duplicate_of: null, voided: 0, synced: 0 };
}

export async function recordDirectFinish(
  db: SQLite.SQLiteDatabase,
  raceId: string,
  bibNumber: string,
  gunTime: number,
  deviceId: string,
): Promise<Finish> {
  const id = uuid();
  await db.runAsync(
    'INSERT INTO finishes (id, race_id, bib_number, timestamp_id, gun_time, device_id) VALUES (?, ?, ?, NULL, ?, ?)',
    [id, raceId, bibNumber, gunTime, deviceId],
  );
  return { id, race_id: raceId, bib_number: bibNumber, timestamp_id: null, gun_time: gunTime, chip_time: null, device_id: deviceId, flagged: 0, duplicate_of: null, voided: 0, synced: 0 };
}

// ── Results editing ──────────────────────────────────────────────────────────
//
// Every edit below flips `synced` back to 0, so it's pushed to Supabase and —
// because the pull only overwrites rows that are already synced (see
// lib/sync.ts pullRaceData) — reaches every other device without clobbering
// an edit that hasn't been pushed yet. Last device to push wins.

// Corrects a mistyped bib on an existing finish (e.g. 123 entered twice when
// one was really 132).
export async function updateFinishBib(
  db: SQLite.SQLiteDatabase,
  id: string,
  bibNumber: string,
): Promise<void> {
  await db.runAsync('UPDATE finishes SET bib_number = ?, synced = 0 WHERE id = ?', [bibNumber, id]);
}

// Removes a bib entry from the results (typed by mistake, or for nobody).
// Soft, like voidTimestamp, so the removal syncs.
export async function voidFinish(db: SQLite.SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync('UPDATE finishes SET voided = 1, synced = 0 WHERE id = ?', [id]);
}

// Soft-discard a double-click — never deleted, so the audit trail (and any
// already-pushed remote copy) stays intact.
export async function voidTimestamp(db: SQLite.SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync('UPDATE timestamps SET voided = 1, synced = 0 WHERE id = ?', [id]);
}

// Backfills a tap every Timer device missed. Mirrors recordTimestamp's
// per-device sequencing so it slots into the same ordering machinery, but
// under a synthetic per-device 'manual-xxxx' id, so two devices backfilling at
// once can't produce the same (race, device, sequence) on the remote.
export async function insertManualTimestamp(
  db: SQLite.SQLiteDatabase,
  raceId: string,
  recordedAt: number,
  insertingDeviceId: string,
): Promise<Timestamp> {
  const deviceId = `manual-${insertingDeviceId.slice(0, 8)}`;
  const result = await db.getFirstAsync<{ max_seq: number | null }>(
    'SELECT MAX(sequence_num) AS max_seq FROM timestamps WHERE race_id = ? AND device_id = ?',
    [raceId, deviceId],
  );
  const sequence_num = (result?.max_seq ?? 0) + 1;
  const id = uuid();
  await db.runAsync(
    'INSERT INTO timestamps (id, race_id, recorded_at, device_id, sequence_num, is_manual) VALUES (?, ?, ?, ?, ?, 1)',
    [id, raceId, recordedAt, deviceId, sequence_num],
  );
  return { id, race_id: raceId, recorded_at: recordedAt, device_id: deviceId, sequence_num, voided: 0, is_manual: 1, duplicate_of: null, synced: 0 };
}

// Marks a raw finish as a backup device's corroborating entry for the same
// bib/event as `canonicalId`, not a separate finisher.
export async function markFinishDuplicate(
  db: SQLite.SQLiteDatabase,
  id: string,
  canonicalId: string,
): Promise<void> {
  await db.runAsync('UPDATE finishes SET duplicate_of = ?, synced = 0 WHERE id = ?', [canonicalId, id]);
}

// Points an existing finish at a (different) Timer tap, taking the tap's
// precise capture time instead of whenever the bib was typed. Updates the row
// in place (finishes are last-write-wins, unlike immutable timestamps).
export async function linkFinishToTimestamp(
  db: SQLite.SQLiteDatabase,
  finishId: string,
  timestampId: string,
  gunTime: number,
  flagged: boolean,
): Promise<void> {
  await db.runAsync(
    'UPDATE finishes SET timestamp_id = ?, gun_time = ?, flagged = ?, synced = 0 WHERE id = ?',
    [timestampId, gunTime, flagged ? 1 : 0, finishId],
  );
}

// Re-links many finishes at once in a single transaction (used by the Results
// screen's "re-match in order" repair).
export async function relinkFinishes(
  db: SQLite.SQLiteDatabase,
  links: { finishId: string; timestampId: string; gunTime: number }[],
): Promise<void> {
  await db.withTransactionAsync(async () => {
    for (const l of links) await linkFinishToTimestamp(db, l.finishId, l.timestampId, l.gunTime, false);
  });
}

export async function getUnsyncedFinishes(db: SQLite.SQLiteDatabase): Promise<Finish[]> {
  return db.getAllAsync<Finish>(
    'SELECT * FROM finishes WHERE synced = 0 ORDER BY race_id, gun_time',
  );
}

export async function markFinishSynced(db: SQLite.SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync('UPDATE finishes SET synced = 1 WHERE id = ?', [id]);
}
