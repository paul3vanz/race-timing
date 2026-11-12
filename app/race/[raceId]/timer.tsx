import * as Haptics from 'expo-haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { useRaceStartPoll } from '@/hooks/use-race-start-poll';
import { useVolumeKeyTap } from '@/hooks/use-volume-key-tap';
import { isActiveTap } from '@/lib/merge';
import { useRaceStore } from '@/lib/store';
import { pullRaceData } from '@/lib/sync';

// ── Formatting ────────────────────────────────────────────────────────────────

function formatElapsed(ms: number): string {
  const tenths = Math.floor(ms / 100) % 10;
  const totalSec = Math.floor(ms / 1000);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const hrs = Math.floor(totalMin / 60);
  return `${p2(hrs)}:${p2(min)}:${p2(sec)}.${tenths}`;
}

function p2(n: number) {
  return n.toString().padStart(2, '0');
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function TimerScreen() {
  const { raceId } = useLocalSearchParams<{ raceId: string }>();
  const db = useSQLiteContext();
  const router = useRouter();

  const activeRace = useRaceStore((s) => s.activeRace);
  const event = useRaceStore((s) => s.event);
  const deviceId = useRaceStore((s) => s.deviceId);
  const timestamps = useRaceStore((s) => s.timestamps);
  const setRaceStopped = useRaceStore((s) => s.setRaceStopped);
  const loadRace = useRaceStore((s) => s.loadRace);
  const clearActiveRace = useRaceStore((s) => s.clearActiveRace);
  const startRace = useRaceStore((s) => s.startRace);
  const recordTimestamp = useRaceStore((s) => s.recordTimestamp);
  const refreshData = useRaceStore((s) => s.refreshData);

  useRaceStartPoll(raceId);

  const [elapsed, setElapsed] = useState(0);
  const [flash, setFlash] = useState(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load race data + keep screen on for the lifetime of this screen
  useEffect(() => {
    if (raceId) {
      loadRace(db, raceId);
      // One-shot pull so this device sees other devices' taps/entries too —
      // not a recurring poll, see hooks/use-race-start-poll.ts for the one
      // field (start_time) that needs faster propagation.
      pullRaceData(db, raceId)
        .then(() => refreshData(db))
        .catch(() => {});
    }
    // A refused wake lock (browser preview, low-power mode) must not surface as
    // an unhandled rejection; the screen just may sleep.
    activateKeepAwakeAsync().catch(() => {});
    return () => {
      clearActiveRace();
      deactivateKeepAwake().catch(() => {});
    };
  }, [raceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Start/stop the 100ms clock tick when the race starts
  useEffect(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    if (!activeRace?.start_time) return;
    const t0 = activeRace.start_time;
    tickRef.current = setInterval(() => setElapsed(Date.now() - t0), 100);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [activeRace?.start_time]);

  const handleBack = () => {
    if (activeRace?.start_time) {
      Alert.alert(
        'Leave timer?',
        'The race is in progress. Recorded timestamps are saved, but you will stop capturing finishes until you come back.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Leave', style: 'destructive', onPress: () => router.back() },
        ],
      );
    } else {
      router.back();
    }
  };

  const stopped = event?.status === 'finished';
  const canTap = Boolean(activeRace?.start_time) && !stopped;

  // `capturedAt` is set when the press came from a hardware volume button
  // (stamped natively at the moment of the press); a screen tap leaves it out
  // and recordTimestamp reads Date.now() as its first line instead.
  const handleTap = (capturedAt?: number) => {
    if (!canTap) return;
    // Visual + haptic feedback fires immediately; DB write is fire-and-forget.
    setFlash(true);
    setTimeout(() => setFlash(false), 120);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    recordTimestamp(db, capturedAt);
  };

  // Volume buttons as tap buttons: tactile, work with wet or gloved hands, and
  // can't be triggered by raindrops on the glass. Only consumed while the race
  // is live, so they behave normally on the pre-start screen.
  const volumeKeysActive = useVolumeKeyTap(canTap, (at) => handleTap(at));

  // ── Loading ─────────────────────────────────────────────────────────────────

  if (!activeRace) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.loading}>
          <Pressable style={styles.backBtn} onPress={handleBack} hitSlop={12}>
            <Text style={styles.backBtnText}>‹ Back</Text>
          </Pressable>
          <ActivityIndicator color="#fff" size="large" />
        </View>
      </>
    );
  }

  // ── Derived display values ──────────────────────────────────────────────────

  const raceStarted = activeRace.start_time !== null;
  // This device's own taps. With two Timers each phone counts what it pressed;
  // the merged finisher list is on the Results screen.
  const ownTaps = timestamps.filter((t) => t.device_id === deviceId && isActiveTap(t));
  const count = ownTaps.length;
  const lastTs = ownTaps[count - 1];
  const lastTime =
    lastTs && activeRace.start_time
      ? formatElapsed(lastTs.recorded_at - activeRace.start_time)
      : null;

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <Pressable
        style={[styles.container, flash && styles.flash]}
        onPress={canTap ? () => handleTap() : undefined}
        android_disableSound
      >
        {/* Sits above the full-screen tap target so it can be pressed on its own,
            without being counted as a finish tap */}
        <Pressable style={styles.backBtn} onPress={handleBack} hitSlop={12}>
          <Text style={styles.backBtnText}>‹ Back</Text>
        </Pressable>

        {/* Running clock */}
        <Text style={styles.clock}>
          {raceStarted ? formatElapsed(elapsed) : '00:00:00.0'}
        </Text>

        {/* Central content changes pre/post start */}
        <View style={styles.centre}>
          {stopped ? (
            <View style={styles.preStart}>
              <Text style={styles.raceName}>Race stopped</Text>
              <Text style={styles.stoppedNote}>
                {count} {count === 1 ? 'tap' : 'taps'} recorded on this device.
              </Text>
              <Pressable style={styles.reopenBtn} onPress={() => setRaceStopped(db, false)}>
                <Text style={styles.reopenBtnText}>Reopen race</Text>
              </Pressable>
            </View>
          ) : raceStarted ? (
            <>
              <Text style={styles.count}>{count}</Text>
              <Text style={styles.countLabel}>
                {count === 1 ? 'tap' : 'taps'}
              </Text>
              {lastTime !== null && (
                <Text style={styles.lastTime}>last  {lastTime}</Text>
              )}
            </>
          ) : (
            <View style={styles.preStart}>
              <Text style={styles.raceName}>{activeRace.name}</Text>
              <Pressable style={styles.startBtn} onPress={() => startRace(db)}>
                <Text style={styles.startBtnText}>Start Race</Text>
              </Pressable>
            </View>
          )}
        </View>

        {/* Barely-visible tap hint — confirms to the operator the screen is live */}
        {canTap && (
          <Text style={styles.hint}>
            {volumeKeysActive ? 'tap anywhere or press a volume button to record' : 'tap anywhere to record'}
          </Text>
        )}
      </Pressable>
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const mono = Platform.select({ ios: 'ui-monospace', default: 'monospace' });

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    backgroundColor: '#0d0d0d',
    alignItems: 'center',
    justifyContent: 'center',
  },
  backBtn: {
    position: 'absolute',
    top: 16,
    left: 16,
    zIndex: 1,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  backBtnText: {
    color: '#3a3a3a',
    fontSize: 15,
    fontWeight: '500',
  },
  container: {
    flex: 1,
    backgroundColor: '#0d0d0d',
    paddingTop: 56,
    paddingBottom: 32,
    paddingHorizontal: 24,
  },
  flash: {
    // Brief green wash confirms the tap registered without obscuring the clock
    backgroundColor: '#0d2b12',
  },
  clock: {
    color: '#fff',
    fontFamily: mono,
    fontSize: 52,
    fontWeight: '200',
    textAlign: 'center',
    letterSpacing: 1,
  },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  count: {
    color: '#fff',
    fontFamily: mono,
    fontSize: 128,
    fontWeight: '800',
    lineHeight: 130,
  },
  countLabel: {
    color: '#444',
    fontSize: 22,
    marginTop: 2,
  },
  lastTime: {
    color: '#4caf50',
    fontFamily: mono,
    fontSize: 22,
    marginTop: 20,
  },
  preStart: {
    alignItems: 'center',
    gap: 40,
  },
  raceName: {
    color: '#666',
    fontSize: 20,
    textAlign: 'center',
  },
  startBtn: {
    backgroundColor: '#1b5e20',
    paddingVertical: 28,
    paddingHorizontal: 72,
    borderRadius: 20,
  },
  startBtnText: {
    color: '#fff',
    fontSize: 30,
    fontWeight: '700',
  },
  stoppedNote: {
    color: '#555',
    fontSize: 15,
    textAlign: 'center',
  },
  reopenBtn: {
    backgroundColor: '#1e1e1e',
    paddingVertical: 16,
    paddingHorizontal: 40,
    borderRadius: 14,
  },
  reopenBtnText: {
    color: '#aaa',
    fontSize: 17,
    fontWeight: '600',
  },
  hint: {
    color: '#2a2a2a',
    fontSize: 13,
    textAlign: 'center',
  },
});
