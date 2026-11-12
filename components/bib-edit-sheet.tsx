import { useEffect, useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { participantDisplayName, type Participant } from '@/lib/db';

const mono = Platform.select({ ios: 'ui-monospace', default: 'monospace' });

export interface SheetAction {
  label: string;
  destructive?: boolean;
  onPress: () => void;
}

// A bib editor pinned to the TOP of the screen. An inline text field inside a
// long list gets covered by the on-screen keyboard (Android here draws the
// keyboard over the app rather than resizing it), so editing happens up here
// where the keyboard can't reach, with a live check of what the typed number
// means: whose bib it is, and whether another result already uses it. That
// check is what makes a transposed pair of digits obvious.
export function BibEditSheet({
  visible,
  title,
  subtitle,
  initialBib,
  saveLabel = 'Save',
  participants,
  bibPositions,
  ownPosition,
  actions = [],
  onSave,
  onCancel,
}: {
  visible: boolean;
  title: string;
  subtitle?: string;
  initialBib: string;
  saveLabel?: string;
  participants: Participant[];
  bibPositions: Map<string, number[]>; // bib -> positions of results currently using it
  ownPosition: number | null; // this row's own position, so it doesn't clash with itself
  actions?: SheetAction[];
  onSave: (bib: string) => void;
  onCancel: () => void;
}) {
  const [bib, setBib] = useState(initialBib);

  useEffect(() => {
    if (visible) setBib(initialBib);
  }, [visible, initialBib]);

  const trimmed = bib.trim();
  const participant = trimmed ? participants.find((p) => p.bib_number === trimmed) : undefined;
  const otherPositions = (bibPositions.get(trimmed) ?? []).filter((pos) => pos !== ownPosition);
  const changed = trimmed !== initialBib.trim();

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel}>
        {/* Inner pressable swallows taps so touching the card doesn't dismiss it */}
        <Pressable style={styles.sheet} onPress={() => {}}>
          <Text style={styles.title}>{title}</Text>
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}

          <TextInput
            style={styles.input}
            value={bib}
            onChangeText={setBib}
            placeholder="Bib number"
            placeholderTextColor="#555"
            autoFocus
            autoCapitalize="characters"
            autoCorrect={false}
            selectTextOnFocus
            returnKeyType="done"
            onSubmitEditing={() => trimmed && onSave(trimmed)}
          />

          <View style={styles.lookup}>
            {trimmed === '' ? null : participant ? (
              <Text style={styles.lookupOk}>{participantDisplayName(participant)}</Text>
            ) : participants.length > 0 ? (
              <Text style={styles.lookupWarn}>Not on the start list</Text>
            ) : null}
            {otherPositions.length > 0 && (
              <Text style={styles.lookupWarn}>
                Already used by position {otherPositions.join(', ')}
              </Text>
            )}
          </View>

          <View style={styles.row}>
            <Pressable style={styles.btnCancel} onPress={onCancel}>
              <Text style={styles.btnCancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.btnSave, (!trimmed || (!changed && saveLabel === 'Save')) && styles.btnDisabled]}
              disabled={!trimmed || (!changed && saveLabel === 'Save')}
              onPress={() => onSave(trimmed)}
            >
              <Text style={styles.btnSaveText}>{saveLabel}</Text>
            </Pressable>
          </View>

          {actions.length > 0 && (
            <View style={styles.actions}>
              {actions.map((a) => (
                <Pressable
                  key={a.label}
                  style={[styles.btnAction, a.destructive && styles.btnActionDestructive]}
                  onPress={a.onPress}
                >
                  <Text style={[styles.btnActionText, a.destructive && styles.btnActionTextDestructive]}>
                    {a.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'flex-start',
    paddingTop: 72,
    paddingHorizontal: 16,
  },
  sheet: {
    backgroundColor: '#1a1a1a',
    borderRadius: 16,
    padding: 18,
    gap: 12,
  },
  title: { color: '#fff', fontSize: 17, fontWeight: '700' },
  subtitle: { color: '#888', fontSize: 13, marginTop: -6 },
  input: {
    backgroundColor: '#0d0d0d',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#333',
    color: '#fff',
    fontFamily: mono,
    fontSize: 28,
    fontWeight: '700',
    paddingHorizontal: 16,
    paddingVertical: 12,
    textAlign: 'center',
    letterSpacing: 2,
  },
  lookup: { minHeight: 20, gap: 2, alignItems: 'center' },
  lookupOk: { color: '#4caf50', fontSize: 14, fontWeight: '600' },
  lookupWarn: { color: '#f59e0b', fontSize: 13, fontWeight: '600' },
  row: { flexDirection: 'row', gap: 10 },
  btnCancel: {
    flex: 1,
    backgroundColor: '#242424',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  btnCancelText: { color: '#aaa', fontSize: 15, fontWeight: '600' },
  btnSave: {
    flex: 2,
    backgroundColor: '#1b5e20',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  btnSaveText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  btnDisabled: { opacity: 0.4 },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: '#2a2a2a',
    paddingTop: 12,
  },
  btnAction: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#444',
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  btnActionDestructive: { borderColor: '#7f1d1d' },
  btnActionText: { color: '#bbb', fontSize: 13, fontWeight: '600' },
  btnActionTextDestructive: { color: '#f87171' },
});
