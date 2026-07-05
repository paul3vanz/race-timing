import { File, Paths } from 'expo-file-system';
import { Stack, useLocalSearchParams } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Platform, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { DeviceActivityStrip, DisagreementRow, FlaggedPairRow, UnmatchedBibRow, UnmatchedTapRow } from '@/components/reconcile-row';
import {
  assignBibToTimestamp,
  getDeviceActivity,
  getOrphanFinishes,
  getOrphanTimestamps,
  getRace,
  getReviewRows,
  insertManualTimestamp,
  linkFinishToTimestamp,
  markFinishDuplicate,
  markTimestampDuplicate,
  voidTimestamp,
  type DeviceActivity,
  type Finish,
  type Race,
  type ReviewRow,
  type Timestamp,
} from '@/lib/db';
import {
  alignFinishers,
  clusterBibEntries,
  clusterTimerTaps,
  type CanonicalBibEntry,
  type CanonicalTap,
  type ReconciledPair,
} from '@/lib/reconcile';
import { pullRaceData } from '@/lib/sync';
import { useRaceStore } from '@/lib/store';

// ── Formatting ────────────────────────────────────────────────────────────────

function formatGunTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const hrs = Math.floor(totalMin / 60);
  return hrs > 0
    ? `${p2(hrs)}:${p2(min)}:${p2(sec)}`
    : `${p2(min)}:${p2(sec)}`;
}

function p2(n: number) {
  return n.toString().padStart(2, '0');
}

// ── CSV ───────────────────────────────────────────────────────────────────────

function buildCsv(matched: ReviewRow[]): string {
  const lines = ['Position,Bib,Gun Time'];
  matched.forEach((row, i) => {
    lines.push(`${i + 1},${row.bib_number},${formatGunTime(row.gun_time ?? 0)}`);
  });
  return lines.join('\n');
}

async function exportCsv(raceName: string, matched: ReviewRow[]) {
  const csv = buildCsv(matched);
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

// ── Reconciliation proposal ───────────────────────────────────────────────────

interface Proposal {
  pairs: ReconciledPair[];
  unmatchedTaps: CanonicalTap[];
  unmatchedBibs: CanonicalBibEntry[]; // no disagreement — genuinely just missing a tap
  disagreements: CanonicalBibEntry[]; // devices reported different bib numbers
  tapById: Map<string, Timestamp>;
  finishById: Map<string, Finish>;
}

const EMPTY_PROPOSAL: Proposal = {
  pairs: [],
  unmatchedTaps: [],
  unmatchedBibs: [],
  disagreements: [],
  tapById: new Map(),
  finishById: new Map(),
};

async function buildProposal(
  db: ReturnType<typeof useSQLiteContext>,
  raceId: string,
  raceStartTime: number | null,
): Promise<Proposal> {
  const [rawTaps, rawFinishes] = await Promise.all([
    getOrphanTimestamps(db, raceId),
    getOrphanFinishes(db, raceId),
  ]);

  const tapById = new Map(rawTaps.map((t) => [t.id, t]));
  const finishById = new Map(rawFinishes.map((f) => [f.id, f]));

  const canonicalTaps = clusterTimerTaps(rawTaps.map((t) => ({ id: t.id, deviceId: t.device_id, time: t.recorded_at })));
  const canonicalBibs = clusterBibEntries(
    rawFinishes.map((f) => ({
      id: f.id,
      deviceId: f.device_id,
      bibNumber: f.bib_number,
      // Bring gun_time (race-relative) onto the same absolute clock basis as
      // tap.recorded_at, so the alignment cost function compares like with like.
      time: (raceStartTime ?? 0) + (f.gun_time ?? 0),
    })),
  );

  const { pairs, unmatchedTaps, unmatchedBibs } = alignFinishers(canonicalTaps, canonicalBibs);

  return {
    pairs,
    unmatchedTaps,
    unmatchedBibs: unmatchedBibs.filter((b) => b.disagreement === null),
    disagreements: canonicalBibs.filter((b) => b.disagreement !== null),
    tapById,
    finishById,
  };
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function ReviewScreen() {
  const { raceId } = useLocalSearchParams<{ raceId: string }>();
  const db = useSQLiteContext();
  const deviceId = useRaceStore((s) => s.deviceId);

  const [race, setRace] = useState<Race | null>(null);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [proposal, setProposal] = useState<Proposal>(EMPTY_PROPOSAL);
  const [deviceActivity, setDeviceActivity] = useState<DeviceActivity[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const r = await getRace(db, raceId);
    setRace(r);
    const [reviewRows, activity, nextProposal] = await Promise.all([
      getReviewRows(db, raceId),
      getDeviceActivity(db, raceId),
      buildProposal(db, raceId, r?.start_time ?? null),
    ]);
    setRows(reviewRows);
    setDeviceActivity(activity);
    setProposal(nextProposal);
  }, [db, raceId]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await pullRaceData(db, raceId);
    } catch (e) {
      Alert.alert('Sync failed', e instanceof Error ? e.message : String(e));
    }
    await load();
    setRefreshing(false);
  };

  // ── Derived ─────────────────────────────────────────────────────────────────

  const matched = [...rows.filter((r) => r.finish_id !== null)].sort(
    (a, b) => (a.gun_time ?? 0) - (b.gun_time ?? 0),
  );
  const positionMap = new Map(matched.map((r, i) => [r.finish_id, i + 1]));

  const confidentPairs = proposal.pairs.filter((p) => !p.flagged);
  const flaggedPairs = proposal.pairs.filter((p) => p.flagged);

  // ── Commit actions ────────────────────────────────────────────────────────

  const commitPair = async (pair: ReconciledPair) => {
    const canonicalTapId = pair.tap.sourceIds[0];
    const canonicalFinishId = pair.bib.sourceIds[0];
    const tapRow = proposal.tapById.get(canonicalTapId);
    if (!tapRow || !race) return;
    const gunTime = tapRow.recorded_at - (race.start_time ?? 0);
    await linkFinishToTimestamp(db, canonicalFinishId, canonicalTapId, gunTime, pair.flagged);
    for (const dupId of pair.tap.sourceIds.slice(1)) await markTimestampDuplicate(db, dupId, canonicalTapId);
    for (const dupId of pair.bib.sourceIds.slice(1)) await markFinishDuplicate(db, dupId, canonicalFinishId);
  };

  const handleConfirmAllConfident = async () => {
    for (const pair of confidentPairs) await commitPair(pair);
    await load();
  };

  const handleConfirmPair = async (pair: ReconciledPair) => {
    await commitPair(pair);
    await load();
  };

  const handleDiscardTap = async (tap: CanonicalTap) => {
    for (const id of tap.sourceIds) await voidTimestamp(db, id);
    await load();
  };

  const handleAssignBibToTap = async (tap: CanonicalTap, bibNumber: string) => {
    if (!race?.start_time || !deviceId) return;
    const canonicalId = tap.sourceIds[0];
    const tapRow = proposal.tapById.get(canonicalId);
    if (!tapRow) return;
    await assignBibToTimestamp(db, race.id, bibNumber, tapRow, race.start_time, deviceId);
    for (const dupId of tap.sourceIds.slice(1)) await markTimestampDuplicate(db, dupId, canonicalId);
    await load();
  };

  const handleInsertTapForBib = async (bib: CanonicalBibEntry) => {
    if (!race) return;
    const canonicalFinishId = bib.sourceIds[0];
    const recordedAt = Math.round(bib.time);
    const ts = await insertManualTimestamp(db, race.id, recordedAt);
    await linkFinishToTimestamp(db, canonicalFinishId, ts.id, recordedAt - (race.start_time ?? 0), false);
    for (const dupId of bib.sourceIds.slice(1)) await markFinishDuplicate(db, dupId, canonicalFinishId);
    await load();
  };

  const handleMatchBibToTap = async (bib: CanonicalBibEntry, tap: CanonicalTap) => {
    await commitPair({ tap, bib, flagged: false });
    await load();
  };

  const handleResolveDisagreement = async (entry: CanonicalBibEntry, chosenBibNumber: string) => {
    const groups = [{ bibNumber: entry.bibNumber, sourceIds: entry.sourceIds }, ...(entry.disagreement ?? [])];
    const winner = groups.find((g) => g.bibNumber === chosenBibNumber);
    if (!winner) return;
    const winnerId = winner.sourceIds[0];
    for (const g of groups) {
      for (const id of g.sourceIds) {
        if (id !== winnerId) await markFinishDuplicate(db, id, winnerId);
      }
    }
    await load();
  };

  const handleExport = async () => {
    if (matched.length === 0) {
      Alert.alert('Nothing to export', 'Assign some bibs first.');
      return;
    }
    try {
      await exportCsv(race?.name ?? 'race', matched);
    } catch (e) {
      Alert.alert('Export failed', String(e));
    }
  };

  // ── Render helpers ───────────────────────────────────────────────────────────

  type ListItem =
    | { kind: 'finish'; row: ReviewRow }
    | { kind: 'needs-review-header' }
    | { kind: 'confirm-all' }
    | { kind: 'disagreement'; entry: CanonicalBibEntry }
    | { kind: 'flagged-pair'; pair: ReconciledPair }
    | { kind: 'unmatched-tap'; tap: CanonicalTap }
    | { kind: 'unmatched-bib'; bib: CanonicalBibEntry }
    | { kind: 'diagnostics' };

  const needsReviewCount =
    proposal.disagreements.length + flaggedPairs.length + proposal.unmatchedTaps.length + proposal.unmatchedBibs.length;

  const listData: ListItem[] = [
    ...matched.map((row) => ({ kind: 'finish' as const, row })),
    ...(needsReviewCount > 0 || confidentPairs.length > 0 ? [{ kind: 'needs-review-header' as const }] : []),
    ...(confidentPairs.length > 0 ? [{ kind: 'confirm-all' as const }] : []),
    ...proposal.disagreements.map((entry) => ({ kind: 'disagreement' as const, entry })),
    ...flaggedPairs.map((pair) => ({ kind: 'flagged-pair' as const, pair })),
    ...proposal.unmatchedTaps.map((tap) => ({ kind: 'unmatched-tap' as const, tap })),
    ...proposal.unmatchedBibs.map((bib) => ({ kind: 'unmatched-bib' as const, bib })),
    ...(deviceActivity.length > 0 ? [{ kind: 'diagnostics' as const }] : []),
  ];

  return (
    <>
      <Stack.Screen
        options={{
          title: race?.name ?? 'Results',
          headerStyle: { backgroundColor: '#0d0d0d' },
          headerTintColor: '#fff',
          headerRight: () => (
            <Pressable onPress={handleExport} style={styles.exportBtn}>
              <Text style={styles.exportBtnText}>Export CSV</Text>
            </Pressable>
          ),
        }}
      />

      <FlatList
        style={styles.list}
        data={listData}
        keyExtractor={(item, i) => {
          switch (item.kind) {
            case 'finish': return item.row.finish_id!;
            case 'needs-review-header': return 'needs-review-header';
            case 'confirm-all': return 'confirm-all';
            case 'disagreement': return `disagreement-${item.entry.sourceIds[0]}`;
            case 'flagged-pair': return `pair-${item.pair.bib.sourceIds[0]}`;
            case 'unmatched-tap': return `tap-${item.tap.sourceIds[0]}`;
            case 'unmatched-bib': return `bib-${item.bib.sourceIds[0]}`;
            case 'diagnostics': return 'diagnostics';
            default: return String(i);
          }
        }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#fff" />}
        ListHeaderComponent={
          <View style={styles.summary}>
            <Text style={styles.summaryText}>
              {matched.length} {matched.length === 1 ? 'finisher' : 'finishers'}
            </Text>
            {needsReviewCount > 0 && (
              <Text style={styles.summaryGaps}>{needsReviewCount} need review</Text>
            )}
          </View>
        }
        ListEmptyComponent={
          <Text style={styles.empty}>No results recorded yet.</Text>
        }
        renderItem={({ item }) => {
          switch (item.kind) {
            case 'needs-review-header':
              return <Text style={styles.sectionHeader}>Needs review</Text>;

            case 'confirm-all':
              return (
                <Pressable style={styles.confirmAllBtn} onPress={handleConfirmAllConfident}>
                  <Text style={styles.confirmAllBtnText}>
                    Confirm all {confidentPairs.length} confident match{confidentPairs.length === 1 ? '' : 'es'}
                  </Text>
                </Pressable>
              );

            case 'disagreement':
              return (
                <DisagreementRow
                  entry={item.entry}
                  raceStartTime={race?.start_time ?? null}
                  onResolve={(bibNumber) => handleResolveDisagreement(item.entry, bibNumber)}
                />
              );

            case 'flagged-pair':
              return (
                <FlaggedPairRow
                  pair={item.pair}
                  raceStartTime={race?.start_time ?? null}
                  onConfirm={() => handleConfirmPair(item.pair)}
                  onUnlink={load}
                />
              );

            case 'unmatched-tap':
              return (
                <UnmatchedTapRow
                  tap={item.tap}
                  raceStartTime={race?.start_time ?? null}
                  onAssignBib={(bibNumber) => handleAssignBibToTap(item.tap, bibNumber)}
                  onDiscard={() => handleDiscardTap(item.tap)}
                />
              );

            case 'unmatched-bib':
              return (
                <UnmatchedBibRow
                  bib={item.bib}
                  raceStartTime={race?.start_time ?? null}
                  nearbyTaps={proposal.unmatchedTaps}
                  onInsertTap={() => handleInsertTapForBib(item.bib)}
                  onMatchTap={(tap) => handleMatchBibToTap(item.bib, tap)}
                />
              );

            case 'diagnostics':
              return <DeviceActivityStrip activity={deviceActivity} />;

            case 'finish': {
              const pos = positionMap.get(item.row.finish_id!);
              return (
                <View style={styles.row}>
                  <Text style={styles.pos}>{pos}</Text>
                  <Text style={styles.bib}>{item.row.bib_number}</Text>
                  <Text style={styles.time}>{formatGunTime(item.row.gun_time ?? 0)}</Text>
                </View>
              );
            }
          }
        }}
      />
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const mono = Platform.select({ ios: 'ui-monospace', default: 'monospace' });

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
  sectionHeader: {
    color: '#555',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 8,
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#141414',
    gap: 16,
  },
  pos: {
    color: '#4caf50',
    fontFamily: mono,
    fontSize: 15,
    fontWeight: '700',
    width: 32,
    textAlign: 'right',
  },
  bib: {
    color: '#fff',
    fontFamily: mono,
    fontSize: 17,
    fontWeight: '600',
    flex: 1,
  },
  time: {
    color: '#888',
    fontFamily: mono,
    fontSize: 15,
  },
  empty: {
    color: '#444',
    fontSize: 16,
    textAlign: 'center',
    marginTop: 60,
  },
  exportBtn: {
    marginRight: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#1b5e20',
    borderRadius: 8,
  },
  exportBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});
