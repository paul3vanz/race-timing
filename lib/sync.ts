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

async function pushRows<T extends { id: string; synced: 0 | 1 }>(
  db: SQLiteDatabase,
  table: string,
  rows: T[],
  onConflict: string,
  markSynced: (db: SQLiteDatabase, id: string) => Promise<void>,
): Promise<void> {
  for (const batch of chunk(rows, BATCH_SIZE)) {
    // supabase-js infers row types from a generated Database schema we don't
    // have here; the remote tables are hand-verified to mirror the local
    // ones (minus `synced`), so this cast is safe.
    const { error } = await supabase
      .from(table)
      .upsert(batch.map(stripSynced) as never[], { onConflict });
    if (error) throw new Error(`${table}: ${error.message}`);
    await db.withTransactionAsync(async () => {
      for (const row of batch) await markSynced(db, row.id);
    });
  }
}

// Pushes local changes to Supabase in FK-safe order (parents before
// children). Only rows with synced = 0 are sent, so this is cheap and safe
// to call on a timer. Never throws — errors surface via the returned result
// so the sync loop can retry on the next tick instead of crashing the app.
export async function pushPendingChanges(db: SQLiteDatabase): Promise<SyncResult> {
  if (!isSupabaseConfigured) {
    return { pushed: 0, error: null };
  }

  let pushed = 0;
  try {
    await ensureAnonymousSession();

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

    const timestamps = await getUnsyncedTimestamps(db);
    await pushRows(db, 'timestamps', timestamps, 'id', markTimestampSynced);
    pushed += timestamps.length;

    const finishes = await getUnsyncedFinishes(db);
    await pushRows(db, 'finishes', finishes, 'id', markFinishSynced);
    pushed += finishes.length;

    return { pushed, error: null };
  } catch (e) {
    return { pushed, error: e instanceof Error ? e.message : String(e) };
  }
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

// Pulls every timestamp + finish for a race from Supabase and merges them
// into local SQLite — this is what lets a device see another device's taps
// and bib entries for reconciliation. Batched in one transaction (a few
// hundred rows at most per table) rather than row-by-row, to avoid UI jank
// on a low-end device mid-race. Deliberately scoped to on-demand callers
// (screen mount, Review's pull-to-refresh) rather than a recurring fast
// timer — see the plan notes on why a perpetual fast full-pull is the wrong
// shape here (use pullRaceStartTime's dedicated light poll for that).
export async function pullRaceData(db: SQLiteDatabase, raceId: string): Promise<void> {
  if (!isSupabaseConfigured) return;

  const [timestampsRes, finishesRes] = await Promise.all([
    supabase.from('timestamps').select('*').eq('race_id', raceId),
    supabase.from('finishes').select('*').eq('race_id', raceId),
  ]);
  if (timestampsRes.error) throw new Error(`pullRaceData (timestamps): ${timestampsRes.error.message}`);
  if (finishesRes.error) throw new Error(`pullRaceData (finishes): ${finishesRes.error.message}`);

  await db.withTransactionAsync(async () => {
    // Timestamps are immutable once written except for voided/duplicate_of,
    // both set only by reconciliation — merge those two flags rather than
    // blindly overwrite, so a remote copy from before this device resolved
    // it locally can't un-resolve it.
    for (const t of timestampsRes.data ?? []) {
      await db.runAsync(
        `INSERT INTO timestamps
           (id, race_id, recorded_at, device_id, sequence_num, voided, is_manual, duplicate_of, synced)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(id) DO UPDATE SET
           voided = MAX(voided, excluded.voided),
           duplicate_of = COALESCE(duplicate_of, excluded.duplicate_of),
           synced = 1`,
        [t.id, t.race_id, t.recorded_at, t.device_id, t.sequence_num, t.voided ? 1 : 0, t.is_manual ? 1 : 0, t.duplicate_of],
      );
    }
    // Finishes can be relinked by reconciliation after insert — merge rather
    // than overwrite so a stale unlinked remote copy can't clobber a link
    // this device already made locally.
    for (const f of finishesRes.data ?? []) {
      await db.runAsync(
        `INSERT INTO finishes
           (id, race_id, bib_number, timestamp_id, gun_time, chip_time, device_id, flagged, duplicate_of, synced)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(id) DO UPDATE SET
           timestamp_id = COALESCE(timestamp_id, excluded.timestamp_id),
           gun_time = COALESCE(gun_time, excluded.gun_time),
           flagged = MAX(flagged, excluded.flagged),
           duplicate_of = COALESCE(duplicate_of, excluded.duplicate_of),
           synced = 1`,
        [f.id, f.race_id, f.bib_number, f.timestamp_id, f.gun_time, f.chip_time, f.device_id, f.flagged ? 1 : 0, f.duplicate_of],
      );
    }
  });
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
