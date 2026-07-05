import NetInfo from '@react-native-community/netinfo';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useRef } from 'react';

import { countPending, pushPendingChanges } from '@/lib/sync';
import { isSupabaseConfigured } from '@/lib/supabase';
import { useSyncStore } from '@/lib/sync-store';

const SYNC_INTERVAL_MS = 20_000;

function isOnline(state: { isConnected: boolean | null; isInternetReachable: boolean | null }): boolean {
  return Boolean(state.isConnected && state.isInternetReachable !== false);
}

// Mounted once at the app root. Pushes unsynced rows to Supabase on a timer
// and immediately when connectivity comes back — never blocks the UI thread,
// any failure just gets retried on the next tick.
export function useSyncEngine() {
  const db = useSQLiteContext();
  const setOnline = useSyncStore((s) => s.setOnline);
  const setUnconfigured = useSyncStore((s) => s.setUnconfigured);
  const setPendingCount = useSyncStore((s) => s.setPendingCount);
  const syncStarted = useSyncStore((s) => s.syncStarted);
  const syncFinished = useSyncStore((s) => s.syncFinished);
  const syncingRef = useRef(false);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setUnconfigured();
      return;
    }

    const refreshPendingCount = () => {
      countPending(db).then(setPendingCount);
    };

    const runSync = async () => {
      if (syncingRef.current) return;
      syncingRef.current = true;
      syncStarted();
      const result = await pushPendingChanges(db);
      syncFinished(result);
      syncingRef.current = false;
      refreshPendingCount();
    };

    const tick = async () => {
      const net = await NetInfo.fetch();
      setOnline(isOnline(net));
      if (isOnline(net)) await runSync();
    };

    tick();
    refreshPendingCount();
    const interval = setInterval(tick, SYNC_INTERVAL_MS);

    const unsubscribe = NetInfo.addEventListener((state) => {
      const online = isOnline(state);
      setOnline(online);
      if (online) runSync();
    });

    return () => {
      clearInterval(interval);
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db]);
}
