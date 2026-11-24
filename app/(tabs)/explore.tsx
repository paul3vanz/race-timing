import NetInfo from '@react-native-community/netinfo';
import { useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { OperatorNameForm } from '@/components/operator-name-prompt';
import { exportRawData } from '@/lib/export-file';
import { useRaceStore } from '@/lib/store';
import { countPending, pushPendingChanges } from '@/lib/sync';
import { isSupabaseConfigured } from '@/lib/supabase';
import { useSyncStore } from '@/lib/sync-store';

const STATUS_COPY: Record<string, { label: string; color: string }> = {
  unconfigured: { label: 'Not configured', color: '#666' },
  offline: { label: 'Offline', color: '#f59e0b' },
  syncing: { label: 'Syncing…', color: '#4caf50' },
  idle: { label: 'Up to date', color: '#4caf50' },
  error: { label: 'Sync error', color: '#ef4444' },
};

function timeAgo(ms: number | null): string {
  if (ms === null) return 'Never';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'Just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

export default function SettingsScreen() {
  const db = useSQLiteContext();
  const status = useSyncStore((s) => s.status);
  const pendingCount = useSyncStore((s) => s.pendingCount);
  const lastSyncedAt = useSyncStore((s) => s.lastSyncedAt);
  const lastError = useSyncStore((s) => s.lastError);
  const setOnline = useSyncStore((s) => s.setOnline);
  const setPendingCount = useSyncStore((s) => s.setPendingCount);
  const syncStarted = useSyncStore((s) => s.syncStarted);
  const syncFinished = useSyncStore((s) => s.syncFinished);

  const [syncingNow, setSyncingNow] = useState(false);
  const operatorName = useRaceStore((s) => s.operatorName);
  const [editingName, setEditingName] = useState(false);

  // Races on this phone, for the raw data export. Read with a plain query so
  // the export is reachable even if a race screen is failing to open.
  const [races, setRaces] = useState<{ id: string; name: string; date: string | null }[]>([]);
  useFocusEffect(
    useCallback(() => {
      db.getAllAsync<{ id: string; name: string; date: string | null }>(
        'SELECT r.id, r.name, e.date FROM races r LEFT JOIN events e ON e.id = r.event_id ORDER BY e.date DESC, r.name',
      )
        .then(setRaces)
        .catch(() => setRaces([]));
    }, [db]),
  );

  const handleSyncNow = async () => {
    if (!isSupabaseConfigured || syncingNow) return;
    setSyncingNow(true);
    const net = await NetInfo.fetch();
    const online = Boolean(net.isConnected && net.isInternetReachable !== false);
    setOnline(online);
    if (online) {
      syncStarted();
      const result = await pushPendingChanges(db);
      syncFinished(result);
    }
    setPendingCount(await countPending(db));
    setSyncingNow(false);
  };

  const copy = STATUS_COPY[status] ?? STATUS_COPY.idle;

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Settings</Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Your name</Text>
        <Text style={styles.bodyText}>Saved with every tap and bib recorded on this phone.</Text>
        {editingName || !operatorName ? (
          <OperatorNameForm
            key={operatorName ?? 'none'}
            initial={operatorName}
            saveLabel="Save name"
            onSaved={() => setEditingName(false)}
          />
        ) : (
          <View style={styles.statRow}>
            <Text style={styles.nameValue}>{operatorName}</Text>
            <Pressable onPress={() => setEditingName(true)} hitSlop={8}>
              <Text style={styles.linkText}>Change</Text>
            </Pressable>
          </View>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Live Sync</Text>

        <View style={styles.statusRow}>
          <View style={[styles.dot, { backgroundColor: copy.color }]} />
          <Text style={[styles.statusText, { color: copy.color }]}>{copy.label}</Text>
        </View>

        <View style={styles.statRow}>
          <Text style={styles.statLabel}>Last synced</Text>
          <Text style={styles.statValue}>{timeAgo(lastSyncedAt)}</Text>
        </View>
        <View style={styles.statRow}>
          <Text style={styles.statLabel}>Pending rows</Text>
          <Text style={styles.statValue}>{pendingCount}</Text>
        </View>

        {lastError && <Text style={styles.errorText}>{lastError}</Text>}

        <Pressable
          style={[styles.syncBtn, (!isSupabaseConfigured || syncingNow) && styles.syncBtnDisabled]}
          onPress={handleSyncNow}
          disabled={!isSupabaseConfigured || syncingNow}
        >
          <Text style={styles.syncBtnText}>{syncingNow ? 'Syncing…' : 'Sync Now'}</Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Export raw data</Text>
        <Text style={styles.bodyText}>
          Every tap and bib recorded on this phone, in the order entered, with finish times. Works offline and does not
          need the results to be matched up first.
        </Text>
        {races.length === 0 ? (
          <Text style={styles.bodyText}>No races on this phone yet.</Text>
        ) : (
          races.map((r) => (
            <Pressable key={r.id} style={styles.exportRow} onPress={() => exportRawData(db, r.id)}>
              <View style={styles.exportInfo}>
                <Text style={styles.exportName}>{r.name}</Text>
                {r.date ? <Text style={styles.statLabel}>{r.date}</Text> : null}
              </View>
              <Text style={styles.linkText}>Export CSV</Text>
            </Pressable>
          ))
        )}
      </View>

      {!isSupabaseConfigured && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Backend not configured</Text>
          <Text style={styles.bodyText}>
            Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY in .env (see
            .env.example) and restart the dev server to enable live sync and the spectator
            results URL. The app works fully offline without it.
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

const mono = Platform.select({ ios: 'ui-monospace', default: 'monospace' });

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0d0d0d',
  },
  content: {
    padding: 16,
    gap: 16,
  },
  heading: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 4,
  },
  card: {
    backgroundColor: '#1a1a1a',
    borderRadius: 14,
    padding: 18,
    gap: 12,
  },
  cardTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  statusText: {
    fontSize: 15,
    fontWeight: '600',
  },
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  statLabel: {
    color: '#888',
    fontSize: 14,
  },
  statValue: {
    color: '#ccc',
    fontFamily: mono,
    fontSize: 14,
  },
  errorText: {
    color: '#ef4444',
    fontSize: 13,
    lineHeight: 18,
  },
  syncBtn: {
    backgroundColor: '#1b5e20',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  syncBtnDisabled: {
    opacity: 0.4,
  },
  syncBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  nameValue: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  linkText: {
    color: '#4caf50',
    fontSize: 14,
    fontWeight: '600',
  },
  exportRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#262626',
  },
  exportInfo: {
    flex: 1,
    gap: 2,
  },
  exportName: {
    color: '#ddd',
    fontSize: 15,
  },
  bodyText: {
    color: '#888',
    fontSize: 13,
    lineHeight: 19,
  },
});
