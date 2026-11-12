import { Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { formatGunTime, formatGunTimeTenths } from '@/lib/format';
import type { DeviceSummary, ResultRow, RowFlags } from '@/lib/merge';
import type { CanonicalBibEntry, CanonicalTap, ReconciledPair } from '@/lib/reconcile';

const mono = Platform.select({ ios: 'ui-monospace', default: 'monospace' });

// What the edit sheet needs to know about a row. `finishId` is the bib entry
// being corrected; `tapIds` are the Timer taps behind the row (when any).
export interface EditTarget {
  finishId: string;
  bib: string;
  position: number | null;
  time: number;
  tapIds: string[] | null;
}

// ── Row ───────────────────────────────────────────────────────────────────────
//
// One row shape for every state a finisher can be in: a confirmed result, a
// pending proposal, a bib the devices disagree on, or a gap on either side, so
// the whole race reads as one continuous, time-ordered list. A blank Timer or
// Bib cell, or an amber flag, is the signal that something needs attention.

export function ResultRowView({
  row,
  nearbyTaps,
  onEdit,
  onAssignTap,
  onDiscardTap,
  onConfirmPair,
  onInsertTapForBib,
  onMatchBibToTap,
  onResolveDisagreement,
}: {
  row: ResultRow;
  nearbyTaps: CanonicalTap[];
  onEdit: (target: EditTarget) => void;
  onAssignTap: (tap: CanonicalTap) => void;
  onDiscardTap: (tap: CanonicalTap) => void;
  onConfirmPair: (pair: ReconciledPair) => void;
  onInsertTapForBib: (bib: CanonicalBibEntry) => void;
  onMatchBibToTap: (bib: CanonicalBibEntry, tap: CanonicalTap) => void;
  onResolveDisagreement: (entry: CanonicalBibEntry, bibNumber: string) => void;
}) {
  const posLabel = row.position !== null ? String(row.position) : '·';

  const handleMatchManually = (bib: CanonicalBibEntry) => {
    if (nearbyTaps.length === 0) {
      Alert.alert('No unmatched taps', 'There are no unmatched Timer taps left to pair this with.');
      return;
    }
    Alert.alert(
      `Match bib #${bib.bibNumber}`,
      'Pick the Timer tap this bib belongs to:',
      nearbyTaps
        .slice(0, 5)
        .map((tap) => ({ text: formatGunTimeTenths(tap.time), onPress: () => onMatchBibToTap(bib, tap) }))
        .concat([{ text: 'Cancel', onPress: () => {}, style: 'cancel' } as never]),
    );
  };

  // ── Finisher (confirmed) ────────────────────────────────────────────────────
  if (row.kind === 'finisher') {
    const problems = flagLines(row.flags, row.extraEntries);
    return (
      <Pressable
        style={[styles.row, problems.length > 0 && styles.rowFlagged]}
        onPress={() =>
          onEdit({
            finishId: row.finish.id,
            bib: row.finish.bib_number,
            position: row.position,
            time: row.time,
            tapIds: row.cluster?.tapIds ?? null,
          })
        }
      >
        <Text style={styles.pos}>{posLabel}</Text>
        <Text style={styles.timeCell}>{formatGunTimeTenths(row.time)}</Text>
        <View style={styles.main}>
          <Text style={styles.bibCell}>{row.finish.bib_number}</Text>
          {row.name ? <Text style={styles.name} numberOfLines={1}>{row.name}</Text> : null}
          {problems.map((p) => (
            <Text key={p} style={styles.problem}>{p}</Text>
          ))}
        </View>
        {row.deviceLabels.length > 0 && (
          <View style={styles.chips}>
            {row.deviceLabels.map((d) => (
              <Text key={d} style={styles.chip}>{d}</Text>
            ))}
            {row.flags.missingTimers.map((d) => (
              <Text key={`m-${d}`} style={[styles.chip, styles.chipMissing]}>{d}</Text>
            ))}
          </View>
        )}
        <Text style={styles.editHint}>edit</Text>
      </Pressable>
    );
  }

  // ── Proposed pair, awaiting confirmation ────────────────────────────────────
  if (row.kind === 'proposed') {
    const gapMs = Math.abs(row.bibTime - row.tapTime);
    const problems = flagLines(row.flags, 0);
    return (
      <View style={[styles.row, styles.rowPending]}>
        <Text style={styles.pos}>{posLabel}</Text>
        <Text style={[styles.timeCell, styles.timePending]}>{formatGunTimeTenths(row.tapTime)}</Text>
        <Pressable
          style={styles.main}
          onPress={() =>
            onEdit({
              finishId: row.pair.bib.sourceIds[0],
              bib: row.pair.bib.bibNumber,
              position: row.position,
              time: row.tapTime,
              tapIds: null,
            })
          }
        >
          <Text style={styles.bibCell}>{row.pair.bib.bibNumber}</Text>
          {row.name ? <Text style={styles.name} numberOfLines={1}>{row.name}</Text> : null}
          <Text style={styles.pendingSub}>typed {formatGunTime(row.bibTime)} (gap {Math.round(gapMs / 1000)}s)</Text>
          {problems.map((p) => (
            <Text key={p} style={styles.problem}>{p}</Text>
          ))}
        </Pressable>
        <Pressable style={styles.btnPrimary} onPress={() => onConfirmPair(row.pair)}>
          <Text style={styles.btnPrimaryText}>Confirm</Text>
        </Pressable>
      </View>
    );
  }

  // ── Disagreement: devices reported different bib numbers ───────────────────
  if (row.kind === 'disagreement') {
    const candidates = [{ bibNumber: row.entry.bibNumber, sourceIds: row.entry.sourceIds }, ...(row.entry.disagreement ?? [])];
    return (
      <View style={[styles.row, styles.rowDisagreement]}>
        <Text style={styles.pos}>{posLabel}</Text>
        <Text style={styles.timeCell}>{row.tapTime !== null ? formatGunTimeTenths(row.tapTime) : '·'}</Text>
        <View style={styles.disagreementOptions}>
          {candidates.map((c) => (
            <Pressable key={c.bibNumber} style={styles.btnCandidate} onPress={() => onResolveDisagreement(row.entry, c.bibNumber)}>
              <Text style={styles.btnCandidateText}>#{c.bibNumber}</Text>
              <Text style={styles.btnCandidateSub}>{c.sourceIds.length} device{c.sourceIds.length > 1 ? 's' : ''}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    );
  }

  // ── Gap: Timer tap with no bib ──────────────────────────────────────────────
  if (row.kind === 'gap-tap') {
    return (
      <View style={[styles.row, styles.rowGap]}>
        <Text style={styles.pos}>{posLabel}</Text>
        <Text style={[styles.timeCell, styles.timeGap]}>{formatGunTimeTenths(row.time)}</Text>
        <View style={styles.main}>
          <Text style={styles.gapTitle}>Tap with no bib</Text>
          <Text style={styles.detail}>
            {row.missingTimers.length > 0
              ? `${row.missingTimers.join(', ')} did not tap: possibly a stray press`
              : row.tap.corroboration > 1
                ? `${row.tap.corroboration} timers agree`
                : 'single tap'}
          </Text>
        </View>
        <View style={styles.actions}>
          <Pressable style={styles.btnGhost} onPress={() => onDiscardTap(row.tap)}>
            <Text style={styles.btnGhostText}>Discard</Text>
          </Pressable>
          <Pressable style={styles.btnPrimary} onPress={() => onAssignTap(row.tap)}>
            <Text style={styles.btnPrimaryText}>Add bib</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // ── Gap: bib entry with no Timer tap ────────────────────────────────────────
  return (
    <View style={[styles.row, styles.rowGap]}>
      <Text style={styles.pos}>{posLabel}</Text>
      <Text style={[styles.timeCell, styles.timeGap]}>·</Text>
      <Pressable
        style={styles.main}
        onPress={() =>
          onEdit({
            finishId: row.bib.sourceIds[0],
            bib: row.bib.bibNumber,
            position: row.position,
            time: row.bibTime,
            tapIds: null,
          })
        }
      >
        <Text style={styles.bibCell}>{row.bib.bibNumber}</Text>
        <Text style={styles.detail}>typed {formatGunTime(row.bibTime)}, no matching tap</Text>
      </Pressable>
      <View style={styles.actions}>
        <Pressable style={styles.btnGhost} onPress={() => handleMatchManually(row.bib)}>
          <Text style={styles.btnGhostText}>Match tap</Text>
        </Pressable>
        <Pressable style={styles.btnPrimary} onPress={() => onInsertTapForBib(row.bib)}>
          <Text style={styles.btnPrimaryText}>Add tap</Text>
        </Pressable>
      </View>
    </View>
  );
}

function flagLines(flags: RowFlags, extraEntries: number): string[] {
  const lines: string[] = [];
  if (flags.dupBib) lines.push('Duplicate bib');
  if (flags.unknownBib) lines.push('Not on start list');
  if (extraEntries > 0) lines.push(`${extraEntries + 1} bibs entered for this tap`);
  if (flags.missingTimers.length > 0) lines.push(`${flags.missingTimers.join(', ')} did not tap`);
  if (flags.lowConfidence) lines.push('Low confidence match');
  return lines;
}

// ── Device diagnostics strip ─────────────────────────────────────────────────

export function DeviceActivityStrip({ devices }: { devices: DeviceSummary[] }) {
  if (devices.length === 0) return null;
  return (
    <View style={styles.diagnostics}>
      {devices.map((d) => (
        <View key={d.deviceId} style={styles.diagnosticChip}>
          <Text style={styles.diagnosticDevice}>{d.label.long}</Text>
          <Text style={styles.diagnosticStat}>
            {d.taps} {d.label.role === 'bib' ? (d.taps === 1 ? 'bib' : 'bibs') : d.taps === 1 ? 'tap' : 'taps'}
            {d.missed > 0 ? ` · missed ${d.missed}` : ''}
            {d.discarded > 0 ? ` · ${d.discarded} discarded` : ''}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#141414',
    gap: 10,
  },
  rowFlagged: { backgroundColor: '#1a1400' },
  rowPending: { backgroundColor: '#161200', borderStyle: 'dashed', borderWidth: 1, borderColor: '#5c4a10' },
  rowDisagreement: { backgroundColor: '#2b0f0f', borderWidth: 1, borderColor: '#ef4444' },
  rowGap: { backgroundColor: '#1a1400' },
  pos: {
    color: '#4caf50',
    fontFamily: mono,
    fontSize: 14,
    fontWeight: '700',
    width: 28,
    textAlign: 'right',
  },
  timeCell: { color: '#888', fontFamily: mono, fontSize: 13, width: 68 },
  timePending: { color: '#f59e0b' },
  timeGap: { color: '#555' },
  main: { flex: 1, gap: 1 },
  bibCell: { color: '#fff', fontFamily: mono, fontSize: 18, fontWeight: '700' },
  name: { color: '#888', fontSize: 12 },
  problem: { color: '#f59e0b', fontSize: 11, fontWeight: '600' },
  pendingSub: { color: '#f59e0b', fontSize: 11 },
  gapTitle: { color: '#ddd', fontSize: 14, fontWeight: '600' },
  detail: { color: '#777', fontSize: 11 },
  chips: { flexDirection: 'row', gap: 4 },
  chip: {
    color: '#4caf50',
    backgroundColor: '#0f2312',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
    fontSize: 10,
    fontWeight: '700',
    overflow: 'hidden',
  },
  chipMissing: { color: '#f59e0b', backgroundColor: '#2b1f00', textDecorationLine: 'line-through' },
  editHint: { color: '#444', fontSize: 11 },
  actions: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  btnPrimary: { backgroundColor: '#1b5e20', borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12 },
  btnPrimaryText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  btnGhost: { borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12, borderWidth: 1, borderColor: '#444' },
  btnGhostText: { color: '#aaa', fontSize: 12, fontWeight: '600' },
  disagreementOptions: { flexDirection: 'row', gap: 8, flex: 1 },
  btnCandidate: {
    flex: 1,
    backgroundColor: '#1a1a1a',
    borderRadius: 10,
    paddingVertical: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#444',
  },
  btnCandidateText: { color: '#fff', fontFamily: mono, fontSize: 15, fontWeight: '700' },
  btnCandidateSub: { color: '#888', fontSize: 10, marginTop: 2 },
  diagnostics: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingVertical: 10 },
  diagnosticChip: { backgroundColor: '#141414', borderRadius: 8, paddingVertical: 6, paddingHorizontal: 10 },
  diagnosticDevice: { color: '#ccc', fontSize: 11, fontWeight: '700' },
  diagnosticStat: { color: '#777', fontSize: 11 },
});
