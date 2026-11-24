import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import { SafeAreaProvider, useSafeAreaInsets, type EdgeInsets } from 'react-native-safe-area-context';

import { ParticipantSheet, type EntrantFields } from '@/components/participant-sheet';
import {
  buildParticipants,
  type ColumnMapping,
  EMPTY_MAPPING,
  FIELD_LABELS,
  guessMapping,
  maxBibNumber,
  type ParsedCsv,
  parseCsv,
  type ParticipantField,
} from '@/lib/csv';
import {
  bulkUpsertParticipants,
  deleteParticipantsByRace,
  getParticipantsByRace,
  getRace,
  participantDisplayName as displayName,
  setParticipantStatus,
  setRaceFormat,
  setRaceMaxBib,
  updateParticipantDetails,
  upsertParticipant,
  type Participant,
  type ParticipantStatus,
  type Race,
} from '@/lib/db';

const FIELD_ORDER: ParticipantField[] = [
  'bibNumber',
  'firstName',
  'surname',
  'fullName',
  'teamName',
  'subCategory',
  'club',
  'category',
  'gender',
  'dob',
];

const CSV_MIME_TYPES = [
  'text/csv',
  'text/comma-separated-values',
  'application/csv',
  'application/vnd.ms-excel',
  'text/plain',
];

// A Modal is its own window on Android, so it needs its own SafeAreaProvider
// before it can read the system bar insets (status bar, gesture/nav bar).
function WithInsets({ render }: { render: (insets: EdgeInsets) => ReactNode }) {
  const insets = useSafeAreaInsets();
  return <>{render(insets)}</>;
}

const distinctSorted = (values: (string | null)[]): string[] =>
  [...new Set(values.filter((v): v is string => Boolean(v)))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );

type EntrantSheet = { mode: 'add'; initial: null } | { mode: 'edit'; initial: EntrantFields; id: string };

// ── Screen ────────────────────────────────────────────────────────────────────

export default function ParticipantsScreen() {
  const { raceId } = useLocalSearchParams<{ raceId: string }>();
  const db = useSQLiteContext();
  const insets = useSafeAreaInsets();
  const [entrantSheet, setEntrantSheet] = useState<EntrantSheet | null>(null);

  const [race, setRace] = useState<Race | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [confirmingClear, setConfirmingClear] = useState(false);

  // Import flow
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>(EMPTY_MAPPING);
  const [autoAssign, setAutoAssign] = useState(false);
  const [startNumber, setStartNumber] = useState('1');
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [importing, setImporting] = useState(false);

  const load = async () => {
    const [r, list] = await Promise.all([
      getRace(db, raceId),
      getParticipantsByRace(db, raceId),
    ]);
    setRace(r);
    setParticipants(list);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raceId]);

  // ── CSV pick + parse ──────────────────────────────────────────────────────────

  const handlePickFile = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: CSV_MIME_TYPES,
      copyToCacheDirectory: true,
    });
    if (result.canceled || result.assets.length === 0) return;

    const asset = result.assets[0];
    try {
      const text = await new File(asset.uri).text();
      const csv = parseCsv(text);
      if (csv.headers.length === 0 || csv.rows.length === 0) {
        Alert.alert('Empty file', 'That CSV has no rows to import.');
        return;
      }
      setFileName(asset.name);
      setParsed(csv);
      setMapping(guessMapping(csv.headers));
      setAutoAssign(false);
      setStartNumber('1');
      setReplaceExisting(false);
    } catch (e) {
      Alert.alert('Could not read file', String(e));
    }
  };

  const closeImport = () => {
    setParsed(null);
    setFileName(null);
  };

  // ── Live preview of the mapped + sorted + bib-assigned result ─────────────────

  const startNum = Math.max(1, parseInt(startNumber, 10) || 1);
  const built = useMemo(() => {
    if (!parsed) return null;
    return buildParticipants(parsed.rows, mapping, { autoAssignBib: autoAssign, startNumber: startNum });
  }, [parsed, mapping, autoAssign, startNum]);

  const hasIdentityMapping = Boolean(
    mapping.fullName || mapping.firstName || mapping.surname || mapping.teamName,
  );
  const canImport =
    Boolean(built && built.participants.length > 0) && (autoAssign || Boolean(mapping.bibNumber));

  const handleImport = async () => {
    if (!built || built.participants.length === 0) return;
    setImporting(true);
    try {
      if (replaceExisting) {
        await deleteParticipantsByRace(db, raceId);
      }
      const rows = built.participants.map((p) => ({ race_id: raceId, ...p }));
      const imported = await bulkUpsertParticipants(db, rows);

      const newMax = maxBibNumber(built.participants);
      if (race && newMax > race.max_bib) {
        await setRaceMaxBib(db, raceId, newMax);
      }

      await load();
      closeImport();
      const skipNotes = [
        built.skippedNoBib > 0 ? `${built.skippedNoBib} skipped — no bib number` : null,
        built.skippedNoIdentity > 0 ? `${built.skippedNoIdentity} skipped — no name or team` : null,
      ].filter(Boolean);
      Alert.alert(
        'Import complete',
        `${imported} participant${imported === 1 ? '' : 's'} imported.` +
          (skipNotes.length > 0 ? `\n${skipNotes.join('\n')}` : ''),
      );
    } catch (e) {
      Alert.alert('Import failed', String(e));
    } finally {
      setImporting(false);
    }
  };

  // ── Add / edit a single entrant ────────────────────────────────────────────────

  const suggestedBib = useMemo(() => {
    const numeric = participants.map((p) => parseInt(p.bib_number, 10)).filter((n) => !Number.isNaN(n));
    return String((numeric.length > 0 ? Math.max(...numeric) : 0) + 1);
  }, [participants]);
  const categories = useMemo(() => distinctSorted(participants.map((p) => p.category)), [participants]);
  const subCategories = useMemo(() => distinctSorted(participants.map((p) => p.sub_category)), [participants]);

  // Resolves to an error message for the sheet to show, or null once saved.
  const handleSaveEntrant = async (fields: EntrantFields): Promise<string | null> => {
    if (!entrantSheet) return null;
    try {
      if (!(fields.first_name || fields.last_name || fields.team_name)) {
        return 'Add a first or last name, or a team name.';
      }
      if (entrantSheet.mode === 'edit') {
        await updateParticipantDetails(db, entrantSheet.id, fields);
      } else {
        if (!fields.bib_number) return 'Enter a bib number.';
        const clash = participants.find((p) => p.bib_number === fields.bib_number);
        if (clash) {
          return `Bib ${fields.bib_number} already belongs to ${displayName(clash)}. Tap that entry to edit it instead.`;
        }
        await upsertParticipant(db, { race_id: raceId, ...fields });
        // The Bib screen sizes its digit boxes (and auto-submit) from the
        // highest expected bib, so a late entry above it has to raise it.
        const n = parseInt(fields.bib_number, 10);
        if (race && !Number.isNaN(n) && n > race.max_bib) await setRaceMaxBib(db, raceId, n);
      }
      await load();
      setEntrantSheet(null);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

  // ── DNS / DNF ─────────────────────────────────────────────────────────────────

  const [search, setSearch] = useState('');
  const visibleParticipants = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return participants;
    return participants.filter(
      (p) => p.bib_number.toLowerCase().startsWith(q) || displayName(p).toLowerCase().includes(q),
    );
  }, [participants, search]);
  const dnsCount = participants.filter((p) => p.status === 'dns').length;
  const dnfCount = participants.filter((p) => p.status === 'dnf').length;

  const saveStatus = async (p: Participant, status: ParticipantStatus | null) => {
    await setParticipantStatus(db, p.id, status);
    await load();
  };

  const handleStatus = (p: Participant) => {
    Alert.alert(`Bib ${p.bib_number}: ${displayName(p)}`, 'Mark this entrant as:', [
      { text: 'DNS (did not start)', onPress: () => saveStatus(p, 'dns') },
      { text: 'DNF (did not finish)', onPress: () => saveStatus(p, 'dnf') },
      p.status
        ? { text: 'Clear, they are racing', onPress: () => saveStatus(p, null) }
        : { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const handleToggleFormat = async (laps: boolean) => {
    await setRaceFormat(db, raceId, laps ? 'laps' : 'single');
    await load();
  };

  const handleClearAll = async () => {
    setConfirmingClear(false);
    await deleteParticipantsByRace(db, raceId);
    await load();
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
      <Stack.Screen
        options={{
          title: race?.name ?? 'Participants',
          headerStyle: { backgroundColor: '#0d0d0d' },
          headerTintColor: '#fff',
        }}
      />

      <FlatList
        style={styles.list}
        data={visibleParticipants}
        keyExtractor={(p) => p.id}
        // The Android nav bar / gesture area sits over the bottom of the screen,
        // so the last rows and the Clear buttons need to clear it.
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View>
            <View style={styles.header}>
              <Text style={styles.count}>
                {participants.length} participant{participants.length === 1 ? '' : 's'}
              </Text>
              <View style={styles.headerButtons}>
                <Pressable style={styles.addBtn} onPress={() => setEntrantSheet({ mode: 'add', initial: null })}>
                  <Text style={styles.importBtnText}>+ Add</Text>
                </Pressable>
                <Pressable style={styles.importBtn} onPress={handlePickFile}>
                  <Text style={styles.importBtnText}>Import CSV</Text>
                </Pressable>
              </View>
            </View>

            <View style={styles.formatRow}>
              <View style={styles.rowInfo}>
                <Text style={styles.name}>Multi-lap race</Text>
                <Text style={styles.meta}>
                  {race?.format === 'laps'
                    ? 'A bib crossing again counts as another lap.'
                    : 'Single lap. A bib entered twice is flagged as a likely typo.'}
                </Text>
              </View>
              <Switch value={race?.format === 'laps'} onValueChange={handleToggleFormat} />
            </View>

            {participants.length > 0 && (
              <>
                <TextInput
                  style={styles.search}
                  placeholder="Find by bib or name"
                  placeholderTextColor="#555"
                  value={search}
                  onChangeText={setSearch}
                  autoCorrect={false}
                  clearButtonMode="while-editing"
                />
                <Text style={styles.statusSummary}>
                  {dnsCount} DNS · {dnfCount} DNF. Tap the status button on an entrant to mark them as not starting or
                  not finishing, so they are not chased on Results.
                </Text>
              </>
            )}
          </View>
        }
        ListEmptyComponent={
          <Text style={styles.empty}>
            No participants loaded yet.{'\n'}Import a CSV or tap + Add to get started.
          </Text>
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() =>
              setEntrantSheet({
                mode: 'edit',
                id: item.id,
                initial: {
                  bib_number: item.bib_number,
                  first_name: item.first_name,
                  last_name: item.last_name,
                  gender: item.gender,
                  dob: item.dob,
                  club: item.club,
                  category: item.category,
                  team_name: item.team_name,
                  sub_category: item.sub_category,
                },
              })
            }
          >
            <Text style={styles.bib}>{item.bib_number}</Text>
            <View style={styles.rowInfo}>
              <Text style={styles.name}>{displayName(item)}</Text>
              {(item.sub_category || item.category || item.gender || item.club) && (
                <Text style={styles.meta}>
                  {[item.sub_category, item.category, item.gender, item.club].filter(Boolean).join(' · ')}
                </Text>
              )}
            </View>
            <Pressable
              style={[styles.statusBtn, item.status && styles.statusBtnSet]}
              onPress={() => handleStatus(item)}
              hitSlop={6}
            >
              <Text style={[styles.statusBtnText, item.status && styles.statusBtnTextSet]}>
                {item.status ? item.status.toUpperCase() : 'DNS/DNF'}
              </Text>
            </Pressable>
          </Pressable>
        )}
        ListFooterComponent={
          participants.length > 0 ? (
            confirmingClear ? (
              <View style={styles.clearConfirm}>
                <Text style={styles.clearConfirmText}>Remove all participants for this race?</Text>
                <View style={styles.clearConfirmActions}>
                  <Pressable style={styles.btnCancel} onPress={() => setConfirmingClear(false)}>
                    <Text style={styles.btnCancelText}>Cancel</Text>
                  </Pressable>
                  <Pressable style={styles.btnConfirmDelete} onPress={handleClearAll}>
                    <Text style={styles.btnConfirmDeleteText}>Remove All</Text>
                  </Pressable>
                </View>
              </View>
            ) : (
              <Pressable style={styles.clearBtn} onPress={() => setConfirmingClear(true)}>
                <Text style={styles.clearBtnText}>Clear all participants</Text>
              </Pressable>
            )
          ) : null
        }
      />

      {/* ── Column mapping modal ── */}
      <Modal visible={parsed !== null} animationType="slide" onRequestClose={closeImport}>
        <SafeAreaProvider>
          <WithInsets
            render={(modalInsets) => (
        <View style={[styles.modalRoot, { paddingTop: modalInsets.top }]}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Map CSV Columns</Text>
            <Text style={styles.modalSubtitle}>
              {fileName} · {parsed?.rows.length ?? 0} rows
            </Text>
          </View>

          <ScrollView style={styles.modalBody} contentContainerStyle={{ paddingBottom: 24 }}>
            {/* Bib number source */}
            <View style={styles.optionRow}>
              <View style={styles.optionLabel}>
                <Text style={styles.optionTitle}>Auto-assign bib numbers</Text>
                <Text style={styles.optionSubtitle}>
                  {mapping.subCategory
                    ? 'Groups by sub-category first (contiguous bib blocks), then sorts by ' +
                      'surname (or team name), then first name, from a start number'
                    : 'Sorts alphabetically by surname (or team name), then first name, and ' +
                      'numbers from a start number'}
                </Text>
              </View>
              <Switch value={autoAssign} onValueChange={setAutoAssign} />
            </View>

            {autoAssign ? (
              <View style={styles.startNumberRow}>
                <Text style={styles.startNumberLabel}>Start number</Text>
                <TextInput
                  style={styles.startNumberInput}
                  value={startNumber}
                  onChangeText={setStartNumber}
                  keyboardType="number-pad"
                  selectTextOnFocus
                />
              </View>
            ) : null}

            {/* Column pickers */}
            {parsed &&
              FIELD_ORDER.filter((field) => field !== 'bibNumber' || !autoAssign).map((field) => (
                <MappingRow
                  key={field}
                  label={FIELD_LABELS[field]}
                  headers={parsed.headers}
                  value={mapping[field]}
                  onChange={(header) => setMapping((m) => ({ ...m, [field]: header }))}
                />
              ))}

            {!hasIdentityMapping && (
              <Text style={styles.warning}>
                No name or team column mapped — rows will be skipped unless they have one.
              </Text>
            )}

            {/* Replace existing */}
            <View style={styles.optionRow}>
              <View style={styles.optionLabel}>
                <Text style={styles.optionTitle}>Replace existing participants</Text>
                <Text style={styles.optionSubtitle}>
                  Removes the current list for this race before importing
                </Text>
              </View>
              <Switch value={replaceExisting} onValueChange={setReplaceExisting} />
            </View>

            {/* Preview */}
            {built && (
              <View style={styles.previewBox}>
                <Text style={styles.previewSummary}>
                  {built.participants.length} will be imported
                  {built.skippedNoBib > 0 ? ` · ${built.skippedNoBib} skipped (no bib)` : ''}
                  {built.skippedNoIdentity > 0 ? ` · ${built.skippedNoIdentity} skipped (no name/team)` : ''}
                </Text>
                {built.participants.slice(0, 4).map((p, i) => (
                  <Text key={i} style={styles.previewRow}>
                    #{p.bib_number}  {displayName(p)}
                    {p.sub_category ? `  (${p.sub_category})` : ''}
                  </Text>
                ))}
              </View>
            )}
          </ScrollView>

          <View style={[styles.modalFooter, { paddingBottom: 16 + modalInsets.bottom }]}>
            <Pressable style={styles.btnCancel} onPress={closeImport} disabled={importing}>
              <Text style={styles.btnCancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.btnImport, (!canImport || importing) && styles.btnImportDisabled]}
              onPress={handleImport}
              disabled={!canImport || importing}
            >
              <Text style={styles.btnImportText}>
                {importing ? 'Importing…' : `Import ${built?.participants.length ?? 0}`}
              </Text>
            </Pressable>
          </View>
        </View>
            )}
          />
        </SafeAreaProvider>
      </Modal>

      {/* ── Add / edit one entrant ── */}
      <ParticipantSheet
        visible={entrantSheet !== null}
        mode={entrantSheet?.mode ?? 'add'}
        initial={entrantSheet?.initial ?? null}
        suggestedBib={suggestedBib}
        categories={categories}
        subCategories={subCategories}
        onSave={handleSaveEntrant}
        onCancel={() => setEntrantSheet(null)}
      />
    </>
  );
}

// ── Column mapping row ────────────────────────────────────────────────────────

function MappingRow({
  label,
  headers,
  value,
  onChange,
}: {
  label: string;
  headers: string[];
  value: string | null;
  onChange: (header: string | null) => void;
}) {
  return (
    <View style={styles.mappingRow}>
      <Text style={styles.mappingLabel}>{label}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
        <Pressable style={[styles.chip, value === null && styles.chipSelected]} onPress={() => onChange(null)}>
          <Text style={[styles.chipText, value === null && styles.chipTextSelected]}>None</Text>
        </Pressable>
        {headers.map((h) => (
          <Pressable
            key={h}
            style={[styles.chip, value === h && styles.chipSelected]}
            onPress={() => onChange(h)}
          >
            <Text style={[styles.chipText, value === h && styles.chipTextSelected]}>{h}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const mono = Platform.select({ ios: 'ui-monospace', default: 'monospace' });

const styles = StyleSheet.create({
  list: {
    flex: 1,
    backgroundColor: '#0d0d0d',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
  },
  count: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
  },
  headerButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  addBtn: {
    backgroundColor: '#1a237e',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 10,
  },
  formatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#161616',
  },
  search: {
    marginHorizontal: 16,
    backgroundColor: '#161616',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2a2a2a',
    color: '#fff',
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  statusSummary: {
    color: '#666',
    fontSize: 12,
    lineHeight: 17,
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 8,
  },
  statusBtn: {
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
    minWidth: 64,
    alignItems: 'center',
  },
  statusBtnSet: {
    borderColor: '#f59e0b',
    backgroundColor: '#2b1f00',
  },
  statusBtnText: {
    color: '#666',
    fontSize: 11,
    fontWeight: '600',
  },
  statusBtnTextSet: {
    color: '#f59e0b',
    fontSize: 13,
    fontWeight: '800',
  },
  importBtn: {
    backgroundColor: '#1b5e20',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 10,
  },
  importBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  empty: {
    color: '#444',
    fontSize: 15,
    textAlign: 'center',
    marginTop: 60,
    lineHeight: 22,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#141414',
    gap: 14,
  },
  bib: {
    color: '#4caf50',
    fontFamily: mono,
    fontSize: 15,
    fontWeight: '700',
    minWidth: 44,
  },
  rowInfo: {
    flex: 1,
    gap: 2,
  },
  name: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  meta: {
    color: '#666',
    fontSize: 12,
  },
  clearBtn: {
    margin: 16,
    padding: 14,
    borderRadius: 12,
    backgroundColor: '#1e1e1e',
    alignItems: 'center',
  },
  clearBtnText: {
    color: '#f59e0b',
    fontSize: 14,
    fontWeight: '600',
  },
  clearConfirm: {
    margin: 16,
    padding: 16,
    borderRadius: 12,
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#5c1f1f',
    gap: 14,
  },
  clearConfirmText: {
    color: '#eee',
    fontSize: 14,
    lineHeight: 20,
  },
  clearConfirmActions: {
    flexDirection: 'row',
    gap: 10,
  },
  btnCancel: {
    flex: 1,
    backgroundColor: '#1e1e1e',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
  },
  btnCancelText: {
    color: '#888',
    fontSize: 15,
    fontWeight: '500',
  },
  btnConfirmDelete: {
    flex: 1,
    backgroundColor: '#7f1d1d',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
  },
  btnConfirmDeleteText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },

  // Modal
  modalRoot: {
    flex: 1,
    backgroundColor: '#0d0d0d',
  },
  modalHeader: {
    padding: 20,
    paddingTop: 24,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
    gap: 4,
  },
  modalTitle: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
  },
  modalSubtitle: {
    color: '#666',
    fontSize: 13,
  },
  modalBody: {
    flex: 1,
    padding: 16,
  },
  modalFooter: {
    flexDirection: 'row',
    gap: 10,
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: '#1a1a1a',
  },
  btnImport: {
    flex: 2,
    backgroundColor: '#1b5e20',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
  },
  btnImportDisabled: {
    opacity: 0.4,
  },
  btnImportText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },

  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  optionLabel: {
    flex: 1,
    gap: 3,
  },
  optionTitle: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  optionSubtitle: {
    color: '#666',
    fontSize: 12,
    lineHeight: 16,
  },
  startNumberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 14,
    marginTop: -4,
    marginBottom: 12,
  },
  startNumberLabel: {
    color: '#888',
    fontSize: 14,
  },
  startNumberInput: {
    backgroundColor: '#0d0d0d',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#333',
    color: '#fff',
    fontSize: 15,
    paddingVertical: 8,
    paddingHorizontal: 14,
    width: 80,
    textAlign: 'center',
  },

  mappingRow: {
    marginBottom: 14,
  },
  mappingLabel: {
    color: '#888',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 6,
  },
  chipRow: {
    gap: 8,
  },
  chip: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 20,
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  chipSelected: {
    backgroundColor: '#1b5e20',
    borderColor: '#4caf50',
  },
  chipText: {
    color: '#888',
    fontSize: 13,
    fontWeight: '500',
  },
  chipTextSelected: {
    color: '#fff',
  },

  warning: {
    color: '#f59e0b',
    fontSize: 12,
    marginBottom: 12,
    lineHeight: 17,
  },

  previewBox: {
    backgroundColor: '#111',
    borderRadius: 12,
    padding: 14,
    gap: 4,
  },
  previewSummary: {
    color: '#4caf50',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 4,
  },
  previewRow: {
    color: '#888',
    fontFamily: mono,
    fontSize: 13,
  },
});
