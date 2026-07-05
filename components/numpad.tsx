import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

interface NumpadProps {
  onDigit: (d: string) => void;
  onDelete: () => void;
  onConfirm: () => void;
  canConfirm: boolean;
  disabled?: boolean;
}

const DIGIT_ROWS = [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9']];

// Mobile browsers (Android Chrome in particular) don't reliably report their
// own address/nav bar height through env(safe-area-inset-bottom) — it's meant
// for hardware cutouts, not browser chrome. Enforce a minimum clearance on
// web so the bottom row (delete / 0 / confirm) never sits under it.
const MIN_WEB_BOTTOM_CLEARANCE = 28;

export function Numpad({ onDigit, onDelete, onConfirm, canConfirm, disabled = false }: NumpadProps) {
  const insets = useSafeAreaInsets();
  const bottomInset =
    Platform.OS === 'web' ? Math.max(insets.bottom, MIN_WEB_BOTTOM_CLEARANCE) : insets.bottom;

  const pressDigit = (d: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onDigit(d);
  };

  const pressDelete = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onDelete();
  };

  return (
    <View style={[styles.grid, { paddingBottom: bottomInset + 8 }]}>
      {DIGIT_ROWS.map((row, ri) => (
        <View key={ri} style={styles.row}>
          {row.map((key) => (
            <Pressable
              key={key}
              style={({ pressed }) => [styles.key, pressed && styles.keyPressed, disabled && styles.keyDisabled]}
              onPress={() => pressDigit(key)}
              disabled={disabled}
              android_disableSound
            >
              <Text style={styles.keyText}>{key}</Text>
            </Pressable>
          ))}
        </View>
      ))}

      {/* Bottom row: delete · 0 · confirm */}
      <View style={styles.row}>
        <Pressable
          style={({ pressed }) => [styles.key, styles.keyDelete, pressed && styles.keyPressed, disabled && styles.keyDisabled]}
          onPress={pressDelete}
          disabled={disabled}
          android_disableSound
        >
          <Text style={styles.keyTextDelete}>⌫</Text>
        </Pressable>

        <Pressable
          style={({ pressed }) => [styles.key, pressed && styles.keyPressed, disabled && styles.keyDisabled]}
          onPress={() => pressDigit('0')}
          disabled={disabled}
          android_disableSound
        >
          <Text style={styles.keyText}>0</Text>
        </Pressable>

        <Pressable
          style={({ pressed }) => [
            styles.key,
            styles.keyConfirm,
            pressed && styles.keyConfirmPressed,
            (!canConfirm || disabled) && styles.keyDisabled,
          ]}
          onPress={onConfirm}
          disabled={!canConfirm || disabled}
          android_disableSound
        >
          <Text style={styles.keyTextConfirm}>✓</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    gap: 10,
    paddingHorizontal: 16,
  },
  row: {
    flexDirection: 'row',
    gap: 10,
  },
  key: {
    flex: 1,
    aspectRatio: 1.6,
    backgroundColor: '#1e1e1e',
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyConfirm: {
    backgroundColor: '#1b3a1e',
  },
  keyConfirmPressed: {
    backgroundColor: '#2e7d32',
  },
  keyDelete: {
    backgroundColor: '#2a1a1a',
  },
  keyPressed: {
    backgroundColor: '#333',
  },
  keyDisabled: {
    opacity: 0.3,
  },
  keyText: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '500',
  },
  keyTextConfirm: {
    color: '#4caf50',
    fontSize: 26,
    fontWeight: '700',
  },
  keyTextDelete: {
    color: '#e57373',
    fontSize: 24,
  },
});
