import * as Haptics from 'expo-haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Numpad } from '@/components/numpad';
import { useRaceStore } from '@/lib/store';

// Fallback used before race data is loaded
const DEFAULT_BIB_DIGITS = 3;

// Warn if a timestamp has been unassigned for longer than this
const STALE_MS = 5 * 60 * 1000;

// ── Formatting ────────────────────────────────────────────────────────────────

function formatGunTime(ms: number): string {
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

export default function BibScreen() {
  const { raceId } = useLocalSearchParams<{ raceId: string }>();
  const db = useSQLiteContext();

  const activeRace = useRaceStore((s) => s.activeRace);
  const unassigned = useRaceStore((s) => s.unassigned);
  const finishes = useRaceStore((s) => s.finishes);
  const loadRace = useRaceStore((s) => s.loadRace);
  const clearActiveRace = useRaceStore((s) => s.clearActiveRace);
  const startRace = useRaceStore((s) => s.startRace);
  const assignBib = useRaceStore((s) => s.assignBib);

  const [bib, setBib] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  // Tick every 30 s so the stale-timestamp warning refreshes without user input
  const [, setTick] = useState(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const clockRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (raceId) loadRace(db, raceId);
    activateKeepAwakeAsync();
    tickRef.current = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => {
      clearActiveRace();
      deactivateKeepAwake();
      if (tickRef.current) clearInterval(tickRef.current);
      if (clockRef.current) clearInterval(clockRef.current);
    };
  }, [raceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 1-second clock for direct-entry mode
  useEffect(() => {
    if (clockRef.current) clearInterval(clockRef.current);
    if (!activeRace?.start_time) return;
    const t0 = activeRace.start_time;
    clockRef.current = setInterval(() => setElapsed(Date.now() - t0), 1000);
    return () => { if (clockRef.current) clearInterval(clockRef.current); };
  }, [activeRace?.start_time]);

  // ── Input handling ──────────────────────────────────────────────────────────

  const handleDigit = (d: string) => {
    if (submitting) return;
    const next = bib + d;
    setBib(next);
    if (next.length >= bibDigits) {
      submit(next);
    }
  };

  const handleDelete = () => {
    if (submitting) return;
    setBib((b) => b.slice(0, -1));
  };

  const handleConfirm = () => {
    if (bib.length > 0) submit(bib);
  };

  const submit = async (bibNumber: string) => {
    if (!activeRace?.start_time) return;
    setSubmitting(true);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await assignBib(db, bibNumber);
    setBib('');
    setSubmitting(false);
  };

  // ── Derived display values ──────────────────────────────────────────────────

  const current = unassigned[0] ?? null;
  const queueDepth = unassigned.length;
  const now = Date.now();

  // Last 3 assigned bibs, most recent first
  const recentFinishes = finishes.slice(-3).reverse();

  const isStale = current ? now - current.recorded_at > STALE_MS : false;

  const gunTime =
    current && activeRace?.start_time
      ? formatGunTime(current.recorded_at - activeRace.start_time)
      : null;

  const waiting = !activeRace?.start_time;
  const bibDigits = activeRace ? activeRace.max_bib.toString().length : DEFAULT_BIB_DIGITS;

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
      <Stack.Screen options={{ title: activeRace?.name ?? 'Bib Entry', headerShown: true }} />
      <View style={styles.container}>

        {/* Scrolls/shrinks under pressure instead of pushing the numpad below
            up over the bib digits — the digits and keys must always be
            fully visible while the info above them varies in height. */}
        <ScrollView
          style={styles.infoScroll}
          contentContainerStyle={styles.infoScrollContent}
          showsVerticalScrollIndicator={false}
        >
          {/* ── Timestamp card ── */}
          <View style={[styles.card, isStale && styles.cardStale]}>
            {!activeRace?.start_time ? (
              <View style={styles.notStarted}>
                <Text style={styles.waiting}>Race not started</Text>
                <Pressable style={styles.startBtn} onPress={() => startRace(db)}>
                  <Text style={styles.startBtnText}>Start Race</Text>
                </Pressable>
              </View>
            ) : current ? (
              <>
                <Text style={[styles.seq, isStale && styles.textStale]}>
                  Finisher #{current.sequence_num}
                </Text>
                <Text style={[styles.gunTime, isStale && styles.textStale]}>
                  {gunTime}
                </Text>
                {queueDepth > 1 && (
                  <Text style={styles.queue}>
                    {queueDepth - 1} more waiting
                  </Text>
                )}
                {isStale && (
                  <Text style={styles.staleWarning}>
                    No bib for {Math.floor((now - current.recorded_at) / 60_000)} min — check finish order
                  </Text>
                )}
              </>
            ) : (
              <>
                <Text style={styles.seq}>Live entry</Text>
                <Text style={styles.gunTime}>{formatGunTime(elapsed)}</Text>
                <Text style={styles.queue}>Type bib as each finisher crosses</Text>
              </>
            )}
          </View>

          {/* ── Recent entries ── */}
          {recentFinishes.length > 0 && (
            <View style={styles.recent}>
              {recentFinishes.map((f) => {
                const pos = finishes.indexOf(f) + 1;
                return (
                  <View key={f.id} style={styles.recentRow}>
                    <Text style={styles.recentPos}>{pos}</Text>
                    <Text style={styles.recentBib}>#{f.bib_number}</Text>
                    <Text style={styles.recentTime}>{formatGunTime(f.gun_time ?? 0)}</Text>
                  </View>
                );
              })}
            </View>
          )}
        </ScrollView>

        {/* ── Bib digit display ── */}
        <View style={styles.bibRow}>
          {Array.from({ length: bibDigits }).map((_, i) => (
            <View
              key={i}
              style={[styles.bibBox, bib[i] !== undefined && styles.bibBoxFilled]}
            >
              <Text style={styles.bibDigit}>{bib[i] ?? ''}</Text>
            </View>
          ))}
        </View>

        {/* ── Numpad ── */}
        <Numpad
          onDigit={handleDigit}
          onDelete={handleDelete}
          onConfirm={handleConfirm}
          canConfirm={bib.length > 0}
          disabled={waiting || submitting}
        />

      </View>
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const mono = Platform.select({ ios: 'ui-monospace', default: 'monospace' });

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0d0d0d',
    paddingTop: 16,
    paddingBottom: 24,
    gap: 16,
  },
  infoScroll: {
    flex: 1,
  },
  infoScrollContent: {
    gap: 20,
  },
  card: {
    marginHorizontal: 16,
    backgroundColor: '#1a1a1a',
    borderRadius: 16,
    padding: 20,
    gap: 6,
  },
  cardStale: {
    backgroundColor: '#2b1f00',
    borderWidth: 1,
    borderColor: '#f59e0b',
  },
  seq: {
    color: '#888',
    fontSize: 14,
    fontWeight: '500',
  },
  gunTime: {
    color: '#fff',
    fontFamily: mono,
    fontSize: 42,
    fontWeight: '300',
  },
  queue: {
    color: '#555',
    fontSize: 13,
    marginTop: 4,
  },
  staleWarning: {
    color: '#f59e0b',
    fontSize: 13,
    marginTop: 6,
  },
  textStale: {
    color: '#f59e0b',
  },
  notStarted: {
    alignItems: 'center',
    gap: 16,
    paddingVertical: 4,
  },
  startBtn: {
    backgroundColor: '#1b5e20',
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: 12,
  },
  startBtnText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  waiting: {
    color: '#666',
    fontSize: 16,
    textAlign: 'center',
  },
  bibRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 16,
  },
  bibBox: {
    width: 64,
    height: 72,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#333',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1a1a1a',
  },
  bibBoxFilled: {
    borderColor: '#4caf50',
    backgroundColor: '#0d1f10',
  },
  bibDigit: {
    color: '#fff',
    fontFamily: mono,
    fontSize: 36,
    fontWeight: '700',
  },
  recent: {
    marginHorizontal: 16,
    borderRadius: 12,
    backgroundColor: '#111',
    overflow: 'hidden',
  },
  recentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  recentPos: {
    color: '#4caf50',
    fontFamily: mono,
    fontSize: 13,
    fontWeight: '700',
    width: 28,
    textAlign: 'right',
  },
  recentBib: {
    color: '#fff',
    fontFamily: mono,
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
  },
  recentTime: {
    color: '#555',
    fontFamily: mono,
    fontSize: 13,
  },
});
