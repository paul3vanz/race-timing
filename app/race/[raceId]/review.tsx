import { File, Paths } from 'expo-file-system';
import { Stack, useLocalSearchParams } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { DeviceActivityStrip, SpreadsheetRow, type SpreadsheetRowData } from '@/components/reconcile-row';
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

function buildCsv(confirmed: ReviewRow[]): string {
  const lines = ['Position,Bib,Gun Time'];
  confirmed.forEach((row, i) => {
    lines.push(`${i + 1},${row.bib_number},${formatGunTime(row.gun_time ?? 0)}`);
  });
  return lines.join('\n');
}

async function exportCsv(raceName: string, confirmed: ReviewRow[]) {
  const csv = buildCsv(confirmed);
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

// ── Spreadsheet row model ─────────────────────────────────────────────────────
//
// One continuous, time-ordered list instead of a "results" list with a
// separate "problems" list underneath — a confirmed match, a pending
// proposal, a disagreement, and a gap on either side all read as rows in the
// same sequence, so a blank cell or a dashed row is visible right where it
// happened rather than being sorted away into its own section.

interface PositionedRow {
  key: string;
  position: number | null; // only rows with a bib identity get a running position
  data: SpreadsheetRowData;
}

function buildSpreadsheetRows(rows: ReviewRow[], proposal: Proposal, raceStartTime: number | null): PositionedRow[] {
  const startTime = raceStartTime ?? 0;
  const disagreementBibIds = new Set(proposal.disagreements.map((d) => d.sourceIds[0]));

  const unpositioned: { key: string; time: number; hasBib: boolean; data: SpreadsheetRowData }[] = [];

  for (const row of rows) {
    if (row.finish_id === null) continue; // pure gap — represented via unmatchedTaps below
    unpositioned.push({
      key: row.finish_id,
      time: row.gun_time ?? 0,
      hasBib: true,
      data: { kind: 'linked', time: row.gun_time ?? 0, finishId: row.finish_id, bibNumber: row.bib_number ?? '', flagged: row.flagged === 1 },
    });
  }

  for (const pair of proposal.pairs) {
    if (disagreementBibIds.has(pair.bib.sourceIds[0])) continue; // shown via the disagreement row instead
    const tapTime = pair.tap.time - startTime;
    const bibTime = pair.bib.time - startTime;
    unpositioned.push({
      key: `pair-${pair.bib.sourceIds[0]}`,
      time: tapTime,
      hasBib: true,
      data: { kind: 'proposed', time: tapTime, tapTime, bibTime, flagged: pair.flagged, pair },
    });
  }

  for (const entry of proposal.disagreements) {
    const pair = proposal.pairs.find((p) => p.bib.sourceIds[0] === entry.sourceIds[0]) ?? null;
    const tapTime = pair ? pair.tap.time - startTime : null;
    unpositioned.push({
      key: `disagreement-${entry.sourceIds[0]}`,
      time: tapTime ?? entry.time - startTime,
      hasBib: true,
      data: { kind: 'disagreement', time: tapTime ?? entry.time - startTime, tapTime, entry, pair },
    });
  }

  for (const tap of proposal.unmatchedTaps) {
    unpositioned.push({
      key: `tap-${tap.sourceIds[0]}`,
      time: tap.time - startTime,
      hasBib: false,
      data: { kind: 'gap-tap', time: tap.time - startTime, tap },
    });
  }

  for (const bib of proposal.unmatchedBibs) {
    const bibTime = bib.time - startTime;
    unpositioned.push({
      key: `bib-${bib.sourceIds[0]}`,
      time: bibTime,
      hasBib: true,
      data: { kind: 'gap-bib', time: bibTime, bibTime, bib },
    });
  }

  unpositioned.sort((a, b) => a.time - b.time);

  let pos = 0;
  return unpositioned.map((row) => {
    if (!row.hasBib) return { key: row.key, position: null, data: row.data };
    pos += 1;
    return { key: row.key, position: pos, data: row.data };
  });
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

  const confirmedRows = rows.filter((r) => r.finish_id !== null).sort((a, b) => (a.gun_time ?? 0) - (b.gun_time ?? 0));
  const spreadsheetRows = buildSpreadsheetRows(rows, proposal, race?.start_time ?? null);
  const confidentPairs = proposal.pairs.filter((p) => !p.flagged);
  const finisherCount = spreadsheetRows.filter((r) => r.position !== null).length;
  const needsReviewCount = spreadsheetRows.filter(
    (r) => r.data.kind !== 'linked' || r.data.flagged,
  ).length;

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
    if (confirmedRows.length === 0) {
      Alert.alert('Nothing to export', 'Assign some bibs first.');
      return;
    }
    try {
      await exportCsv(race?.name ?? 'race', confirmedRows);
    } catch (e) {
      Alert.alert('Export failed', String(e));
    }
  };

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
        data={spreadsheetRows}
        keyExtractor={(item) => item.key}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#fff" />}
        ListHeaderComponent={
          <View>
            <View style={styles.summary}>
              <Text style={styles.summaryText}>
                {finisherCount} {finisherCount === 1 ? 'finisher' : 'finishers'}
              </Text>
              {needsReviewCount > 0 && (
                <Text style={styles.summaryGaps}>{needsReviewCount} need review</Text>
              )}
            </View>
            {confidentPairs.length > 0 && (
              <Pressable style={styles.confirmAllBtn} onPress={handleConfirmAllConfident}>
                <Text style={styles.confirmAllBtnText}>
                  Confirm all {confidentPairs.length} confident match{confidentPairs.length === 1 ? '' : 'es'}
                </Text>
              </Pressable>
            )}
          </View>
        }
        ListFooterComponent={<DeviceActivityStrip activity={deviceActivity} />}
        ListEmptyComponent={
          <Text style={styles.empty}>No results recorded yet.</Text>
        }
        renderItem={({ item }) => (
          <SpreadsheetRow
            position={item.position}
            data={item.data}
            nearbyTaps={proposal.unmatchedTaps}
            onConfirmPair={handleConfirmPair}
            onUnlinkPair={load}
            onAssignBibToTap={handleAssignBibToTap}
            onDiscardTap={handleDiscardTap}
            onInsertTapForBib={handleInsertTapForBib}
            onMatchBibToTap={handleMatchBibToTap}
            onResolveDisagreement={handleResolveDisagreement}
          />
        )}
      />
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
