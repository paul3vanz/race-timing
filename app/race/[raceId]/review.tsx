import { File, Paths } from 'expo-file-system';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useSQLiteContext } from 'expo-sqlite';
import Papa from 'papaparse';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { BibEditSheet, type SheetAction } from '@/components/bib-edit-sheet';
import { DeviceActivityStrip, ResultRowView, type EditTarget } from '@/components/reconcile-row';
import { useRaceSync } from '@/hooks/use-race-sync';
import {
  assignBibToTimestamp,
  getEventForRace,
  getFinishesByRace,
  getParticipantsByRace,
  getRace,
  getTimestampsByRace,
  insertManualTimestamp,
  linkFinishToTimestamp,
  markFinishDuplicate,
  relinkFinishes,
  updateFinishBib,
  voidFinish,
  voidTimestamp,
  participantDisplayName,
  type Event,
  type Finish,
  type Participant,
  type Race,
  type Timestamp,
} from '@/lib/db';
import { formatGunTime, formatGunTimeTenths } from '@/lib/format';
import { buildResultsView, planRelinkInOrder } from '@/lib/merge';
import { TAP_CLUSTER_WINDOW_MS, type CanonicalBibEntry, type CanonicalTap, type ReconciledPair } from '@/lib/reconcile';
import { useRaceStore } from '@/lib/store';

// ── CSV ───────────────────────────────────────────────────────────────────────

function buildCsv(
  finishers: { bib: string; time: number }[],
  participants: Participant[],
): string {
  const byBib = new Map(participants.map((p) => [p.bib_number, p]));
  return Papa.unparse({
    fields: ['Position', 'Bib', 'Name', 'Club', 'Gender', 'Category', 'Gun Time'],
    data: finishers.map((f, i) => {
      const p = byBib.get(f.bib);
      return [
        i + 1,
        f.bib,
        p ? participantDisplayName(p) : '',
        p?.club ?? '',
        p?.gender ?? '',
        p?.category ?? '',
        formatGunTime(f.time),
      ];
    }),
  });
}

async function exportCsv(raceName: string, csv: string) {
  const slug = raceName.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const file = new File(Paths.document, `${slug}-results.csv`);
  file.write(csv);

  const canShare = await Sharing.isAvailableAsync();
  if (canShare) {
    await Sharing.shareAsync(file.uri, {
      mimeType: 'text/csv',
      dialogTitle: 'Export Results',
      UTI: 'public.comma-separated-values-text',
    });
  } else {
    Alert.alert('Saved', `Results saved to:\n${file.uri}`);
  }
}

// ── Screen ────────────────────────────────────────────────────────────────────

type Sheet = { kind: 'edit'; target: EditTarget } | { kind: 'assign'; tap: CanonicalTap } | null;

export default function ReviewScreen() {
  const { raceId } = useLocalSearchParams<{ raceId: string }>();
  const db = useSQLiteContext();
  const router = useRouter();
  const deviceId = useRaceStore((s) => s.deviceId);

  const [race, setRace] = useState<Race | null>(null);
  const [event, setEvent] = useState<Event | null>(null);
  const [taps, setTaps] = useState<Timestamp[]>([]);
  const [finishes, setFinishes] = useState<Finish[]>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [sheet, setSheet] = useState<Sheet>(null);

  // Everything on this screen is derived from the raw rows of ALL devices
  // (pulled from Supabase), not from whichever device this happens to be, so a
  // third phone can watch results and fix bibs typed on another.
  const load = useCallback(async () => {
    const [r, e, t, f, p] = await Promise.all([
      getRace(db, raceId),
      getEventForRace(db, raceId),
      getTimestampsByRace(db, raceId),
      getFinishesByRace(db, raceId),
      getParticipantsByRace(db, raceId),
    ]);
    setRace(r);
    setEvent(e);
    setTaps(t);
    setFinishes(f);
    setParticipants(p);
  }, [db, raceId]);

  useEffect(() => { load(); }, [load]);

  // Live: push this device's edits, pull everyone else's, every few seconds.
  const sync = useRaceSync(raceId, load);

  const startTime = race?.start_time ?? null;
  const view = useMemo(
    () => buildResultsView({ taps, finishes, participants, startTime, thisDeviceId: deviceId }),
    [taps, finishes, participants, startTime, deviceId],
  );

  const bibPositions = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const row of view.rows) {
      let bib: string | null = null;
      if (row.kind === 'finisher') bib = row.finish.bib_number;
      else if (row.kind === 'proposed') bib = row.pair.bib.bibNumber;
      else if (row.kind === 'gap-bib') bib = row.bib.bibNumber;
      else if (row.kind === 'disagreement') bib = row.entry.bibNumber;
      if (bib && row.position !== null) map.set(bib, [...(map.get(bib) ?? []), row.position]);
    }
    return map;
  }, [view.rows]);

  const confidentPairs = view.proposal.pairs.filter((p) => !p.flagged);
  const relinkPlan = useMemo(
    () => planRelinkInOrder(view.model, startTime ?? 0),
    [view.model, startTime],
  );
  const tapCount = view.model.clusters.length;
  const bibCount = view.finishers.length;
  const countsDiffer = tapCount > 0 && bibCount > 0 && tapCount !== bibCount;

  // ── Edit actions (every one writes SQLite first, then syncs) ────────────────

  const run = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (e) {
      Alert.alert('Could not save', e instanceof Error ? e.message : String(e));
    }
    await load();
    sync.syncNow();
  };

  const handleSaveBib = (target: EditTarget, bib: string) => {
    setSheet(null);
    run(() => updateFinishBib(db, target.finishId, bib));
  };

  const handleRemoveEntry = (target: EditTarget) => {
    Alert.alert(
      `Remove bib ${target.bib}?`,
      'The entry is taken out of the results. Its Timer tap stays, so it will show as a tap with no bib.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            setSheet(null);
            run(() => voidFinish(db, target.finishId));
          },
        },
      ],
    );
  };

  const discardTapIds = (tapIds: string[]) => run(async () => {
    for (const id of tapIds) await voidTimestamp(db, id);
  });

  const handleDiscardTapForRow = (target: EditTarget) => {
    if (!target.tapIds) return;
    const ids = target.tapIds;
    Alert.alert(
      'Discard this tap?',
      `Use this for a stray press with no runner. Bib ${target.bib} stays in the results but loses its time, then you can re-match bibs to taps in order.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Discard tap',
          style: 'destructive',
          onPress: () => {
            setSheet(null);
            discardTapIds(ids);
          },
        },
      ],
    );
  };

  const handleDiscardTap = (tap: CanonicalTap) => discardTapIds(tap.sourceIds);

  // A finisher both Timers missed: add a tap halfway between the neighbouring
  // finishers (or just before this one when it's first), then "re-match in
  // order" slides the bibs onto the right times.
  const handleInsertMissedTapBefore = (target: EditTarget) => {
    if (!race?.start_time || !deviceId) return;
    const start = race.start_time;
    const earlier = view.rows
      .filter((r) => r.position !== null && r.time < target.time)
      .map((r) => r.time);
    const prev = earlier.length > 0 ? Math.max(...earlier) : null;
    const at = prev === null ? target.time - 1000 : Math.round((prev + target.time) / 2);
    setSheet(null);
    run(async () => {
      await insertManualTimestamp(db, race.id, start + at, deviceId);
    });
  };

  const handleAssignBibToTap = (tap: CanonicalTap, bibNumber: string) => {
    if (!race?.start_time || !deviceId) return;
    const start = race.start_time;
    setSheet(null);
    run(async () => {
      await assignBibToTimestamp(db, race.id, bibNumber, tap.sourceIds[0], tap.time - start, deviceId);
    });
  };

  const commitPair = async (pair: ReconciledPair) => {
    if (!race) return;
    const canonicalTapId = pair.tap.sourceIds[0];
    const canonicalFinishId = pair.bib.sourceIds[0];
    await linkFinishToTimestamp(db, canonicalFinishId, canonicalTapId, pair.tap.time - (race.start_time ?? 0), pair.flagged);
    for (const dupId of pair.bib.sourceIds.slice(1)) await markFinishDuplicate(db, dupId, canonicalFinishId);
  };

  const handleConfirmAllConfident = () =>
    run(async () => {
      for (const pair of confidentPairs) await commitPair(pair);
    });

  const handleConfirmPair = (pair: ReconciledPair) => run(() => commitPair(pair));

  const handleInsertTapForBib = (bib: CanonicalBibEntry) => {
    if (!race || !deviceId) return;
    const raceStart = race.start_time ?? 0;
    run(async () => {
      const recordedAt = Math.round(bib.time);
      const ts = await insertManualTimestamp(db, race.id, recordedAt, deviceId);
      await linkFinishToTimestamp(db, bib.sourceIds[0], ts.id, recordedAt - raceStart, false);
      for (const dupId of bib.sourceIds.slice(1)) await markFinishDuplicate(db, dupId, bib.sourceIds[0]);
    });
  };

  const handleMatchBibToTap = (bib: CanonicalBibEntry, tap: CanonicalTap) =>
    run(() => commitPair({ tap, bib, flagged: false }));

  const handleResolveDisagreement = (entry: CanonicalBibEntry, chosenBibNumber: string) =>
    run(async () => {
      const groups = [{ bibNumber: entry.bibNumber, sourceIds: entry.sourceIds }, ...(entry.disagreement ?? [])];
      const winner = groups.find((g) => g.bibNumber === chosenBibNumber);
      if (!winner) return;
      const winnerId = winner.sourceIds[0];
      for (const g of groups) {
        for (const id of g.sourceIds) {
          if (id !== winnerId) await markFinishDuplicate(db, id, winnerId);
        }
      }
    });

  const handleRelink = () => {
    if (!relinkPlan.ok) return;
    const { links } = relinkPlan;
    if (links.length === 0) {
      Alert.alert('Already in order', 'Every bib is already matched to the tap in its place in the order.');
      return;
    }
    Alert.alert(
      'Re-match bibs to taps in order?',
      `The ${bibCount} bibs and ${tapCount} taps line up one to one. This moves ${links.length} bib${links.length === 1 ? '' : 's'} onto the tap in the same position in the order, keeping every bib number exactly as typed.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Re-match', onPress: () => run(() => relinkFinishes(db, links)) },
      ],
    );
  };

  const handleExport = async () => {
    if (view.finishers.length === 0) {
      Alert.alert('Nothing to export', 'Assign some bibs first.');
      return;
    }
    try {
      await exportCsv(race?.name ?? 'race', buildCsv(view.finishers, participants));
    } catch (e) {
      Alert.alert('Export failed', String(e));
    }
  };

  // ── Sheet content ───────────────────────────────────────────────────────────

  let sheetProps: React.ComponentProps<typeof BibEditSheet> | null = null;
  if (sheet?.kind === 'edit') {
    const t = sheet.target;
    const actions: SheetAction[] = [];
    if (t.tapIds) {
      actions.push({ label: 'Missed tap before this', onPress: () => handleInsertMissedTapBefore(t) });
      actions.push({ label: 'Discard tap', destructive: true, onPress: () => handleDiscardTapForRow(t) });
    }
    actions.push({ label: 'Remove entry', destructive: true, onPress: () => handleRemoveEntry(t) });
    sheetProps = {
      visible: true,
      title: `Position ${t.position ?? '?'} at ${formatGunTimeTenths(t.time)}`,
      subtitle: 'Correct the bib number for this finisher',
      initialBib: t.bib,
      participants,
      bibPositions,
      ownPosition: t.position,
      actions,
      onSave: (bib) => handleSaveBib(t, bib),
      onCancel: () => setSheet(null),
    };
  } else if (sheet?.kind === 'assign') {
    const tap = sheet.tap;
    sheetProps = {
      visible: true,
      title: `Add a bib for the tap at ${formatGunTimeTenths(tap.time - (startTime ?? 0))}`,
      initialBib: '',
      saveLabel: 'Add bib',
      participants,
      bibPositions,
      ownPosition: null,
      onSave: (bib) => handleAssignBibToTap(tap, bib),
      onCancel: () => setSheet(null),
    };
  }

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = async () => {
    setRefreshing(true);
    await sync.syncNow();
    await load();
    setRefreshing(false);
  };

  const finished = event?.status === 'finished';

  return (
    <>
      <Stack.Screen
        options={{
          title: race?.name ?? 'Results',
          headerStyle: { backgroundColor: '#0d0d0d' },
          headerTintColor: '#fff',
          headerRight: () => (
            <View style={styles.headerButtons}>
              <Pressable onPress={() => router.push(`/race/${raceId}/report`)} style={styles.headerBtn}>
                <Text style={styles.headerBtnText}>Prizes</Text>
              </Pressable>
              <Pressable onPress={handleExport} style={styles.headerBtn}>
                <Text style={styles.headerBtnText}>Export CSV</Text>
              </Pressable>
            </View>
          ),
        }}
      />

      <FlatList
        style={styles.list}
        data={view.rows}
        keyExtractor={(item) => item.key}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#fff" />}
        ListHeaderComponent={
          <View>
            <View style={styles.summary}>
              <Text style={styles.summaryText}>
                {bibCount} {bibCount === 1 ? 'finisher' : 'finishers'}
              </Text>
              {view.needsReview > 0 && <Text style={styles.summaryGaps}>{view.needsReview} need review</Text>}
              <Text style={styles.syncStatus} numberOfLines={1}>
                {finished ? 'Race finished' : sync.configured ? (sync.error ? 'Sync problem' : sync.online ? 'Live' : 'Offline') : 'This device only'}
              </Text>
            </View>

            {sync.error ? <Text style={styles.syncError}>{sync.error}</Text> : null}

            <DeviceActivityStrip devices={view.devices} />

            {view.timerDevices > 1 && (
              <Text style={styles.caption}>
                Taps within {(TAP_CLUSTER_WINDOW_MS / 1000).toFixed(1)}s on different timers count as one finisher.
                Timers that did not tap are struck through.
              </Text>
            )}

            {countsDiffer && (
              <View style={styles.countsBox}>
                <Text style={styles.countsTitle}>
                  {bibCount} bibs but {tapCount} taps
                </Text>
                <Text style={styles.countsText}>
                  Discard stray taps or add missed ones until the numbers match, then bibs can be re-matched to taps in order.
                </Text>
              </View>
            )}

            {relinkPlan.ok && relinkPlan.links.length > 0 && (
              <Pressable style={styles.relinkBtn} onPress={handleRelink}>
                <Text style={styles.relinkBtnText}>
                  Re-match {relinkPlan.links.length} bib{relinkPlan.links.length === 1 ? '' : 's'} to taps in order
                </Text>
              </Pressable>
            )}

            {confidentPairs.length > 0 && (
              <Pressable style={styles.confirmAllBtn} onPress={handleConfirmAllConfident}>
                <Text style={styles.confirmAllBtnText}>
                  Confirm all {confidentPairs.length} confident match{confidentPairs.length === 1 ? '' : 'es'}
                </Text>
              </Pressable>
            )}
          </View>
        }
        ListEmptyComponent={<Text style={styles.empty}>No results recorded yet.</Text>}
        renderItem={({ item }) => (
          <ResultRowView
            row={item}
            nearbyTaps={view.proposal.unmatchedTaps}
            onEdit={(target) => setSheet({ kind: 'edit', target })}
            onAssignTap={(tap) => setSheet({ kind: 'assign', tap })}
            onDiscardTap={handleDiscardTap}
            onConfirmPair={handleConfirmPair}
            onInsertTapForBib={handleInsertTapForBib}
            onMatchBibToTap={handleMatchBibToTap}
            onResolveDisagreement={handleResolveDisagreement}
          />
        )}
      />

      {sheetProps && <BibEditSheet {...sheetProps} />}
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  list: {
    flex: 1,
    backgroundColor: '#0d0d0d',
  },
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  summaryText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  summaryGaps: {
    color: '#f59e0b',
    fontSize: 15,
    fontWeight: '600',
  },
  syncStatus: {
    flex: 1,
    textAlign: 'right',
    color: '#4caf50',
    fontSize: 12,
    fontWeight: '600',
  },
  syncError: {
    color: '#f59e0b',
    fontSize: 12,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  caption: {
    color: '#555',
    fontSize: 11,
    paddingHorizontal: 16,
    paddingBottom: 6,
  },
  countsBox: {
    marginHorizontal: 16,
    marginTop: 6,
    marginBottom: 8,
    backgroundColor: '#1a1400',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#5c4a10',
    padding: 12,
    gap: 4,
  },
  countsTitle: {
    color: '#f59e0b',
    fontSize: 14,
    fontWeight: '700',
  },
  countsText: {
    color: '#a78a3a',
    fontSize: 12,
    lineHeight: 17,
  },
  relinkBtn: {
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: '#1a237e',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
  },
  relinkBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  confirmAllBtn: {
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: '#1b5e20',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
  },
  confirmAllBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  empty: {
    color: '#444',
    fontSize: 16,
    textAlign: 'center',
    marginTop: 60,
  },
  headerButtons: {
    flexDirection: 'row',
    gap: 8,
    marginRight: 4,
  },
  headerBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#1b5e20',
    borderRadius: 8,
  },
  headerBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});
