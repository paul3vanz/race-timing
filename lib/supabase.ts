import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';

// EXPO_PUBLIC_* vars are inlined at build time by Expo — see .env.example
// for what to set locally.
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

// Gate every sync call site on this instead of letting createClient throw —
// the app must still work fully offline when Supabase hasn't been configured.
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'placeholder-anon-key',
  {
    auth: {
      // No login flow — every device is an anonymous Supabase Auth user
      // instead (see ensureAnonymousSession). Session persistence is
      // deliberately left off: there's no AsyncStorage/SecureStore adapter
      // wired up yet, so a fresh anonymous sign-in each app launch is the
      // simpler trade-off over persisting (and refreshing) a session across
      // restarts.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  },
);

// RLS now grants `anon` read-only access (see
// supabase/migrations/20260711130000_anon_read_only_split.sql) — every
// remote *write* path must call this first to get bumped to `authenticated`.
// Memoized so the sync timer, a manual "start race" tap, etc. all share one
// in-flight sign-in instead of racing to create multiple anonymous users.
let anonymousSessionPromise: Promise<void> | null = null;

export function ensureAnonymousSession(): Promise<void> {
  if (!isSupabaseConfigured) return Promise.resolve();

  anonymousSessionPromise ??= (async () => {
    const { data } = await supabase.auth.getSession();
    if (data.session) return;

    const { error } = await supabase.auth.signInAnonymously();
    if (error) {
      // Don't cache a failure — let the next write attempt retry.
      anonymousSessionPromise = null;
      throw new Error(`ensureAnonymousSession: ${error.message}`);
    }
  })();

  return anonymousSessionPromise;
}
