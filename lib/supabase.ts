import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';

// EXPO_PUBLIC_* vars are inlined at build time by Expo — see .env.example
// for what to set locally. There's no Supabase Auth login flow (yet), so
// session persistence/refresh is disabled outright.
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
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  },
);
