import { useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  Share,
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
  updateEventStatus,
  type Event,
  type Race,
} from '@/lib/db';
import { isSupabaseConfigured } from '@/lib/supabase';
import { lookupEventByJoinCode, pullRace } from '@/lib/sync';

interface RaceRow {
  race: Race;
  event: Event;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function raceStatus(race: Race, event: Event): string {
  if (event.status === 'finished') return 'Finished';
  if (race.start_time === null) return 'Not started';
  return 'In progress';
}

// A race that's been "in progress" for days is almost certainly one nobody
// stopped; call it out so it can be closed off.
function staleDays(race: Race, event: Event): number {
  if (event.status === 'finished' || race.start_time === null) return 0;
  const days = Math.floor((Date.now() - race.start_time) / DAY_MS);
  return days >= 1 ? days : 0;
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
  const listRef = useRef<FlatList<RaceRow>>(null);

  const [rows, setRows] = useState<RaceRow[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newMaxBib, setNewMaxBib] = useState('999');
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [confirmingStopId, setConfirmingStopId] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [joinBusy, setJoinBusy] = useState(false);

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

  // The create/join forms live at the TOP of the list, not in a footer: on
  // Android the on-screen keyboard covers anything pinned to the bottom of the
  // screen, and the join code is typed with the keyboard up. Scroll to the top
  // so the form is on screen when it opens.
  const openForm = (which: 'create' | 'join') => {
    setCreating(which === 'create');
    setJoining(which === 'join');
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    const today = new Date().toISOString().slice(0, 10);
    const maxBib = Math.max(1, parseInt(newMaxBib, 10) || 999);
    const event = await createEvent(db, { name, date: today, location: null, status: 'pending' });
    await createRace(db, { event_id: event.id, name, start_time: null, wave: 1, max_bib: maxBib });
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

  const handleSetStopped = async (event: Event, stopped: boolean) => {
    setConfirmingStopId(null);
    // Reopening a race that never started goes back to pending, not active.
    const row = rows.find((r) => r.event.id === event.id);
    const reopenStatus: Event['status'] = row?.race.start_time === null ? 'pending' : 'active';
    await updateEventStatus(db, event.id, stopped ? 'finished' : reopenStatus);
    await load();
  };

  const handleJoin = async () => {
    const code = joinCode.trim();
    if (!code) return;
    setJoinBusy(true);
    try {
      const match = await lookupEventByJoinCode(code);
      if (!match) {
        Alert.alert('Not found', `No race found for code "${code.toUpperCase()}".`);
        return;
      }
      await pullRace(db, match.eventId, match.raceId);
      setJoining(false);
      setJoinCode('');
      await load();
    } catch (e) {
      Alert.alert('Join failed', e instanceof Error ? e.message : String(e));
    } finally {
      setJoinBusy(false);
    }
  };

  const handleShareCode = (race: Race, event: Event) => {
    if (!event.join_code) return;
    Share.share({
      message: `Join "${race.name}" on Race Timing, code ${event.join_code}`,
    });
  };

  const formVisible = creating || joining;

  return (
    <View style={styles.root}>
      <FlatList
        ref={listRef}
        data={rows}
        keyExtractor={(r) => r.race.id}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={styles.heading}>Races</Text>

            {creating && (
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
            )}

            {joining && (
              <View style={styles.createForm}>
                <TextInput
                  style={[styles.input, styles.joinInput]}
                  placeholder="6-character code"
                  placeholderTextColor="#555"
                  value={joinCode}
                  onChangeText={(v) => setJoinCode(v.toUpperCase())}
                  autoCapitalize="characters"
                  autoFocus
                  autoCorrect={false}
                  maxLength={6}
                  returnKeyType="done"
                  onSubmitEditing={handleJoin}
                />
                <View style={styles.createActions}>
                  <Pressable style={styles.btnCancel} onPress={() => { setJoining(false); setJoinCode(''); }}>
                    <Text style={styles.btnCancelText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.btnCreate, (!joinCode.trim() || joinBusy) && styles.btnCreateDisabled]}
                    onPress={handleJoin}
                    disabled={!joinCode.trim() || joinBusy}
                  >
                    <Text style={styles.btnCreateText}>{joinBusy ? 'Joining…' : 'Join'}</Text>
                  </Pressable>
                </View>
              </View>
            )}
          </View>
        }
        ListEmptyComponent={
          <Text style={styles.empty}>No races yet.{'\n'}Tap + New Race to get started.</Text>
        }
        renderItem={({ item }) => {
          if (confirmingDeleteId === item.race.id) {
            return (
              <View style={[styles.card, styles.cardConfirm]}>
                <Text style={styles.confirmText}>Delete &ldquo;{item.race.name}&rdquo;? This removes all its timestamps and results from this device.</Text>
                <View style={styles.confirmActions}>
                  <Pressable style={styles.btnCancel} onPress={() => setConfirmingDeleteId(null)}>
                    <Text style={styles.btnCancelText}>Cancel</Text>
                  </Pressable>
                  <Pressable style={styles.btnConfirmDelete} onPress={() => handleDelete(item.race.id)}>
                    <Text style={styles.btnConfirmDeleteText}>Delete</Text>
                  </Pressable>
                </View>
              </View>
            );
          }

          if (confirmingStopId === item.race.id) {
            return (
              <View style={[styles.card, styles.cardConfirmStop]}>
                <Text style={styles.confirmText}>
                  Stop &ldquo;{item.race.name}&rdquo;? Timers and Bib entry will stop recording on every device. Results stay available and can still be corrected. You can reopen it later.
                </Text>
                <View style={styles.confirmActions}>
                  <Pressable style={styles.btnCancel} onPress={() => setConfirmingStopId(null)}>
                    <Text style={styles.btnCancelText}>Cancel</Text>
                  </Pressable>
                  <Pressable style={styles.btnConfirmStop} onPress={() => handleSetStopped(item.event, true)}>
                    <Text style={styles.btnConfirmDeleteText}>Stop race</Text>
                  </Pressable>
                </View>
              </View>
            );
          }

          const status = raceStatus(item.race, item.event);
          const stale = staleDays(item.race, item.event);
          const inProgress = status === 'In progress';
          const finished = status === 'Finished';

          return (
            <View style={styles.card}>
              <View style={styles.cardInfo}>
                <Text style={styles.raceName}>{item.race.name}</Text>
                <Text style={styles.raceMeta}>
                  {formatDate(item.event.date)} · <Text style={finished ? styles.statusFinished : inProgress ? styles.statusLive : undefined}>{status}</Text>
                </Text>
                {stale > 0 && (
                  <Text style={styles.staleNote}>
                    Started {stale} {stale === 1 ? 'day' : 'days'} ago and never stopped
                  </Text>
                )}
                {item.event.join_code && (
                  <Pressable onPress={() => handleShareCode(item.race, item.event)} hitSlop={6}>
                    <Text style={styles.joinCode}>Code: {item.event.join_code} · share</Text>
                  </Pressable>
                )}
              </View>
              <View style={[styles.cardActions, styles.cardActionsWrap]}>
                <Pressable
                  style={[styles.actionBtn, styles.btnSetup]}
                  onPress={() => router.push(`/race/${item.race.id}/participants`)}
                >
                  <Text style={styles.actionBtnText}>Setup</Text>
                </Pressable>
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
                {inProgress && (
                  <Pressable
                    style={[styles.actionBtn, styles.btnStop]}
                    onPress={() => setConfirmingStopId(item.race.id)}
                  >
                    <Text style={styles.actionBtnText}>Stop</Text>
                  </Pressable>
                )}
                {finished && (
                  <Pressable
                    style={[styles.actionBtn, styles.btnReopen]}
                    onPress={() => handleSetStopped(item.event, false)}
                  >
                    <Text style={styles.actionBtnText}>Reopen</Text>
                  </Pressable>
                )}
                <Pressable
                  style={[styles.actionBtn, styles.btnDelete]}
                  onPress={() => setConfirmingDeleteId(item.race.id)}
                  hitSlop={8}
                >
                  <Text style={styles.actionBtnText}>✕</Text>
                </Pressable>
              </View>
            </View>
          );
        }}
      />

      {/* New race / join buttons — hidden while a form is open at the top */}
      {!formVisible && (
        <View style={styles.footer}>
          <View style={styles.footerButtons}>
            <Pressable style={[styles.newBtn, styles.newBtnHalf]} onPress={() => openForm('create')}>
              <Text style={styles.newBtnText}>+ New Race</Text>
            </Pressable>
            <Pressable
              style={[styles.newBtn, styles.newBtnHalf, styles.joinBtn, !isSupabaseConfigured && styles.btnCreateDisabled]}
              onPress={() => openForm('join')}
              disabled={!isSupabaseConfigured}
            >
              <Text style={styles.newBtnText}>Join Race</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
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
  header: {
    gap: 12,
    marginBottom: 8,
  },
  heading: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '700',
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
    gap: 12,
  },
  cardInfo: {
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
  statusLive: {
    color: '#4caf50',
  },
  statusFinished: {
    color: '#777',
  },
  staleNote: {
    color: '#f59e0b',
    fontSize: 12,
  },
  joinCode: {
    color: '#4caf50',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 2,
  },
  cardActions: {
    flexDirection: 'row',
    gap: 8,
  },
  cardActionsWrap: {
    flexWrap: 'wrap',
  },
  actionBtn: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  btnSetup: {
    backgroundColor: '#4e342e',
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
  btnStop: {
    backgroundColor: '#8a4b08',
  },
  btnReopen: {
    backgroundColor: '#2e3b2f',
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
  cardConfirmStop: {
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 14,
    borderWidth: 1,
    borderColor: '#6b4a12',
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
  btnConfirmStop: {
    flex: 1,
    backgroundColor: '#8a4b08',
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
  footerButtons: {
    flexDirection: 'row',
    gap: 10,
  },
  newBtn: {
    backgroundColor: '#1e1e1e',
    borderRadius: 14,
    padding: 18,
    alignItems: 'center',
  },
  newBtnHalf: {
    flex: 1,
  },
  joinBtn: {
    backgroundColor: '#1a237e',
  },
  newBtnText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
  },
  joinInput: {
    textAlign: 'center',
    letterSpacing: 4,
    fontSize: 22,
    fontWeight: '700',
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
