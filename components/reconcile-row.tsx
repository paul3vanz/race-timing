import { useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { CanonicalBibEntry, CanonicalTap, ReconciledPair } from '@/lib/reconcile';

const mono = Platform.select({ ios: 'ui-monospace', default: 'monospace' });

function formatClock(ms: number): string {
  const elapsed = Math.max(0, ms);
  const totalSec = Math.floor(elapsed / 1000);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const hrs = Math.floor(totalMin / 60);
  const p2 = (n: number) => n.toString().padStart(2, '0');
  return hrs > 0 ? `${p2(hrs)}:${p2(min)}:${p2(sec)}` : `${p2(min)}:${p2(sec)}`;
}

// ── Unified spreadsheet row ───────────────────────────────────────────────────
//
// One row shape for every state a finisher can be in — a confirmed match, a
// pending proposal awaiting confirmation, a bib the devices disagree on, or a
// gap on either side — so the whole race reads as one continuous, time-ordered
// list instead of a "results" list with a separate "problems" list bolted on.
// A blank Timer or Bib cell is the signal that something needs attention;
// nothing needs a separate section to be visible.

export type SpreadsheetRowData =
  | { kind: 'linked'; time: number; finishId: string; bibNumber: string; flagged: boolean }
  | { kind: 'proposed'; time: number; tapTime: number; bibTime: number; flagged: boolean; pair: ReconciledPair }
  | { kind: 'disagreement'; time: number; tapTime: number | null; entry: CanonicalBibEntry; pair: ReconciledPair | null }
  | { kind: 'gap-tap'; time: number; tap: CanonicalTap }
  | { kind: 'gap-bib'; time: number; bibTime: number; bib: CanonicalBibEntry };

export function SpreadsheetRow({
  position,
  data,
  nearbyTaps,
  onConfirmPair,
  onUnlinkPair,
  onAssignBibToTap,
  onDiscardTap,
  onInsertTapForBib,
  onMatchBibToTap,
  onResolveDisagreement,
}: {
  position: number | null;
  data: SpreadsheetRowData;
  nearbyTaps: CanonicalTap[];
  onConfirmPair: (pair: ReconciledPair) => void;
  onUnlinkPair: () => void;
  onAssignBibToTap: (tap: CanonicalTap, bibNumber: string) => void;
  onDiscardTap: (tap: CanonicalTap) => void;
  onInsertTapForBib: (bib: CanonicalBibEntry) => void;
  onMatchBibToTap: (bib: CanonicalBibEntry, tap: CanonicalTap) => void;
  onResolveDisagreement: (entry: CanonicalBibEntry, bibNumber: string) => void;
}) {
  const [assigning, setAssigning] = useState(false);
  const [bibInput, setBibInput] = useState('');

  const posLabel = position !== null ? String(position) : '—';

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
        .map((tap) => ({ text: formatClock(tap.time), onPress: () => onMatchBibToTap(bib, tap) }))
        .concat([{ text: 'Cancel', onPress: () => {}, style: 'cancel' } as never]),
    );
  };

  // ── Linked (confirmed) ──────────────────────────────────────────────────────
  if (data.kind === 'linked') {
    return (
      <View style={[styles.row, data.flagged && styles.rowFlagged]}>
        <Text style={styles.pos}>{posLabel}</Text>
        <Text style={styles.timerCell}>{formatClock(data.time)}</Text>
        <Text style={styles.bibCell}>{data.bibNumber}</Text>
        {data.flagged && <Text style={styles.flagLabel}>low confidence</Text>}
      </View>
    );
  }

  // ── Proposed pair — awaiting confirmation ────────────────────────────────────
  if (data.kind === 'proposed') {
    const gapMs = Math.abs(data.bibTime - data.tapTime);
    return (
      <View style={[styles.row, styles.rowPending]}>
        <Text style={styles.pos}>{posLabel}</Text>
        <View style={styles.timerCellWrap}>
          <Text style={styles.timerCellPending}>{formatClock(data.tapTime)}</Text>
        </View>
        <View style={styles.bibCellWrap}>
          <Text style={styles.bibCellPending}>{data.pair.bib.bibNumber}</Text>
          <Text style={styles.pendingSub}>typed {formatClock(data.bibTime)} (Δ{Math.round(gapMs / 1000)}s)</Text>
        </View>
        <View style={styles.actions}>
          <Pressable style={styles.btnGhost} onPress={onUnlinkPair}>
            <Text style={styles.btnGhostText}>Ignore</Text>
          </Pressable>
          <Pressable style={styles.btnPrimary} onPress={() => onConfirmPair(data.pair)}>
            <Text style={styles.btnPrimaryText}>Confirm</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // ── Disagreement — devices reported different bib numbers ───────────────────
  if (data.kind === 'disagreement') {
    const candidates = [{ bibNumber: data.entry.bibNumber, sourceIds: data.entry.sourceIds }, ...(data.entry.disagreement ?? [])];
    return (
      <View style={[styles.row, styles.rowDisagreement]}>
        <Text style={styles.pos}>{posLabel}</Text>
        <Text style={styles.timerCell}>{data.tapTime !== null ? formatClock(data.tapTime) : '—'}</Text>
        <View style={styles.disagreementOptions}>
          {candidates.map((c) => (
            <Pressable key={c.bibNumber} style={styles.btnCandidate} onPress={() => onResolveDisagreement(data.entry, c.bibNumber)}>
              <Text style={styles.btnCandidateText}>#{c.bibNumber}</Text>
              <Text style={styles.btnCandidateSub}>{c.sourceIds.length} device{c.sourceIds.length > 1 ? 's' : ''}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    );
  }

  // ── Gap: timer tap with no bib ────────────────────────────────────────────────
  if (data.kind === 'gap-tap') {
    return (
      <View style={[styles.row, styles.rowGap]}>
        <Text style={styles.pos}>{posLabel}</Text>
        <Text style={styles.timerCellGap}>{formatClock(data.time)}</Text>
        {assigning ? (
          <View style={styles.inlineForm}>
            <TextInput
              style={styles.bibInput}
              placeholder="Bib #"
              placeholderTextColor="#666"
              value={bibInput}
              onChangeText={setBibInput}
              keyboardType="number-pad"
              autoFocus
            />
            <Pressable
              style={[styles.btnPrimary, !bibInput.trim() && styles.btnDisabled]}
              disabled={!bibInput.trim()}
              onPress={() => {
                onAssignBibToTap(data.tap, bibInput.trim());
                setBibInput('');
                setAssigning(false);
              }}
            >
              <Text style={styles.btnPrimaryText}>Save</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.actions}>
            {data.tap.corroboration > 1 && <Text style={styles.detail}>{data.tap.corroboration} devices</Text>}
            <Pressable style={styles.btnGhost} onPress={() => onDiscardTap(data.tap)}>
              <Text style={styles.btnGhostText}>Discard</Text>
            </Pressable>
            <Pressable style={styles.btnPrimary} onPress={() => setAssigning(true)}>
              <Text style={styles.btnPrimaryText}>Assign bib</Text>
            </Pressable>
          </View>
        )}
      </View>
    );
  }

  // ── Gap: bib entry with no timer tap ──────────────────────────────────────────
  return (
    <View style={[styles.row, styles.rowGap]}>
      <Text style={styles.pos}>{posLabel}</Text>
      <Text style={styles.timerCellGap}>—</Text>
      <View style={styles.bibCellWrap}>
        <Text style={styles.bibCell}>{data.bib.bibNumber}</Text>
        <Text style={styles.detail}>typed {formatClock(data.bibTime)}, no matching tap</Text>
      </View>
      <View style={styles.actions}>
        <Pressable style={styles.btnGhost} onPress={() => handleMatchManually(data.bib)}>
          <Text style={styles.btnGhostText}>Match tap</Text>
        </Pressable>
        <Pressable style={styles.btnPrimary} onPress={() => onInsertTapForBib(data.bib)}>
          <Text style={styles.btnPrimaryText}>Insert tap</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ── Device diagnostics strip ─────────────────────────────────────────────────

export function DeviceActivityStrip({
  activity,
}: {
  activity: { device_id: string; kept: number; duplicate: number; voided: number }[];
}) {
  if (activity.length === 0) return null;
  return (
    <View style={styles.diagnostics}>
      {activity.map((d) => (
        <View key={d.device_id} style={styles.diagnosticChip}>
          <Text style={styles.diagnosticDevice}>{d.device_id}</Text>
          <Text style={styles.diagnosticStat}>
            {d.kept} kept
            {d.duplicate > 0 ? ` · ${d.duplicate} dup` : ''}
            {d.voided > 0 ? ` · ${d.voided} discarded` : ''}
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
    gap: 12,
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
    width: 26,
    textAlign: 'right',
  },
  timerCell: { color: '#888', fontFamily: mono, fontSize: 14, width: 64 },
  timerCellGap: { color: '#555', fontFamily: mono, fontSize: 14, width: 64 },
  timerCellPending: { color: '#f59e0b', fontFamily: mono, fontSize: 14 },
  timerCellWrap: { width: 64 },
  bibCell: { color: '#fff', fontFamily: mono, fontSize: 16, fontWeight: '600', flex: 1 },
  bibCellWrap: { flex: 1, gap: 1 },
  bibCellPending: { color: '#fff', fontFamily: mono, fontSize: 16, fontWeight: '600' },
  pendingSub: { color: '#f59e0b', fontSize: 11 },
  detail: { color: '#777', fontSize: 11 },
  flagLabel: { color: '#f59e0b', fontSize: 11, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  inlineForm: { flexDirection: 'row', gap: 8, alignItems: 'center', flex: 1 },
  bibInput: {
    flex: 1,
    backgroundColor: '#0d0d0d',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#333',
    color: '#fff',
    paddingHorizontal: 12,
    paddingVertical: 6,
    fontSize: 14,
  },
  btnPrimary: { backgroundColor: '#1b5e20', borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12 },
  btnPrimaryText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  btnGhost: { borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12, borderWidth: 1, borderColor: '#444' },
  btnGhostText: { color: '#aaa', fontSize: 12, fontWeight: '600' },
  btnDisabled: { opacity: 0.4 },
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
  diagnostics: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
  diagnosticChip: { backgroundColor: '#141414', borderRadius: 8, paddingVertical: 6, paddingHorizontal: 10 },
  diagnosticDevice: { color: '#ccc', fontSize: 11, fontWeight: '700' },
  diagnosticStat: { color: '#777', fontSize: 11 },
});
