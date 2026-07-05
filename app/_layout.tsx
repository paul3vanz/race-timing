import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { SQLiteProvider } from 'expo-sqlite';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import 'react-native-reanimated';

import { DbErrorBoundary } from '@/components/db-error-boundary';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { migrateDbIfNeeded } from '@/lib/db';
import { useRaceStore } from '@/lib/store';

export const unstable_settings = {
  anchor: '(tabs)',
};

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const initDeviceId = useRaceStore((s) => s.initDeviceId);

  useEffect(() => {
    initDeviceId();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <DbErrorBoundary>
      <SafeAreaProvider>
        <SQLiteProvider databaseName="race-timing.db" onInit={migrateDbIfNeeded}>
          <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
            <Stack>
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
              <Stack.Screen name="race/[raceId]/timer" options={{ headerShown: false }} />
              <Stack.Screen name="race/[raceId]/bib" options={{ headerShown: false }} />
            <Stack.Screen name="race/[raceId]/review" options={{ headerShown: true }} />
            </Stack>
            <StatusBar style="auto" />
          </ThemeProvider>
        </SQLiteProvider>
      </SafeAreaProvider>
    </DbErrorBoundary>
  );
}
