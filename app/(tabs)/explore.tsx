import NetInfo from '@react-native-community/netinfo';
import { useSQLiteContext } from 'expo-sqlite';
import { useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

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
  bodyText: {
    color: '#888',
    fontSize: 13,
    lineHeight: 19,
  },
});
