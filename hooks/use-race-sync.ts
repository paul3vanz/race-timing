import NetInfo from '@react-native-community/netinfo';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useRef, useState } from 'react';

import { isSupabaseConfigured } from '@/lib/supabase';
import { syncRaceNow } from '@/lib/sync';

const DEFAULT_INTERVAL_MS = 8_000;

export interface RaceSyncState {
  syncing: boolean;
  lastSyncedAt: number | null;
  error: string | null;
  online: boolean;
  configured: boolean;
  syncNow: () => Promise<void>;
}

function isOnline(state: { isConnected: boolean | null; isInternetReachable: boolean | null }): boolean {
  return Boolean(state.isConnected && state.isInternetReachable !== false);
}

// Keeps a screen live while other devices are working on the same race: every
// few seconds it pushes this device's changes, pulls everyone else's, then
// calls onSynced so the screen re-reads SQLite. Used by the Bib screen (to
// see new Timer taps) and the Results screen (to watch a race in progress and
// see corrections made elsewhere). Does nothing when Supabase isn't
// configured or the device is offline, and never throws: the screens keep
// working off local data regardless.
export function useRaceSync(
  raceId: string | undefined,
  onSynced: () => void | Promise<void>,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): RaceSyncState {
  const db = useSQLiteContext();
  const [syncing, setSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);

  const busyRef = useRef(false);
  const onSyncedRef = useRef(onSynced);
  onSyncedRef.current = onSynced;

  const syncNow = useCallback(async () => {
    if (!raceId || !isSupabaseConfigured || busyRef.current) return;
    busyRef.current = true;
    setSyncing(true);
    try {
      const net = await NetInfo.fetch();
      const up = isOnline(net);
      setOnline(up);
      if (!up) return;
      const result = await syncRaceNow(db, raceId);
      setError(result.error);
      if (!result.error) setLastSyncedAt(Date.now());
      await onSyncedRef.current();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setSyncing(false);
    }
  }, [db, raceId]);

  useEffect(() => {
    if (!raceId || !isSupabaseConfigured) return;
    syncNow();
    const interval = setInterval(syncNow, intervalMs);
    return () => clearInterval(interval);
  }, [raceId, intervalMs, syncNow]);

  return { syncing, lastSyncedAt, error, online, configured: isSupabaseConfigured, syncNow };
}
