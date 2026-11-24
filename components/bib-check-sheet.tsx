import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import type { BibIssue } from '@/lib/bib-check';
import { formatGunTime } from '@/lib/format';

function describe(issue: BibIssue): { title: string; body: string } {
  const name = 'name' in issue ? issue.name : null;
  const who = name ? ` (${name})` : '';
  const runner = name ?? 'This runner';
  switch (issue.kind) {
    case 'dns':
      return {
        title: `Bib ${issue.bib} is marked DNS`,
        body: `${runner} was marked as not starting. Check the number, or keep it if the DNS is wrong.`,
      };
    case 'dnf':
      return {
        title: `Bib ${issue.bib} is marked DNF`,
        body: `${runner} was marked as dropping out. Check the number, or keep it if the DNF is wrong.`,
      };
    case 'unknown':
      return {
        title: `Bib ${issue.bib} is not on the start list`,
        body: 'Often a mistyped number. Check the bib, or keep it if this runner is not on the list.',
      };
    case 'repeat':
      return {
        title: `Bib ${issue.bib}${who} has already finished`,
        body: `It was entered earlier at ${formatGunTime(issue.earlier.gun_time ?? 0)}. In a single-lap race this is usually a mistyped number. If you keep it, both entries are flagged on Results to sort out later.`,
      };
  }
}

// Shown on the Bib screen (funnel mode) straight after an unexpected bib is
// saved. The entry is already recorded against the right tap, so "Undo" takes
// it back out and puts the finisher back at the head of the queue to retype.
export function BibCheckSheet({
  issues,
  onKeep,
  onUndo,
}: {
  issues: BibIssue[];
  onKeep: () => void;
  onUndo: () => void;
}) {
  const visible = issues.length > 0;
  const lines = issues.map(describe);
  const repeat = issues.some((i) => i.kind === 'repeat');

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onKeep}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          {lines.map((l, i) => (
            <View key={i} style={styles.issue}>
              <Text style={styles.title}>{l.title}</Text>
              <Text style={styles.body}>{l.body}</Text>
            </View>
          ))}
          <Pressable style={[styles.btn, styles.btnUndo]} onPress={onUndo}>
            <Text style={styles.btnText}>Undo and re-enter</Text>
          </Pressable>
          <Pressable style={[styles.btn, styles.btnKeep]} onPress={onKeep}>
            <Text style={styles.btnText}>{repeat ? 'Keep both, flag on Results' : 'Keep this entry'}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const mono = Platform.select({ ios: 'ui-monospace', default: 'monospace' });

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.8)',
    justifyContent: 'center',
    padding: 16,
  },
  card: {
    backgroundColor: '#1f1a0a',
    borderColor: '#f59e0b',
    borderWidth: 2,
    borderRadius: 16,
    padding: 20,
    gap: 14,
  },
  issue: {
    gap: 6,
  },
  title: {
    color: '#f59e0b',
    fontSize: 22,
    fontWeight: '800',
    fontFamily: mono,
  },
  body: {
    color: '#ddd',
    fontSize: 15,
    lineHeight: 21,
  },
  btn: {
    borderRadius: 14,
    paddingVertical: 20,
    alignItems: 'center',
  },
  btnUndo: {
    backgroundColor: '#7c2d12',
  },
  btnKeep: {
    backgroundColor: '#333',
  },
  btnText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
});
