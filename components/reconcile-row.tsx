import { useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { CanonicalBibEntry, CanonicalTap, ReconciledPair } from '@/lib/reconcile';

const mono = Platform.select({ ios: 'ui-monospace', default: 'monospace' });

function formatClock(ms: number, raceStartTime: number | null): string {
  if (raceStartTime === null) return '--:--:--';
  const elapsed = Math.max(0, ms - raceStartTime);
  const totalSec = Math.floor(elapsed / 1000);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const hrs = Math.floor(totalMin / 60);
  const p2 = (n: number) => n.toString().padStart(2, '0');
  return hrs > 0 ? `${p2(hrs)}:${p2(min)}:${p2(sec)}` : `${p2(min)}:${p2(sec)}`;
}

// ── Flagged pair — low-confidence auto-match, needs an eyeball ──────────────

export function FlaggedPairRow({
  pair,
  raceStartTime,
  onConfirm,
  onUnlink,
}: {
  pair: ReconciledPair;
  raceStartTime: number | null;
  onConfirm: () => void;
  onUnlink: () => void;
}) {
  return (
    <View style={[styles.card, styles.cardFlagged]}>
      <View style={styles.cardInfo}>
        <Text style={styles.bib}>Bib #{pair.bib.bibNumber}</Text>
        <Text style={styles.detail}>
          Tap {formatClock(pair.tap.time, raceStartTime)} · Bib entry {formatClock(pair.bib.time, raceStartTime)}
        </Text>
        <Text style={styles.warning}>Time gap larger than expected — check before confirming</Text>
      </View>
      <View style={styles.actions}>
        <Pressable style={styles.btnGhost} onPress={onUnlink}>
          <Text style={styles.btnGhostText}>Unlink</Text>
        </Pressable>
        <Pressable style={styles.btnPrimary} onPress={onConfirm}>
          <Text style={styles.btnPrimaryText}>Confirm</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ── Unmatched timer tap — no bib partner found ───────────────────────────────

export function UnmatchedTapRow({
  tap,
  raceStartTime,
  onAssignBib,
  onDiscard,
}: {
  tap: CanonicalTap;
  raceStartTime: number | null;
  onAssignBib: (bibNumber: string) => void;
  onDiscard: () => void;
}) {
  const [assigning, setAssigning] = useState(false);
  const [bib, setBib] = useState('');

  return (
    <View style={[styles.card, styles.cardGap]}>
      <View style={styles.cardInfo}>
        <Text style={styles.bibGap}>No bib · {formatClock(tap.time, raceStartTime)}</Text>
        {tap.corroboration > 1 && (
          <Text style={styles.detail}>Seen by {tap.corroboration} devices</Text>
        )}
      </View>
      {assigning ? (
        <View style={styles.inlineForm}>
          <TextInput
            style={styles.bibInput}
            placeholder="Bib #"
            placeholderTextColor="#666"
            value={bib}
            onChangeText={setBib}
            keyboardType="number-pad"
            autoFocus
          />
          <Pressable
            style={[styles.btnPrimary, !bib.trim() && styles.btnDisabled]}
            disabled={!bib.trim()}
            onPress={() => {
              onAssignBib(bib.trim());
              setBib('');
              setAssigning(false);
            }}
          >
            <Text style={styles.btnPrimaryText}>Save</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.actions}>
          <Pressable style={styles.btnGhost} onPress={onDiscard}>
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

// ── Unmatched bib entry — has an approximate time already, could be upgraded ─

export function UnmatchedBibRow({
  bib,
  raceStartTime,
  nearbyTaps,
  onInsertTap,
  onMatchTap,
}: {
  bib: CanonicalBibEntry;
  raceStartTime: number | null;
  nearbyTaps: CanonicalTap[];
  onInsertTap: () => void;
  onMatchTap: (tap: CanonicalTap) => void;
}) {
  const handleMatchManually = () => {
    if (nearbyTaps.length === 0) {
      Alert.alert('No unmatched taps', 'There are no unmatched Timer taps left to pair this with.');
      return;
    }
    Alert.alert(
      `Match bib #${bib.bibNumber}`,
      'Pick the Timer tap this bib belongs to:',
      nearbyTaps
        .slice(0, 5)
        .map((tap) => ({ text: formatClock(tap.time, raceStartTime), onPress: () => onMatchTap(tap) }))
        .concat([{ text: 'Cancel', onPress: () => {}, style: 'cancel' } as never]),
    );
  };

  return (
    <View style={[styles.card, styles.cardBibGap]}>
      <View style={styles.cardInfo}>
        <Text style={styles.bib}>Bib #{bib.bibNumber} · {formatClock(bib.time, raceStartTime)}</Text>
        <Text style={styles.detail}>Typed on a device with no matching Timer tap yet</Text>
      </View>
      <View style={styles.actions}>
        <Pressable style={styles.btnGhost} onPress={handleMatchManually}>
          <Text style={styles.btnGhostText}>Match tap</Text>
        </Pressable>
        <Pressable style={styles.btnPrimary} onPress={onInsertTap}>
          <Text style={styles.btnPrimaryText}>Insert tap here</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ── Bib disagreement — two devices typed different digits ───────────────────

export function DisagreementRow({
  entry,
  raceStartTime,
  onResolve,
}: {
  entry: CanonicalBibEntry;
  raceStartTime: number | null;
  onResolve: (bibNumber: string) => void;
}) {
  const candidates: { bibNumber: string; sourceIds: string[] }[] = [
    { bibNumber: entry.bibNumber, sourceIds: entry.sourceIds },
    ...(entry.disagreement ?? []),
  ];

  return (
    <View style={[styles.card, styles.cardDisagreement]}>
      <View style={styles.cardInfo}>
        <Text style={styles.warningStrong}>Devices disagree on this bib · {formatClock(entry.time, raceStartTime)}</Text>
      </View>
      <View style={styles.disagreementOptions}>
        {candidates.map((c) => (
          <Pressable key={c.bibNumber} style={styles.btnCandidate} onPress={() => onResolve(c.bibNumber)}>
            <Text style={styles.btnCandidateText}>#{c.bibNumber}</Text>
            <Text style={styles.btnCandidateSub}>{c.sourceIds.length} device{c.sourceIds.length > 1 ? 's' : ''}</Text>
          </Pressable>
        ))}
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
  card: {
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 14,
    gap: 10,
  },
  cardFlagged: { backgroundColor: '#1a1400', borderWidth: 1, borderColor: '#f59e0b' },
  cardGap: { backgroundColor: '#1a1400' },
  cardBibGap: { backgroundColor: '#14181f' },
  cardDisagreement: { backgroundColor: '#2b0f0f', borderWidth: 1, borderColor: '#ef4444' },
  cardInfo: { gap: 4 },
  bib: { color: '#fff', fontFamily: mono, fontSize: 15, fontWeight: '600' },
  bibGap: { color: '#f59e0b', fontFamily: mono, fontSize: 15, fontWeight: '600' },
  detail: { color: '#888', fontSize: 12 },
  warning: { color: '#f59e0b', fontSize: 12 },
  warningStrong: { color: '#ef4444', fontSize: 13, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end' },
  inlineForm: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  bibInput: {
    flex: 1,
    backgroundColor: '#0d0d0d',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#333',
    color: '#fff',
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
  },
  btnPrimary: { backgroundColor: '#1b5e20', borderRadius: 8, paddingVertical: 8, paddingHorizontal: 14 },
  btnPrimaryText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  btnGhost: { borderRadius: 8, paddingVertical: 8, paddingHorizontal: 14, borderWidth: 1, borderColor: '#444' },
  btnGhostText: { color: '#aaa', fontSize: 13, fontWeight: '600' },
  btnDisabled: { opacity: 0.4 },
  disagreementOptions: { flexDirection: 'row', gap: 10 },
  btnCandidate: {
    flex: 1,
    backgroundColor: '#1a1a1a',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#444',
  },
  btnCandidateText: { color: '#fff', fontFamily: mono, fontSize: 17, fontWeight: '700' },
  btnCandidateSub: { color: '#888', fontSize: 11, marginTop: 2 },
  diagnostics: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingBottom: 12 },
  diagnosticChip: { backgroundColor: '#141414', borderRadius: 8, paddingVertical: 6, paddingHorizontal: 10 },
  diagnosticDevice: { color: '#ccc', fontSize: 11, fontWeight: '700' },
  diagnosticStat: { color: '#777', fontSize: 11 },
});
