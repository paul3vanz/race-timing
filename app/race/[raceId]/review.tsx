import { File, Paths } from 'expo-file-system';
import { Stack, useLocalSearchParams } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Platform, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { getRace, getReviewRows, type Race, type ReviewRow } from '@/lib/db';

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

// ── Screen ────────────────────────────────────────────────────────────────────

export default function ReviewScreen() {
  const { raceId } = useLocalSearchParams<{ raceId: string }>();
  const db = useSQLiteContext();

  const [race, setRace] = useState<Race | null>(null);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [r, reviewRows] = await Promise.all([
      getRace(db, raceId),
      getReviewRows(db, raceId),
    ]);
    setRace(r);
    setRows(reviewRows);
  }, [db, raceId]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  // ── Derived ─────────────────────────────────────────────────────────────────

  // Matched rows sorted by gun_time — these are the official results
  const matched = [...rows.filter((r) => r.finish_id !== null)].sort(
    (a, b) => (a.gun_time ?? 0) - (b.gun_time ?? 0),
  );
  const gaps = rows.filter((r) => r.finish_id === null);

  // Build position lookup keyed by finish_id
  const positionMap = new Map(matched.map((r, i) => [r.finish_id, i + 1]));

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
    | { kind: 'gap-header' }
    | { kind: 'gap'; row: ReviewRow };

  const listData: ListItem[] = [
    ...matched.map((row) => ({ kind: 'finish' as const, row })),
    ...(gaps.length > 0 ? [{ kind: 'gap-header' as const }] : []),
    ...gaps.map((row) => ({ kind: 'gap' as const, row })),
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
        keyExtractor={(item) => {
          if (item.kind === 'gap-header') return 'gap-header';
          // A "finish" row's timestamp_id is null for a direct-entry bib (no
          // Timer device), so key on finish_id there; a "gap" row is always
          // an unmatched timestamp and so always has a timestamp_id.
          return item.kind === 'finish' ? item.row.finish_id! : item.row.timestamp_id!;
        }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#fff" />}
        ListHeaderComponent={
          <View style={styles.summary}>
            <Text style={styles.summaryText}>
              {matched.length} {matched.length === 1 ? 'finisher' : 'finishers'}
            </Text>
            {gaps.length > 0 && (
              <Text style={styles.summaryGaps}>{gaps.length} unmatched</Text>
            )}
          </View>
        }
        ListEmptyComponent={
          <Text style={styles.empty}>No results recorded yet.</Text>
        }
        renderItem={({ item }) => {
          if (item.kind === 'gap-header') {
            return <Text style={styles.sectionHeader}>Unmatched timestamps</Text>;
          }

          if (item.kind === 'gap') {
            // Gap rows are always unmatched timestamps, so these are never null.
            const elapsed = race?.start_time
              ? item.row.recorded_at! - race.start_time
              : null;
            return (
              <View style={[styles.row, styles.rowGap]}>
                <Text style={[styles.pos, styles.posGap]}>—</Text>
                <View style={styles.rowInfo}>
                  <Text style={styles.bibGap}>No bib · #{item.row.sequence_num}</Text>
                  {elapsed !== null && (
                    <Text style={styles.timeGap}>{formatGunTime(elapsed)}</Text>
                  )}
                </View>
              </View>
            );
          }

          const pos = positionMap.get(item.row.finish_id!);
          return (
            <View style={styles.row}>
              <Text style={styles.pos}>{pos}</Text>
              <Text style={styles.bib}>{item.row.bib_number}</Text>
              <Text style={styles.time}>{formatGunTime(item.row.gun_time ?? 0)}</Text>
            </View>
          );
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#141414',
    gap: 16,
  },
  rowGap: {
    backgroundColor: '#1a1400',
  },
  pos: {
    color: '#4caf50',
    fontFamily: mono,
    fontSize: 15,
    fontWeight: '700',
    width: 32,
    textAlign: 'right',
  },
  posGap: {
    color: '#f59e0b',
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
  rowInfo: {
    flex: 1,
    gap: 2,
  },
  bibGap: {
    color: '#f59e0b',
    fontSize: 15,
    fontWeight: '600',
  },
  timeGap: {
    color: '#7a6a30',
    fontFamily: mono,
    fontSize: 14,
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
