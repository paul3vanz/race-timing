import { useSyncEngine } from '@/hooks/use-sync-engine';

// Renders nothing — exists purely so useSyncEngine (which needs SQLiteContext)
// can be mounted inside <SQLiteProvider> from the root layout.
export function SyncEngine() {
  useSyncEngine();
  return null;
}
