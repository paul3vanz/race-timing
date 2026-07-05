import NetInfo from '@react-native-community/netinfo';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useRef } from 'react';

import { useRaceStore } from '@/lib/store';
import { pullRaceStartTime } from '@/lib/sync';
import { isSupabaseConfigured } from '@/lib/supabase';

const POLL_INTERVAL_MS = 7_000;

function isOnline(state: { isConnected: boolean | null; isInternetReachable: boolean | null }): boolean {
  return Boolean(state.isConnected && state.isInternetReachable !== false);
}

// Polls for a race's start_time while this device hasn't started it locally
// and another device might have. Stops the instant a start_time appears (the
// effect re-runs and its early-return skips scheduling a new interval), so
// this fast loop only ever runs during the brief pre-race waiting window,
// not for the rest of the race.
export function useRaceStartPoll(raceId: string | undefined) {
  const db = useSQLiteContext();
  const startTime = useRaceStore((s) => s.activeRace?.start_time ?? null);
  const adoptRemoteStartTime = useRaceStore((s) => s.adoptRemoteStartTime);
  const pollingRef = useRef(false);

  useEffect(() => {
    if (!raceId || startTime !== null || !isSupabaseConfigured) return;

    let cancelled = false;

    const tick = async () => {
      if (pollingRef.current) return;
      pollingRef.current = true;
      try {
        const net = await NetInfo.fetch();
        if (isOnline(net)) {
          const remoteStartTime = await pullRaceStartTime(raceId);
          if (!cancelled && remoteStartTime !== null) {
            await adoptRemoteStartTime(db, remoteStartTime);
          }
        }
      } catch {
        // Transient network/API error — just try again next tick.
      } finally {
        pollingRef.current = false;
      }
    };

    tick();
    const interval = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [raceId, startTime, db, adoptRemoteStartTime]);
}
