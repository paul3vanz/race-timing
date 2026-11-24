import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import type { SQLiteDatabase } from 'expo-sqlite';
import { Platform } from 'react-native';
import { create } from 'zustand';

import {
  assignBibToTimestamp,
  getEventForRace,
  getFinishesByRace,
  getParticipantsByRace,
  getRace,
  getTimestampsByRace,
  recordDirectFinish,
  recordTimestamp as dbRecordTimestamp,
  setRaceStartTime,
  updateEventStatus,
  voidFinish,
  voidTimestamp,
  type Event,
  type Finish,
  type Participant,
  type Race,
  type Timestamp,
} from './db';
import { buildQueue, type QueueItem } from './merge';
import { startRaceRemote } from './sync';

// ── Types ─────────────────────────────────────────────────────────────────────

// How this device's Bib screen records entries:
//  - 'funnel': the complete list typed at the end of the funnel, matched to the
//    Timers' taps in order (or, with no taps to hand, recorded as typed and
//    matched up later on Results).
//  - 'line': a backup recorder at the finish line typing the bibs it can catch.
//    Entries are timed as typed and never consume the tap queue; they are used
//    to cross-check the Timers and fill gaps, not published as results.
export type BibMode = 'funnel' | 'line';

interface RaceStore {
  // Persisted across launches
  deviceId: string | null;
  bibMode: BibMode;
  // Who is using this device ("First Last"), written onto every tap and bib so
  // the data can be traced back to a person. Null until entered.
  operatorName: string | null;
  // False until the persisted settings have been read, so the name prompt
  // doesn't flash up before a saved name has loaded.
  settingsLoaded: boolean;

  // Active race context — set when a race screen is opened
  activeRace: Race | null;
  event: Event | null; // the race's event: its status is what "stopped" means

  // In-memory mirrors of the DB for the active race. These hold EVERYTHING in
  // the local DB for the race, including rows pulled from other devices.
  timestamps: Timestamp[];
  finishes: Finish[];
  participants: Participant[]; // full roster, for bib -> name lookups

  // Taps still waiting for a bib, in finishing order across ALL Timer devices
  // (taps from two Timers for the same finisher are one entry). Derived from
  // timestamps + finishes, never stored.
  unassigned: QueueItem[];

  // Finish ids this device typed since the screen opened, newest last — what
  // "Undo" walks back through.
  entryStack: string[];

  // ── Actions ─────────────────────────────────────────────────────────────────

  // Call once at app startup before rendering race screens
  initDeviceId: () => Promise<void>;

  setBibMode: (mode: BibMode) => Promise<void>;

  setOperatorName: (name: string | null) => Promise<void>;

  // Load (or reload) all race data into the store
  loadRace: (db: SQLiteDatabase, raceId: string) => Promise<void>;

  // Unload race data when leaving the race context
  clearActiveRace: () => void;

  // Set race start_time to now if not already started. Propagates to other
  // devices via a race-safe conditional update; if another device already
  // won that race, adopts their start_time instead.
  startRace: (db: SQLiteDatabase) => Promise<void>;

  // Adopts a start_time discovered via the pre-race poll (hooks/use-race-start-poll)
  // when another device started the race first. No-op once this device
  // already has one — a stale poll response must never undo a local start.
  adoptRemoteStartTime: (db: SQLiteDatabase, startTime: number) => Promise<void>;

  // Marks the race finished (or reopens it). Syncs like any other event
  // change, so every device learns the race has been stopped.
  setRaceStopped: (db: SQLiteDatabase, stopped: boolean) => Promise<void>;

  // Hot path: capture Date.now() immediately, write async, update store.
  // `capturedAt` lets a caller that already has a precise timestamp (the
  // volume-key listener stamps it natively) pass it through.
  recordTimestamp: (db: SQLiteDatabase, capturedAt?: number) => Promise<Timestamp | null>;

  // Assign a bib to the next unassigned finisher in the queue
  assignBib: (db: SQLiteDatabase, bibNumber: string) => Promise<Finish | null>;

  // Remove the last bib this device typed (puts its finisher back in the queue)
  undoLastBib: (db: SQLiteDatabase) => Promise<void>;

  // Discard the tap at the head of the queue as a phantom (stray press)
  skipQueueHead: (db: SQLiteDatabase) => Promise<void>;

  // Re-query the DB; call after returning from background, after a sync pulled
  // other devices' rows, or after manual corrections
  refreshData: (db: SQLiteDatabase) => Promise<void>;
}

// ── Device ID ─────────────────────────────────────────────────────────────────

const DEVICE_ID_KEY = 'race_timing_device_id';

async function resolveDeviceId(): Promise<string> {
  // SecureStore is native-only; fall back to localStorage on web (dev/preview only).
  if (Platform.OS === 'web') {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    const id = Crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
    return id;
  }
  const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  if (existing) return existing;
  const id = Crypto.randomUUID();
  await SecureStore.setItemAsync(DEVICE_ID_KEY, id);
  return id;
}

const BIB_MODE_KEY = 'race_timing_bib_mode';
const OPERATOR_NAME_KEY = 'race_timing_operator_name';

async function readSetting(key: string): Promise<string | null> {
  try {
    return Platform.OS === 'web' ? localStorage.getItem(key) : await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

// Not persisting just means the setting reverts on restart.
async function writeSetting(key: string, value: string | null): Promise<void> {
  try {
    if (Platform.OS === 'web') {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } else if (value === null) {
      await SecureStore.deleteItemAsync(key);
    } else {
      await SecureStore.setItemAsync(key, value);
    }
  } catch {
    // ignore
  }
}

async function readBibMode(): Promise<BibMode> {
  return (await readSetting(BIB_MODE_KEY)) === 'line' ? 'line' : 'funnel';
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useRaceStore = create<RaceStore>((set, get) => ({
  deviceId: null,
  bibMode: 'funnel',
  operatorName: null,
  settingsLoaded: false,
  activeRace: null,
  event: null,
  timestamps: [],
  finishes: [],
  participants: [],
  unassigned: [],
  entryStack: [],

  initDeviceId: async () => {
    const [deviceId, bibMode, operatorName] = await Promise.all([
      resolveDeviceId(),
      readBibMode(),
      readSetting(OPERATOR_NAME_KEY),
    ]);
    set({ deviceId, bibMode, operatorName: operatorName?.trim() || null, settingsLoaded: true });
  },

  setBibMode: async (mode) => {
    set({ bibMode: mode });
    await writeSetting(BIB_MODE_KEY, mode);
  },

  setOperatorName: async (name) => {
    const clean = name?.replace(/\s+/g, ' ').trim() || null;
    set({ operatorName: clean });
    await writeSetting(OPERATOR_NAME_KEY, clean);
  },

  loadRace: async (db, raceId) => {
    const [race, event, timestamps, finishes, participants] = await Promise.all([
      getRace(db, raceId),
      getEventForRace(db, raceId),
      getTimestampsByRace(db, raceId),
      getFinishesByRace(db, raceId),
      getParticipantsByRace(db, raceId),
    ]);
    set({
      activeRace: race,
      event,
      timestamps,
      finishes,
      participants,
      unassigned: buildQueue(timestamps, finishes),
      entryStack: [],
    });
  },

  clearActiveRace: () => {
    set({
      activeRace: null,
      event: null,
      timestamps: [],
      finishes: [],
      participants: [],
      unassigned: [],
      entryStack: [],
    });
  },

  startRace: async (db) => {
    const { activeRace, event } = get();
    if (!activeRace || activeRace.start_time !== null) return;
    const startTime = Date.now();
    await setRaceStartTime(db, activeRace.id, startTime);
    if (event && event.status === 'pending') {
      await updateEventStatus(db, event.id, 'active');
      set((state) => (state.event?.id === event.id ? { event: { ...state.event, status: 'active' } } : {}));
    }
    set((state) =>
      state.activeRace?.id === activeRace.id ? { activeRace: { ...state.activeRace, start_time: startTime } } : {},
    );

    try {
      const winningStartTime = await startRaceRemote(db, activeRace.id, startTime);
      if (winningStartTime !== startTime) {
        // Another device won the race to start it first — adopt their time
        // so every device computes gun_time off the same origin.
        await setRaceStartTime(db, activeRace.id, winningStartTime);
        set((state) =>
          state.activeRace?.id === activeRace.id
            ? { activeRace: { ...state.activeRace, start_time: winningStartTime } }
            : {},
        );
      }
    } catch {
      // Offline or a transient error — the regular sync cycle reconciles
      // start_time once connectivity returns; the operator isn't blocked.
    }
  },

  adoptRemoteStartTime: async (db, startTime) => {
    const { activeRace } = get();
    if (!activeRace || activeRace.start_time !== null) return;
    await setRaceStartTime(db, activeRace.id, startTime);
    set((state) =>
      state.activeRace?.id === activeRace.id ? { activeRace: { ...state.activeRace, start_time: startTime } } : {},
    );
  },

  setRaceStopped: async (db, stopped) => {
    const { event } = get();
    if (!event) return;
    const status: Event['status'] = stopped ? 'finished' : 'active';
    await updateEventStatus(db, event.id, status);
    set((state) => (state.event?.id === event.id ? { event: { ...state.event, status } } : {}));
  },

  recordTimestamp: async (db, capturedAt) => {
    // Capture the time first — before any async work — to stay accurate.
    const recordedAt = capturedAt ?? Date.now();
    const { activeRace, deviceId, event, operatorName } = get();
    if (!activeRace || !deviceId || event?.status === 'finished') return null;

    const ts = await dbRecordTimestamp(db, activeRace.id, deviceId, recordedAt, operatorName);
    set((state) => {
      const timestamps = [...state.timestamps, ts];
      return { timestamps, unassigned: buildQueue(timestamps, state.finishes) };
    });
    return ts;
  },

  assignBib: async (db, bibNumber) => {
    const capturedAt = Date.now();
    const { activeRace, unassigned, deviceId, event, bibMode, operatorName } = get();
    if (!activeRace?.start_time || !deviceId || event?.status === 'finished') return null;

    // Finish-line entries are timed as typed and leave the tap queue alone.
    const head = bibMode === 'funnel' ? unassigned[0] : undefined;
    const finish = head
      ? await assignBibToTimestamp(
          db,
          activeRace.id,
          bibNumber,
          head.id,
          head.time - activeRace.start_time,
          deviceId,
          operatorName,
          capturedAt,
        )
      : await recordDirectFinish(
          db,
          activeRace.id,
          bibNumber,
          capturedAt - activeRace.start_time,
          deviceId,
          bibMode === 'line' ? 'line' : 'funnel',
          operatorName,
          capturedAt,
        );

    set((state) => {
      const finishes = [...state.finishes, finish].sort((a, b) => (a.gun_time ?? 0) - (b.gun_time ?? 0));
      return {
        finishes,
        unassigned: buildQueue(state.timestamps, finishes),
        entryStack: [...state.entryStack, finish.id],
      };
    });
    return finish;
  },

  undoLastBib: async (db) => {
    const { entryStack } = get();
    const id = entryStack[entryStack.length - 1];
    if (!id) return;
    await voidFinish(db, id);
    set((state) => {
      const finishes = state.finishes.map((f) => (f.id === id ? { ...f, voided: 1 as const, synced: 0 as const } : f));
      return {
        finishes,
        unassigned: buildQueue(state.timestamps, finishes),
        entryStack: state.entryStack.slice(0, -1),
      };
    });
  },

  skipQueueHead: async (db) => {
    const head = get().unassigned[0];
    if (!head) return;
    for (const tapId of head.tapIds) await voidTimestamp(db, tapId);
    set((state) => {
      const timestamps = state.timestamps.map((t) =>
        head.tapIds.includes(t.id) ? { ...t, voided: 1 as const, synced: 0 as const } : t,
      );
      return { timestamps, unassigned: buildQueue(timestamps, state.finishes) };
    });
  },

  refreshData: async (db) => {
    const { activeRace } = get();
    if (!activeRace) return;
    const [race, event, timestamps, finishes, participants] = await Promise.all([
      getRace(db, activeRace.id),
      getEventForRace(db, activeRace.id),
      getTimestampsByRace(db, activeRace.id),
      getFinishesByRace(db, activeRace.id),
      getParticipantsByRace(db, activeRace.id),
    ]);
    set((state) => ({
      // Keep a start_time this device already holds even if the read raced a
      // write; the DB is the source of truth otherwise.
      activeRace: race ? { ...race, start_time: race.start_time ?? state.activeRace?.start_time ?? null } : state.activeRace,
      event: event ?? state.event,
      timestamps,
      finishes,
      participants,
      unassigned: buildQueue(timestamps, finishes),
    }));
  },
}));
