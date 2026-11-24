import { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useRaceStore } from '@/lib/store';

// Splits a stored "First Last" back into the two fields for editing.
function splitName(full: string | null): { first: string; last: string } {
  if (!full) return { first: '', last: '' };
  const [first, ...rest] = full.split(' ');
  return { first, last: rest.join(' ') };
}

// First + last name fields with a save button. Used by the start-up prompt and
// the Settings screen, so both validate the same way.
export function OperatorNameForm({
  initial,
  saveLabel,
  onSaved,
}: {
  initial: string | null;
  saveLabel: string;
  onSaved?: () => void;
}) {
  const setOperatorName = useRaceStore((s) => s.setOperatorName);
  const start = splitName(initial);
  const [first, setFirst] = useState(start.first);
  const [last, setLast] = useState(start.last);

  const full = `${first.trim()} ${last.trim()}`.trim();
  const canSave = first.trim().length > 0 && last.trim().length > 0;

  const save = async () => {
    if (!canSave) return;
    await setOperatorName(full);
    onSaved?.();
  };

  return (
    <View style={styles.form}>
      <TextInput
        style={styles.input}
        placeholder="First name"
        placeholderTextColor="#555"
        value={first}
        onChangeText={setFirst}
        autoCapitalize="words"
        autoCorrect={false}
        textContentType="givenName"
        returnKeyType="next"
      />
      <TextInput
        style={styles.input}
        placeholder="Last name"
        placeholderTextColor="#555"
        value={last}
        onChangeText={setLast}
        autoCapitalize="words"
        autoCorrect={false}
        textContentType="familyName"
        returnKeyType="done"
        onSubmitEditing={save}
      />
      <Pressable style={[styles.btn, !canSave && styles.btnDisabled]} onPress={save} disabled={!canSave}>
        <Text style={styles.btnText}>{saveLabel}</Text>
      </Pressable>
    </View>
  );
}

// Asks for the operator's name every time the app opens until one is saved.
// "Not now" only hides it until the next launch, so a quick check of the app
// is never blocked, but nobody can go a whole race day without being asked.
export function OperatorNamePrompt() {
  const settingsLoaded = useRaceStore((s) => s.settingsLoaded);
  const operatorName = useRaceStore((s) => s.operatorName);
  const [dismissed, setDismissed] = useState(false);

  const visible = settingsLoaded && !operatorName && !dismissed;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => setDismissed(true)}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={styles.card}>
          <Text style={styles.title}>Who is using this phone?</Text>
          <Text style={styles.body}>
            Your name is saved with every tap and bib you record, so the results team can tell whose data is whose.
            You can change it in Settings.
          </Text>
          <OperatorNameForm initial={null} saveLabel="Save name" />
          <Pressable style={styles.skip} onPress={() => setDismissed(true)} hitSlop={8}>
            <Text style={styles.skipText}>Not now</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'center',
    padding: 20,
  },
  card: {
    backgroundColor: '#1a1a1a',
    borderRadius: 16,
    padding: 20,
    gap: 12,
  },
  title: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
  },
  body: {
    color: '#999',
    fontSize: 14,
    lineHeight: 20,
  },
  form: {
    gap: 10,
  },
  input: {
    backgroundColor: '#0d0d0d',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#333',
    color: '#fff',
    fontSize: 17,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  btn: {
    backgroundColor: '#1b5e20',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  btnDisabled: {
    opacity: 0.4,
  },
  btnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  skip: {
    alignSelf: 'center',
    paddingVertical: 6,
  },
  skipText: {
    color: '#777',
    fontSize: 14,
  },
});
