import type { SQLiteDatabase } from 'expo-sqlite';

import {
  getUnsyncedEvents,
  getUnsyncedFinishes,
  getUnsyncedParticipants,
  getUnsyncedRaces,
  getUnsyncedTimestamps,
  markEventSynced,
  markFinishSynced,
  markParticipantSynced,
  markRaceSynced,
  markTimestampSynced,
  upsertParticipant,
  type Race,
} from './db';
import { ensureAnonymousSession, isSupabaseConfigured, supabase } from './supabase';

const BATCH_SIZE = 200;

export interface SyncResult {
  pushed: number;
  error: string | null;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Remote tables mirror the local ones minus the local-only `synced` flag.
function stripSynced<T extends { synced: 0 | 1 }>(row: T): Omit<T, 'synced'> {
  const { synced: _synced, ...rest } = row;
  return rest;
}

// Push and pull must never interleave: a pull that fetched before a push
// finished would otherwise apply its stale copy over a row the push has just
// marked synced, silently undoing an edit. Everything that talks to the race
// tables runs through this one queue.
let syncQueue: Promise<unknown> = Promise.resolve();
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = syncQueue.then(task, task);
  syncQueue = run.catch(() => undefined);
  return run;
}

async function pushRows<T extends { id: string; synced: 0 | 1 }>(
  db: SQLiteDatabase,
  table: string,
  rows: T[],
  onConflict: string,
  markSynced: (db: SQLiteDatabase, id: string) => Promise<void>,
): Promise<void> {
  // supabase-js infers row types from a generated Database schema we don't
  // have here; the remote tables are hand-verified to mirror the local
  // ones (minus `synced`), so this cast is safe.
  const upsert = (batch: T[]) =>
    supabase.from(table).upsert(batch.map(stripSynced) as never[], { onConflict });

  for (const batch of chunk(rows, BATCH_SIZE)) {
    const { error } = await upsert(batch);
    if (error) {
      // One bad row (a constraint the remote still has, say) must not block
      // every other row behind it forever: retry one by one, push what can be
      // pushed, and report the rest.
      let rejected = 0;
      let firstMessage = error.message;
      for (const row of batch) {
        const single = await upsert([row]);
        if (single.error) {
          rejected++;
          firstMessage = single.error.message;
        } else {
          await markSynced(db, row.id);
        }
      }
      if (rejected > 0) throw new Error(`${table}: ${rejected} row(s) rejected (${firstMessage})`);
      continue;
    }
    await db.withTransactionAsync(async () => {
      for (const row of batch) await markSynced(db, row.id);
    });
  }
}

// Pushes local changes to Supabase in FK-safe order (parents before
// children). Only rows with synced = 0 are sent, so this is cheap and safe
// to call on a timer. Never throws — errors surface via the returned result
// so the sync loop can retry on the next tick instead of crashing the app.
export function pushPendingChanges(db: SQLiteDatabase): Promise<SyncResult> {
  return exclusive(() => pushPendingChangesNow(db));
}

async function pushPendingChangesNow(db: SQLiteDatabase): Promise<SyncResult> {
  if (!isSupabaseConfigured) {
    return { pushed: 0, error: null };
  }

  let pushed = 0;
  let firstError: string | null = null;
  const note = (e: unknown) => {
    firstError ??= e instanceof Error ? e.message : String(e);
  };

  try {
    await ensureAnonymousSession();

    // Parents first: a failure here would only make every child fail too, so
    // stop and report it.
    const events = await getUnsyncedEvents(db);
    await pushRows(db, 'events', events, 'id', markEventSynced);
    pushed += events.length;

    const races = await getUnsyncedRaces(db);
    await pushRows(db, 'races', races, 'id', markRaceSynced);
    pushed += races.length;

    // Participants are identified by (race_id, bib_number) locally, not id —
    // re-importing a CSV assigns fresh local ids, so conflicts must resolve
    // on the same natural key here or re-imports would duplicate remotely.
    const participants = await getUnsyncedParticipants(db);
    await pushRows(db, 'participants', participants, 'race_id,bib_number', markParticipantSynced);
    pushed += participants.length;
  } catch (e) {
    return { pushed, error: e instanceof Error ? e.message : String(e) };
  }

  // Race data: keep going if one table has rejects, so a problem with a few
  // taps never stops bib entries (or vice versa) reaching the other devices.
  try {
    const timestamps = await getUnsyncedTimestamps(db);
    await pushRows(db, 'timestamps', timestamps, 'id', markTimestampSynced);
    pushed += timestamps.length;
  } catch (e) {
    note(e);
  }
  try {
    const finishes = await getUnsyncedFinishes(db);
    await pushRows(db, 'finishes', finishes, 'id', markFinishSynced);
    pushed += finishes.length;
  } catch (e) {
    note(e);
  }

  return { pushed, error: firstError };
}

// Total rows still waiting to be pushed — drives the Settings sync indicator.
export async function countPending(db: SQLiteDatabase): Promise<number> {
  const [events, races, participants, timestamps, finishes] = await Promise.all([
    getUnsyncedEvents(db),
    getUnsyncedRaces(db),
    getUnsyncedParticipants(db),
    getUnsyncedTimestamps(db),
    getUnsyncedFinishes(db),
  ]);
  return events.length + races.length + participants.length + timestamps.length + finishes.length;
}

// ── Pull (multi-device) ──────────────────────────────────────────────────────

export interface JoinCodeMatch {
  eventId: string;
  raceId: string;
}

// Resolves a short join code to an event/race pair via a narrow Postgres RPC
// (see supabase/migrations/..._join_code_rpc.sql) rather than a raw table
// select — RLS on this project is still the permissive "allow all"
// placeholder, so an unrestricted select gated only by a public 6-char code
// would double as free read/write on every other table for that race.
export async function lookupEventByJoinCode(code: string): Promise<JoinCodeMatch | null> {
  if (!isSupabaseConfigured) return null;
  const { data, error } = await supabase.rpc('get_event_by_code', { code: code.trim().toUpperCase() });
  if (error) throw new Error(`join code lookup: ${error.message}`);
  const row = data?.[0];
  return row ? { eventId: row.event_id as string, raceId: row.race_id as string } : null;
}

// Bootstraps (or refreshes) an event + its race + roster into local SQLite —
// the only path by which a device that didn't create a race locally ever
// learns about it. `INSERT OR IGNORE` for event/race: their fields rarely
// change post-creation, and start_time propagation has its own dedicated
// conditional-update path (see startRaceRemote/pullRaceStartTime) rather
// than going through here. Participants reuse the existing upsertParticipant
// natural-key logic so a re-pull behaves the same as a local CSV re-import.
export async function pullRace(db: SQLiteDatabase, eventId: string, raceId: string): Promise<void> {
  if (!isSupabaseConfigured) return;

  const [eventRes, raceRes, participantsRes] = await Promise.all([
    supabase.from('events').select('*').eq('id', eventId).single(),
    supabase.from('races').select('*').eq('id', raceId).single(),
    supabase.from('participants').select('*').eq('race_id', raceId),
  ]);
  if (eventRes.error) throw new Error(`pullRace (event): ${eventRes.error.message}`);
  if (raceRes.error) throw new Error(`pullRace (race): ${raceRes.error.message}`);
  if (participantsRes.error) throw new Error(`pullRace (participants): ${participantsRes.error.message}`);

  const event = eventRes.data;
  const race = raceRes.data;

  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `INSERT OR IGNORE INTO events (id, name, date, location, status, synced) VALUES (?, ?, ?, ?, ?, 1)`,
      [event.id, event.name, event.date, event.location, event.status],
    );
    await db.runAsync(
      `INSERT OR IGNORE INTO races (id, event_id, name, start_time, wave, max_bib, synced) VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [race.id, race.event_id, race.name, race.start_time, race.wave, race.max_bib],
    );
    for (const p of participantsRes.data ?? []) {
      await upsertParticipant(db, {
        race_id: p.race_id,
        bib_number: p.bib_number,
        first_name: p.first_name,
        last_name: p.last_name,
        gender: p.gender,
        dob: p.dob,
        club: p.club,
        category: p.category,
        team_name: p.team_name,
        sub_category: p.sub_category,
      });
    }
  });
}

// Supabase caps a single select at 1000 rows, and two Timers plus a bib
// device on a 500-finisher race is comfortably more than that, so page through.
const PAGE_SIZE = 1000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RemoteRow = Record<string, any>;

async function fetchAllForRace(table: 'timestamps' | 'finishes', raceId: string): Promise<RemoteRow[]> {
  const rows: RemoteRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .eq('race_id', raceId)
      .order('id')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`pullRaceData (${table}): ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

// Pulls every timestamp + finish for a race from Supabase and merges them
// into local SQLite. This is what lets a device see another device's taps,
// bib entries and corrections. Used on a timer by the Bib and Results screens
// and on mount elsewhere.
//
// Merge rules (see also the edit helpers in lib/db.ts):
//  - A local row with synced = 0 has changes not pushed yet: never overwrite
//    it. Once pushed it's synced = 1 and remote is again the truth, so an edit
//    made on another device (a corrected bib, a removed entry) arrives here.
//  - Timestamps only ever gain voided / duplicate_of, so those are merged
//    one way (never un-voided).
//  - Only rows that actually differ are written, so a poll every few seconds
//    on a 500-finisher race is a handful of cheap reads, not 1000 upserts.
export function pullRaceData(db: SQLiteDatabase, raceId: string): Promise<void> {
  return exclusive(() => pullRaceDataNow(db, raceId));
}

interface LocalFinishRow {
  id: string;
  bib_number: string;
  timestamp_id: string | null;
  gun_time: number | null;
  flagged: number;
  duplicate_of: string | null;
  voided: number;
  synced: number;
}

const finishSignature = (f: Omit<LocalFinishRow, 'id' | 'synced'>) =>
  [f.bib_number, f.timestamp_id, f.gun_time, f.flagged, f.duplicate_of, f.voided].join('|');

async function pullRaceDataNow(db: SQLiteDatabase, raceId: string): Promise<void> {
  if (!isSupabaseConfigured) return;

  const raceRes = await supabase.from('races').select('start_time, event_id').eq('id', raceId).single();
  if (raceRes.error) throw new Error(`pullRaceData (race): ${raceRes.error.message}`);

  const [eventRes, remoteTimestamps, remoteFinishes] = await Promise.all([
    supabase.from('events').select('status').eq('id', raceRes.data.event_id).single(),
    fetchAllForRace('timestamps', raceId),
    fetchAllForRace('finishes', raceId),
  ]);
  if (eventRes.error) throw new Error(`pullRaceData (event): ${eventRes.error.message}`);

  const localTimestamps = new Map(
    (
      await db.getAllAsync<{ id: string; voided: number; duplicate_of: string | null }>(
        'SELECT id, voided, duplicate_of FROM timestamps WHERE race_id = ?',
        [raceId],
      )
    ).map((t) => [t.id, t]),
  );
  const localFinishes = new Map(
    (
      await db.getAllAsync<LocalFinishRow>(
        'SELECT id, bib_number, timestamp_id, gun_time, flagged, duplicate_of, voided, synced FROM finishes WHERE race_id = ?',
        [raceId],
      )
    ).map((f) => [f.id, f]),
  );

  await db.withTransactionAsync(async () => {
    // The start time can only ever arrive here for a device that joined before
    // the race started; never overwrite one this device already has.
    if (raceRes.data.start_time !== null) {
      await db.runAsync('UPDATE races SET start_time = ? WHERE id = ? AND start_time IS NULL', [
        raceRes.data.start_time,
        raceId,
      ]);
    }
    // Race stopped or reopened on another device. Same synced guard as finishes.
    await db.runAsync('UPDATE events SET status = ? WHERE id = ? AND synced = 1 AND status != ?', [
      eventRes.data.status,
      raceRes.data.event_id,
      eventRes.data.status,
    ]);

    for (const t of remoteTimestamps) {
      const local = localTimestamps.get(t.id);
      const voided = t.voided ? 1 : 0;
      if (!local) {
        await db.runAsync(
          `INSERT INTO timestamps
             (id, race_id, recorded_at, device_id, sequence_num, voided, is_manual, duplicate_of, synced)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [t.id, t.race_id, t.recorded_at, t.device_id, t.sequence_num, voided, t.is_manual ? 1 : 0, t.duplicate_of ?? null],
        );
      } else if ((voided && !local.voided) || (t.duplicate_of && !local.duplicate_of)) {
        // synced is left alone on purpose: a still-pending local change keeps
        // its own synced = 0 and goes out on the next push.
        await db.runAsync(
          `UPDATE timestamps
           SET voided = MAX(voided, ?), duplicate_of = COALESCE(duplicate_of, ?)
           WHERE id = ?`,
          [voided, t.duplicate_of ?? null, t.id],
        );
      }
    }

    for (const f of remoteFinishes) {
      const local = localFinishes.get(f.id);
      const remote = {
        bib_number: f.bib_number as string,
        timestamp_id: (f.timestamp_id ?? null) as string | null,
        gun_time: (f.gun_time ?? null) as number | null,
        flagged: f.flagged ? 1 : 0,
        duplicate_of: (f.duplicate_of ?? null) as string | null,
        voided: f.voided ? 1 : 0,
      };
      if (!local) {
        await db.runAsync(
          `INSERT INTO finishes
             (id, race_id, bib_number, timestamp_id, gun_time, chip_time, device_id, flagged, duplicate_of, voided, synced)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [
            f.id,
            f.race_id,
            remote.bib_number,
            remote.timestamp_id,
            remote.gun_time,
            f.chip_time ?? null,
            f.device_id,
            remote.flagged,
            remote.duplicate_of,
            remote.voided,
          ],
        );
      } else if (local.synced === 1 && finishSignature(local) !== finishSignature(remote)) {
        await db.runAsync(
          `UPDATE finishes
           SET bib_number = ?, timestamp_id = ?, gun_time = ?, flagged = ?, duplicate_of = ?, voided = ?
           WHERE id = ?`,
          [
            remote.bib_number,
            remote.timestamp_id,
            remote.gun_time,
            remote.flagged,
            remote.duplicate_of,
            remote.voided,
            f.id,
          ],
        );
      }
    }
  });
}

// Push whatever this device has, then pull everyone else's. This is the one
// call the Bib and Results screens poll.
export async function syncRaceNow(db: SQLiteDatabase, raceId: string): Promise<SyncResult> {
  if (!isSupabaseConfigured) return { pushed: 0, error: null };
  const push = await pushPendingChanges(db);
  try {
    await pullRaceData(db, raceId);
    return push;
  } catch (e) {
    return { pushed: push.pushed, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Race start-time propagation ──────────────────────────────────────────────

// Race-safe "first write wins": only succeeds if start_time is still null
// remotely. `.select('id')` is required, not optional — PostgREST only
// reports which rows an UPDATE touched when a select is chained, so without
// it a lost race and a dropped network request look identical (both
// "no error, nothing to read"). Returns the winning start_time either way:
// this device's own value if it won, or whoever's already there if it lost.
export async function startRaceRemote(
  db: SQLiteDatabase,
  raceId: string,
  startTime: number,
): Promise<number> {
  if (!isSupabaseConfigured) return startTime;

  await ensureAnonymousSession();

  const { data, error } = await supabase
    .from('races')
    .update({ start_time: startTime })
    .eq('id', raceId)
    .is('start_time', null)
    .select('id');
  if (error) throw new Error(`startRaceRemote: ${error.message}`);
  if (data && data.length > 0) return startTime;

  const existing = await supabase.from('races').select('start_time').eq('id', raceId).single();
  if (existing.error) throw new Error(`startRaceRemote (refetch): ${existing.error.message}`);
  return (existing.data?.start_time as number | null) ?? startTime;
}

// Light-weight poll for the one field that needs sub-20s propagation before
// a race starts — see hooks/use-race-start-poll.ts, which stops calling this
// the instant a non-null value comes back.
export async function pullRaceStartTime(raceId: string): Promise<Race['start_time'] | null> {
  if (!isSupabaseConfigured) return null;
  const { data, error } = await supabase.from('races').select('start_time').eq('id', raceId).single();
  if (error) throw new Error(`pullRaceStartTime: ${error.message}`);
  return data?.start_time ?? null;
}
