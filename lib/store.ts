import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import type { SQLiteDatabase } from 'expo-sqlite';
import { Platform } from 'react-native';
import { create } from 'zustand';

import {
  assignBibToTimestamp,
  getFinishesByRace,
  getParticipantsByRace,
  getRace,
  getTimestampsByRace,
  getUnassignedTimestamps,
  recordDirectFinish,
  recordTimestamp as dbRecordTimestamp,
  setRaceStartTime,
  type Finish,
  type Participant,
  type Race,
  type Timestamp,
} from './db';
import { startRaceRemote } from './sync';

// ── Types ─────────────────────────────────────────────────────────────────────

interface RaceStore {
  // Persisted across launches
  deviceId: string | null;

  // Active race context — set when a race screen is opened
  activeRace: Race | null;

  // In-memory mirrors of the DB for the active race
  timestamps: Timestamp[];  // all timestamps, ordered by sequence_num
  unassigned: Timestamp[];  // timestamps with no finish record yet
  finishes: Finish[];       // completed finish records, ordered by gun_time
  participants: Participant[]; // full roster, for bib -> name lookups

  // ── Actions ─────────────────────────────────────────────────────────────────

  // Call once at app startup before rendering race screens
  initDeviceId: () => Promise<void>;

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

  // Hot path: capture Date.now() immediately, write async, update store
  recordTimestamp: (db: SQLiteDatabase) => Promise<Timestamp | null>;

  // Assign a bib to the next unassigned timestamp in sequence
  assignBib: (db: SQLiteDatabase, bibNumber: string) => Promise<Finish | null>;

  // Re-query the DB; call after returning from background or manual corrections
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

// ── Store ─────────────────────────────────────────────────────────────────────

export const useRaceStore = create<RaceStore>((set, get) => ({
  deviceId: null,
  activeRace: null,
  timestamps: [],
  unassigned: [],
  finishes: [],
  participants: [],

  initDeviceId: async () => {
    const deviceId = await resolveDeviceId();
    set({ deviceId });
  },

  loadRace: async (db, raceId) => {
    const [race, timestamps, unassigned, finishes, participants] = await Promise.all([
      getRace(db, raceId),
      getTimestampsByRace(db, raceId),
      getUnassignedTimestamps(db, raceId),
      getFinishesByRace(db, raceId),
      getParticipantsByRace(db, raceId),
    ]);
    set({ activeRace: race, timestamps, unassigned, finishes, participants });
  },

  clearActiveRace: () => {
    set({ activeRace: null, timestamps: [], unassigned: [], finishes: [], participants: [] });
  },

  startRace: async (db) => {
    const { activeRace } = get();
    if (!activeRace || activeRace.start_time !== null) return;
    const startTime = Date.now();
    await setRaceStartTime(db, activeRace.id, startTime);
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

  recordTimestamp: async (db) => {
    // Capture the time first — before any async work — to stay accurate.
    const recordedAt = Date.now();
    const { activeRace, deviceId } = get();
    if (!activeRace || !deviceId) return null;

    const ts = await dbRecordTimestamp(db, activeRace.id, deviceId, recordedAt);
    set((state) => ({
      timestamps: [...state.timestamps, ts],
      unassigned: [...state.unassigned, ts],
    }));
    return ts;
  },

  assignBib: async (db, bibNumber) => {
    const capturedAt = Date.now();
    const { activeRace, unassigned, deviceId } = get();
    if (!activeRace?.start_time || !deviceId) return null;

    let finish: Finish;
    if (unassigned.length > 0) {
      const next = unassigned[0];
      finish = await assignBibToTimestamp(db, activeRace.id, bibNumber, next, activeRace.start_time, deviceId);
      set((state) => ({
        unassigned: state.unassigned.slice(1),
        finishes: [...state.finishes, finish].sort((a, b) => (a.gun_time ?? 0) - (b.gun_time ?? 0)),
      }));
    } else {
      finish = await recordDirectFinish(db, activeRace.id, bibNumber, capturedAt - activeRace.start_time, deviceId);
      set((state) => ({
        finishes: [...state.finishes, finish].sort((a, b) => (a.gun_time ?? 0) - (b.gun_time ?? 0)),
      }));
    }
    return finish;
  },

  refreshData: async (db) => {
    const { activeRace } = get();
    if (!activeRace) return;
    const [timestamps, unassigned, finishes, participants] = await Promise.all([
      getTimestampsByRace(db, activeRace.id),
      getUnassignedTimestamps(db, activeRace.id),
      getFinishesByRace(db, activeRace.id),
      getParticipantsByRace(db, activeRace.id),
    ]);
    set({ timestamps, unassigned, finishes, participants });
  },
}));
