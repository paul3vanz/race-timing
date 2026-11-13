import * as Haptics from 'expo-haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Numpad } from '@/components/numpad';
import { useRaceStartPoll } from '@/hooks/use-race-start-poll';
import { useRaceSync } from '@/hooks/use-race-sync';
import { participantDisplayName } from '@/lib/db';
import { isActiveFinish, isActiveTap, isManualDevice } from '@/lib/merge';
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
  const event = useRaceStore((s) => s.event);
  const timestamps = useRaceStore((s) => s.timestamps);
  const unassigned = useRaceStore((s) => s.unassigned);
  const entryStack = useRaceStore((s) => s.entryStack);
  const finishes = useRaceStore((s) => s.finishes);
  const participants = useRaceStore((s) => s.participants);
  const loadRace = useRaceStore((s) => s.loadRace);
  const clearActiveRace = useRaceStore((s) => s.clearActiveRace);
  const startRace = useRaceStore((s) => s.startRace);
  const assignBib = useRaceStore((s) => s.assignBib);
  const undoLastBib = useRaceStore((s) => s.undoLastBib);
  const skipQueueHead = useRaceStore((s) => s.skipQueueHead);
  const refreshData = useRaceStore((s) => s.refreshData);

  useRaceStartPoll(raceId);

  // The Timer phones' taps reach this device through Supabase, so keep pulling
  // for as long as the screen is open. The queue is rebuilt from whatever has
  // arrived; offline it just stays as it is and the bib entry carries on.
  const sync = useRaceSync(raceId, () => refreshData(db));

  const [bib, setBib] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  // Tick every 30 s so the stale-timestamp warning refreshes without user input
  const [, setTick] = useState(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const clockRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (raceId) loadRace(db, raceId);
    activateKeepAwakeAsync().catch(() => {});
    tickRef.current = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => {
      clearActiveRace();
      deactivateKeepAwake().catch(() => {});
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
    if (submitting || stopped) return;
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
    // A bib that already has a result is accepted, not blocked: the operator
    // keeps the queue moving and the Results screen flags both rows so the
    // wrong one (usually transposed digits) can be corrected there.
    const clash = finishes.find((f) => isActiveFinish(f) && f.bib_number === bibNumber);
    try {
      Haptics.notificationAsync(
        clash ? Haptics.NotificationFeedbackType.Warning : Haptics.NotificationFeedbackType.Success,
      );
      await assignBib(db, bibNumber);
      setNotice(clash ? `Bib ${bibNumber} was already entered. Both are flagged on Results.` : null);
    } catch (e) {
      setNotice(`Could not save bib ${bibNumber}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      // Always release the numpad, whatever happened above.
      setBib('');
      setSubmitting(false);
    }
  };

  const handleUndo = () => {
    setNotice(null);
    undoLastBib(db);
  };

  const handleSkipTap = () => {
    Alert.alert(
      'Skip this tap?',
      'Use this when a Timer recorded a press with no runner (a stray tap). The finisher after it moves up. It can be fixed later on Results.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Skip tap', style: 'destructive', onPress: () => skipQueueHead(db) },
      ],
    );
  };

  // ── Derived display values ──────────────────────────────────────────────────

  const current = unassigned[0] ?? null;
  const queueDepth = unassigned.length;
  const now = Date.now();
  const stopped = event?.status === 'finished';

  // Last 3 assigned bibs (any device), most recent first
  const activeFinishes = finishes.filter(isActiveFinish);
  const recentFinishes = activeFinishes.slice(-3).reverse();

  // How many Timer phones are feeding this race, so a tap only one of them
  // caught can be called out in amber.
  const timerCount = new Set(
    timestamps.filter((t) => isActiveTap(t) && !isManualDevice(t.device_id)).map((t) => t.device_id),
  ).size;

  const participantByBib = useMemo(
    () => new Map(participants.map((p) => [p.bib_number, p])),
    [participants],
  );

  const isStale = current ? now - current.time > STALE_MS : false;

  const gunTime =
    current && activeRace?.start_time ? formatGunTime(current.time - activeRace.start_time) : null;
  const partialCapture = current !== null && timerCount > 1 && current.deviceIds.length < timerCount;

  const waiting = !activeRace?.start_time || stopped;
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
            ) : stopped ? (
              <Text style={styles.waiting}>Race stopped. Reopen it from the Races list to keep entering bibs.</Text>
            ) : current ? (
              <>
                <Text style={[styles.seq, isStale && styles.textStale]}>
                  Finisher #{current.position}
                </Text>
                <Text style={[styles.gunTime, isStale && styles.textStale]}>
                  {gunTime}
                </Text>
                {timerCount > 1 && (
                  <Text style={partialCapture ? styles.staleWarning : styles.queue}>
                    {partialCapture
                      ? `Only ${current.deviceIds.length} of ${timerCount} timers caught this one`
                      : `Caught by all ${timerCount} timers`}
                  </Text>
                )}
                {queueDepth > 1 && (
                  <Text style={styles.queue}>
                    {queueDepth - 1} more waiting
                  </Text>
                )}
                {isStale && (
                  <Text style={styles.staleWarning}>
                    No bib for {Math.floor((now - current.time) / 60_000)} min, check finish order
                  </Text>
                )}
              </>
            ) : (
              <>
                <Text style={styles.seq}>Live entry</Text>
                <Text style={styles.gunTime}>{formatGunTime(elapsed)}</Text>
                <Text style={styles.queue}>
                  {timerCount > 0
                    ? 'No taps waiting. Bibs typed now are matched to taps on Results.'
                    : 'Type bib as each finisher crosses'}
                </Text>
              </>
            )}
          </View>

          {/* ── Queue tools + sync status ── */}
          <View style={styles.toolsRow}>
            {current && !stopped && (
              <Pressable style={styles.toolBtn} onPress={handleSkipTap} hitSlop={6}>
                <Text style={styles.toolBtnText}>Skip stray tap</Text>
              </Pressable>
            )}
            {entryStack.length > 0 && (
              <Pressable style={styles.toolBtn} onPress={handleUndo} hitSlop={6}>
                <Text style={styles.toolBtnText}>Undo last bib</Text>
              </Pressable>
            )}
            <Text style={[styles.syncText, sync.error ? styles.syncTextError : null]} numberOfLines={1}>
              {!sync.configured
                ? 'Local only'
                : sync.error
                  ? `Sync problem: ${sync.error}`
                  : !sync.online
                    ? 'Offline, keeps working'
                    : 'Live'}
            </Text>
          </View>
          {notice && <Text style={styles.notice}>{notice}</Text>}

          {/* ── Recent entries ── */}
          {recentFinishes.length > 0 && (
            <View style={styles.recent}>
              {recentFinishes.map((f) => {
                const pos = activeFinishes.indexOf(f) + 1;
                const participant = participantByBib.get(f.bib_number);
                return (
                  <View key={f.id} style={styles.recentRow}>
                    <Text style={styles.recentPos}>{pos}</Text>
                    <View style={styles.recentInfo}>
                      <Text style={styles.recentBib}>#{f.bib_number}</Text>
                      <Text style={participant ? styles.recentName : styles.recentNameUnknown}>
                        {participant ? participantDisplayName(participant) : 'Unregistered bib'}
                      </Text>
                    </View>
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
  toolsRow: {
    marginHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  toolBtn: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#333',
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  toolBtnText: {
    color: '#aaa',
    fontSize: 12,
    fontWeight: '600',
  },
  syncText: {
    flex: 1,
    textAlign: 'right',
    color: '#444',
    fontSize: 11,
  },
  syncTextError: {
    color: '#f59e0b',
  },
  notice: {
    marginHorizontal: 16,
    color: '#f59e0b',
    fontSize: 13,
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
  recentInfo: {
    flex: 1,
    gap: 1,
  },
  recentBib: {
    color: '#fff',
    fontFamily: mono,
    fontSize: 15,
    fontWeight: '600',
  },
  recentName: {
    color: '#777',
    fontSize: 12,
  },
  recentNameUnknown: {
    color: '#f59e0b',
    fontSize: 12,
  },
  recentTime: {
    color: '#555',
    fontFamily: mono,
    fontSize: 13,
  },
});
