import { create } from 'zustand';

export type SyncStatus = 'unconfigured' | 'offline' | 'syncing' | 'idle' | 'error';

interface SyncState {
  status: SyncStatus;
  pendingCount: number;
  lastSyncedAt: number | null;
  lastError: string | null;

  setOnline: (online: boolean) => void;
  setUnconfigured: () => void;
  setPendingCount: (count: number) => void;
  syncStarted: () => void;
  syncFinished: (result: { pushed: number; error: string | null }) => void;
}

export const useSyncStore = create<SyncState>((set, get) => ({
  status: 'idle',
  pendingCount: 0,
  lastSyncedAt: null,
  lastError: null,

  setOnline: (online) => {
    if (!online) set({ status: 'offline' });
    else if (get().status === 'offline') set({ status: 'idle' });
  },

  setUnconfigured: () => set({ status: 'unconfigured' }),

  setPendingCount: (pendingCount) => set({ pendingCount }),

  syncStarted: () => set({ status: 'syncing' }),

  syncFinished: (result) => {
    if (result.error) {
      set({ status: 'error', lastError: result.error });
    } else {
      set({ status: 'idle', lastError: null, lastSyncedAt: Date.now() });
    }
  },
}));
