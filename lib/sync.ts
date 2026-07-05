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
} from './db';
import { isSupabaseConfigured, supabase } from './supabase';

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
