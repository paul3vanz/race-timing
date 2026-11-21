import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import { useKeyboardHeight } from '@/hooks/use-keyboard-height';
import type { Participant } from '@/lib/db';
import { normalizeGender } from '@/lib/report';

export type EntrantFields = Pick<
  Participant,
  'bib_number' | 'first_name' | 'last_name' | 'gender' | 'dob' | 'club' | 'category' | 'team_name' | 'sub_category'
>;

const EMPTY: EntrantFields = {
  bib_number: '',
  first_name: null,
  last_name: null,
  gender: null,
  dob: null,
  club: null,
  category: null,
  team_name: null,
  sub_category: null,
};

const orNull = (v: string): string | null => (v.trim() === '' ? null : v.trim());

// Add or edit one entrant. Used on the day for a runner who hands their place
// to someone who isn't on the imported list, or for a late entry. Save and
// Cancel live in the header, not at the bottom: the on-screen keyboard (and the
// Android navigation bar) cover the bottom of the screen.
export function ParticipantSheet({
  visible,
  mode,
  initial,
  suggestedBib,
  categories,
  subCategories,
  onSave,
  onCancel,
}: {
  visible: boolean;
  mode: 'add' | 'edit';
  initial: EntrantFields | null;
  suggestedBib: string;
  categories: string[];
  subCategories: string[];
  onSave: (fields: EntrantFields) => Promise<string | null>; // resolves to an error message, or null when saved
  onCancel: () => void;
}) {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel}>
      {/* A Modal is its own window on Android, so it needs its own insets. */}
      <SafeAreaProvider>
        <SheetBody
          mode={mode}
          initial={initial}
          suggestedBib={suggestedBib}
          categories={categories}
          subCategories={subCategories}
          onSave={onSave}
          onCancel={onCancel}
        />
      </SafeAreaProvider>
    </Modal>
  );
}

function SheetBody({
  mode,
  initial,
  suggestedBib,
  categories,
  subCategories,
  onSave,
  onCancel,
}: {
  mode: 'add' | 'edit';
  initial: EntrantFields | null;
  suggestedBib: string;
  categories: string[];
  subCategories: string[];
  onSave: (fields: EntrantFields) => Promise<string | null>;
  onCancel: () => void;
}) {
  const insets = useSafeAreaInsets();
  const keyboardHeight = useKeyboardHeight();

  const start = initial ?? { ...EMPTY, bib_number: suggestedBib };
  const [bib, setBib] = useState(start.bib_number);
  const [first, setFirst] = useState(start.first_name ?? '');
  const [last, setLast] = useState(start.last_name ?? '');
  const [team, setTeam] = useState(start.team_name ?? '');
  const [gender, setGender] = useState<string | null>(start.gender);
  const [dob, setDob] = useState(start.dob ?? '');
  const [club, setClub] = useState(start.club ?? '');
  const [category, setCategory] = useState(start.category ?? '');
  const [subCategory, setSubCategory] = useState(start.sub_category ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // No reset-on-open needed: a Modal unmounts its children while hidden, so this
  // body starts fresh (from initial) every time the sheet is opened.

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    const message = await onSave({
      bib_number: bib.trim(),
      first_name: orNull(first),
      last_name: orNull(last),
      gender,
      dob: orNull(dob),
      club: orNull(club),
      category: orNull(category),
      team_name: orNull(team),
      sub_category: orNull(subCategory),
    });
    if (message) {
      setError(message);
      setSaving(false);
    }
  };

  const genderValue = normalizeGender(gender);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={onCancel} hitSlop={10} disabled={saving}>
          <Text style={styles.headerCancel}>Cancel</Text>
        </Pressable>
        <Text style={styles.headerTitle}>{mode === 'add' ? 'Add entrant' : 'Edit entrant'}</Text>
        <Pressable onPress={handleSave} hitSlop={10} disabled={saving} style={[styles.saveBtn, saving && styles.disabled]}>
          <Text style={styles.saveBtnText}>{saving ? 'Saving…' : 'Save'}</Text>
        </Pressable>
      </View>

      <ScrollView
        style={styles.body}
        contentContainerStyle={{ padding: 16, paddingBottom: 32 + insets.bottom + keyboardHeight, gap: 14 }}
        keyboardShouldPersistTaps="handled"
      >
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Field label="Bib number" hint={mode === 'edit' ? 'The bib stays the same. Change the person, not the number.' : undefined}>
          <TextInput
            style={[styles.input, mode === 'edit' && styles.inputLocked]}
            value={bib}
            onChangeText={setBib}
            editable={mode === 'add'}
            autoCapitalize="characters"
            autoCorrect={false}
            placeholderTextColor="#555"
          />
        </Field>

        <View style={styles.twoCol}>
          <View style={styles.col}>
            <Field label="First name">
              <TextInput style={styles.input} value={first} onChangeText={setFirst} placeholderTextColor="#555" />
            </Field>
          </View>
          <View style={styles.col}>
            <Field label="Last name">
              <TextInput style={styles.input} value={last} onChangeText={setLast} placeholderTextColor="#555" />
            </Field>
          </View>
        </View>

        <Field label="Team name" hint="Only for a team entry that shares one bib. Leave the names empty for these.">
          <TextInput style={styles.input} value={team} onChangeText={setTeam} placeholderTextColor="#555" />
        </Field>

        <Field label="Gender">
          <View style={styles.chipRow}>
            {([['Male', 'Male'], ['Female', 'Female'], ['Not set', null]] as const).map(([label, value]) => {
              const selected = value === null ? genderValue === null && !gender : genderValue === value;
              return (
                <Pressable
                  key={label}
                  style={[styles.chip, selected && styles.chipSelected]}
                  onPress={() => setGender(value)}
                >
                  <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
        </Field>

        <Field label="Category (age group)">
          <TextInput style={styles.input} value={category} onChangeText={setCategory} placeholderTextColor="#555" />
          <Suggestions values={categories} current={category} onPick={setCategory} />
        </Field>

        <Field label="Sub-category (e.g. Solo / Pair / Team)">
          <TextInput style={styles.input} value={subCategory} onChangeText={setSubCategory} placeholderTextColor="#555" />
          <Suggestions values={subCategories} current={subCategory} onPick={setSubCategory} />
        </Field>

        <Field label="Club">
          <TextInput style={styles.input} value={club} onChangeText={setClub} placeholderTextColor="#555" />
        </Field>

        <Field label="Date of birth">
          <TextInput
            style={styles.input}
            value={dob}
            onChangeText={setDob}
            placeholder="YYYY-MM-DD"
            placeholderTextColor="#555"
          />
        </Field>
      </ScrollView>
    </View>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

// Existing values from the start list, one tap to reuse, so a late entry lands
// in exactly the same category label as everyone else's (prize categories group
// on the exact text).
function Suggestions({
  values,
  current,
  onPick,
}: {
  values: string[];
  current: string;
  onPick: (v: string) => void;
}) {
  if (values.length === 0) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.suggestionRow} keyboardShouldPersistTaps="handled">
      {values.map((v) => (
        <Pressable key={v} style={[styles.chip, current === v && styles.chipSelected]} onPress={() => onPick(v)}>
          <Text style={[styles.chipText, current === v && styles.chipTextSelected]}>{v}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0d0d0d' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  headerTitle: { color: '#fff', fontSize: 17, fontWeight: '700' },
  headerCancel: { color: '#888', fontSize: 15, fontWeight: '500' },
  saveBtn: { backgroundColor: '#1b5e20', borderRadius: 10, paddingVertical: 8, paddingHorizontal: 18 },
  saveBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  disabled: { opacity: 0.5 },
  body: { flex: 1 },
  error: { color: '#f87171', fontSize: 14, fontWeight: '600', lineHeight: 20 },
  field: { gap: 6 },
  label: { color: '#888', fontSize: 13, fontWeight: '600' },
  hint: { color: '#555', fontSize: 12, lineHeight: 16 },
  input: {
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2a2a2a',
    color: '#fff',
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  inputLocked: { color: '#777', backgroundColor: '#131313' },
  twoCol: { flexDirection: 'row', gap: 12 },
  col: { flex: 1 },
  chipRow: { flexDirection: 'row', gap: 8 },
  suggestionRow: { gap: 8, paddingTop: 2 },
  chip: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 20,
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  chipSelected: { backgroundColor: '#1b5e20', borderColor: '#4caf50' },
  chipText: { color: '#888', fontSize: 13, fontWeight: '500' },
  chipTextSelected: { color: '#fff' },
});
