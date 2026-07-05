import { useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  createEvent,
  createRace,
  deleteRace,
  getEvents,
  getRacesByEvent,
  type Event,
  type Race,
} from '@/lib/db';

interface RaceRow {
  race: Race;
  event: Event;
}

function raceStatus(race: Race): string {
  if (race.start_time === null) return 'Not started';
  return 'In progress';
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export default function HomeScreen() {
  const db = useSQLiteContext();
  const router = useRouter();

  const [rows, setRows] = useState<RaceRow[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newMaxBib, setNewMaxBib] = useState('999');
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  const load = async () => {
    const events = await getEvents(db);
    const all: RaceRow[] = [];
    for (const event of events) {
      const races = await getRacesByEvent(db, event.id);
      for (const race of races) all.push({ race, event });
    }
    setRows(all);
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    const today = new Date().toISOString().slice(0, 10);
    const maxBib = Math.max(1, parseInt(newMaxBib, 10) || 999);
    const event = await createEvent(db, { name, date: today, location: null, status: 'pending' });
    const race = await createRace(db, { event_id: event.id, name, start_time: null, wave: 1, max_bib: maxBib });
    setCreating(false);
    setNewName('');
    setNewMaxBib('999');
    await load();
  };

  const handleDelete = async (raceId: string) => {
    setConfirmingDeleteId(null);
    await deleteRace(db, raceId);
    await load();
  };

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <FlatList
        data={rows}
        keyExtractor={(r) => r.race.id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={<Text style={styles.heading}>Races</Text>}
        ListEmptyComponent={
          <Text style={styles.empty}>No races yet.{'\n'}Tap + New Race to get started.</Text>
        }
        renderItem={({ item }) =>
          confirmingDeleteId === item.race.id ? (
            <View style={[styles.card, styles.cardConfirm]}>
              <Text style={styles.confirmText}>Delete &ldquo;{item.race.name}&rdquo;? This removes all its timestamps and results.</Text>
              <View style={styles.confirmActions}>
                <Pressable style={styles.btnCancel} onPress={() => setConfirmingDeleteId(null)}>
                  <Text style={styles.btnCancelText}>Cancel</Text>
                </Pressable>
                <Pressable style={styles.btnConfirmDelete} onPress={() => handleDelete(item.race.id)}>
                  <Text style={styles.btnConfirmDeleteText}>Delete</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <View style={styles.card}>
              <View style={styles.cardInfo}>
                <Text style={styles.raceName}>{item.race.name}</Text>
                <Text style={styles.raceMeta}>
                  {formatDate(item.event.date)} · {raceStatus(item.race)}
                </Text>
              </View>
              <View style={styles.cardActions}>
                <Pressable
                  style={[styles.actionBtn, styles.btnTimer]}
                  onPress={() => router.push(`/race/${item.race.id}/timer`)}
                >
                  <Text style={styles.actionBtnText}>Timer</Text>
                </Pressable>
                <Pressable
                  style={[styles.actionBtn, styles.btnBib]}
                  onPress={() => router.push(`/race/${item.race.id}/bib`)}
                >
                  <Text style={styles.actionBtnText}>Bib</Text>
                </Pressable>
                <Pressable
                  style={[styles.actionBtn, styles.btnResults]}
                  onPress={() => router.push(`/race/${item.race.id}/review`)}
                >
                  <Text style={styles.actionBtnText}>Results</Text>
                </Pressable>
                <Pressable
                  style={[styles.actionBtn, styles.btnDelete]}
                  onPress={() => setConfirmingDeleteId(item.race.id)}
                  hitSlop={8}
                >
                  <Text style={styles.actionBtnText}>✕</Text>
                </Pressable>
              </View>
            </View>
          )
        }
      />

      {/* New race form / button */}
      <View style={styles.footer}>
        {creating ? (
          <View style={styles.createForm}>
            <TextInput
              style={styles.input}
              placeholder="Race name"
              placeholderTextColor="#555"
              value={newName}
              onChangeText={setNewName}
              autoFocus
              returnKeyType="next"
            />
            <View style={styles.maxBibRow}>
              <Text style={styles.maxBibLabel}>Highest bib number</Text>
              <TextInput
                style={[styles.input, styles.maxBibInput]}
                placeholder="999"
                placeholderTextColor="#555"
                value={newMaxBib}
                onChangeText={setNewMaxBib}
                keyboardType="number-pad"
                returnKeyType="done"
                onSubmitEditing={handleCreate}
                selectTextOnFocus
              />
            </View>
            <View style={styles.createActions}>
              <Pressable style={styles.btnCancel} onPress={() => { setCreating(false); setNewName(''); setNewMaxBib('999'); }}>
                <Text style={styles.btnCancelText}>Cancel</Text>
              </Pressable>
              <Pressable style={[styles.btnCreate, !newName.trim() && styles.btnCreateDisabled]} onPress={handleCreate}>
                <Text style={styles.btnCreateText}>Create & Start</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <Pressable style={styles.newBtn} onPress={() => setCreating(true)}>
            <Text style={styles.newBtnText}>+ New Race</Text>
          </Pressable>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0d0d0d',
  },
  list: {
    padding: 16,
    gap: 12,
    flexGrow: 1,
  },
  heading: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 8,
  },
  empty: {
    color: '#444',
    fontSize: 16,
    textAlign: 'center',
    marginTop: 60,
    lineHeight: 26,
  },
  card: {
    backgroundColor: '#1a1a1a',
    borderRadius: 14,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  cardInfo: {
    flex: 1,
    gap: 4,
  },
  raceName: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
  },
  raceMeta: {
    color: '#555',
    fontSize: 13,
  },
  cardActions: {
    flexDirection: 'row',
    gap: 8,
  },
  actionBtn: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  btnTimer: {
    backgroundColor: '#1b5e20',
  },
  btnBib: {
    backgroundColor: '#1a237e',
  },
  btnResults: {
    backgroundColor: '#37474f',
  },
  btnDelete: {
    backgroundColor: '#3a1414',
    paddingHorizontal: 12,
  },
  actionBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  cardConfirm: {
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 14,
    borderWidth: 1,
    borderColor: '#5c1f1f',
  },
  confirmText: {
    color: '#eee',
    fontSize: 15,
    lineHeight: 21,
  },
  confirmActions: {
    flexDirection: 'row',
    gap: 10,
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
  footer: {
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: '#1a1a1a',
  },
  newBtn: {
    backgroundColor: '#1e1e1e',
    borderRadius: 14,
    padding: 18,
    alignItems: 'center',
  },
  newBtnText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
  },
  createForm: {
    gap: 12,
  },
  maxBibRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  maxBibLabel: {
    color: '#888',
    fontSize: 14,
    flex: 1,
  },
  maxBibInput: {
    flex: 0,
    width: 90,
    textAlign: 'center',
  },
  input: {
    backgroundColor: '#1e1e1e',
    borderRadius: 12,
    padding: 16,
    color: '#fff',
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#333',
  },
  createActions: {
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
  btnCreate: {
    flex: 2,
    backgroundColor: '#1b5e20',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
  },
  btnCreateDisabled: {
    opacity: 0.4,
  },
  btnCreateText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
});
