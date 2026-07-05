import { Component, type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches the OPFS "createSyncAccessHandle" error that expo-sqlite throws on web
 * when a stale file handle from a previous hot-reload is still open.
 * Shows a one-click reload prompt rather than a blank crash screen.
 * On native this boundary is transparent — errors propagate normally.
 */
export class DbErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (Platform.OS === 'web') {
      return (
        <View style={styles.container}>
          <Text style={styles.title}>Reload required</Text>
          <Text style={styles.body}>
            A stale SQLite file handle from a previous hot-reload is blocking startup.
            This only happens in the browser dev preview — a full page reload fixes it.
          </Text>
          <Pressable style={styles.btn} onPress={() => window.location.reload()}>
            <Text style={styles.btnText}>Reload page</Text>
          </Pressable>
        </View>
      );
    }

    // On native, re-surface the error so it reaches the default error overlay.
    throw error;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0d0d0d',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 20,
  },
  title: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
  },
  body: {
    color: '#666',
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
  },
  btn: {
    backgroundColor: '#1b5e20',
    paddingVertical: 14,
    paddingHorizontal: 36,
    borderRadius: 12,
    marginTop: 8,
  },
  btnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
