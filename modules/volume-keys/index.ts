import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

// JS side of the local `volume-keys` Expo module (see ./android). The native
// half only exists in a development/production build: it is NOT in Expo Go and
// there is no iOS or web implementation, so everything here degrades to a
// no-op instead of throwing, and `isVolumeKeysAvailable` tells the UI whether
// to mention the feature at all.

interface VolumeKeyEvent {
  direction: 'up' | 'down';
  at: number; // Unix ms, stamped natively at the moment of the press
}

interface VolumeKeysNativeModule {
  startListening(): boolean;
  stopListening(): void;
  addListener(eventName: 'onVolumeKey', listener: (event: VolumeKeyEvent) => void): { remove(): void };
}

const native: VolumeKeysNativeModule | null =
  Platform.OS === 'android' ? requireOptionalNativeModule<VolumeKeysNativeModule>('VolumeKeys') : null;

export const isVolumeKeysAvailable = native !== null;

// Starts consuming the volume buttons and calls `onPress` with the native
// press time for each one. Returns the unsubscribe function, which also hands
// the buttons back to the system.
export function listenForVolumeKeys(onPress: (at: number) => void): () => void {
  if (!native) return () => {};
  const subscription = native.addListener('onVolumeKey', (event) => onPress(event.at));
  native.startListening();
  return () => {
    subscription.remove();
    native.stopListening();
  };
}

// Re-asserts keyboard focus on the native listener (it can be lost to another
// window); a no-op when nothing is listening.
export function reclaimVolumeKeys(): void {
  native?.startListening();
}
