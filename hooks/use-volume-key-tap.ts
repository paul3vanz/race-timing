import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { isVolumeKeysAvailable, listenForVolumeKeys, reclaimVolumeKeys } from '@/modules/volume-keys';

// While `enabled`, the hardware volume buttons call `onTap` (with the native
// press time) instead of changing the volume. Android development/production
// builds only; elsewhere this does nothing.
export function useVolumeKeyTap(enabled: boolean, onTap: (at: number) => void): boolean {
  const onTapRef = useRef(onTap);
  onTapRef.current = onTap;

  useEffect(() => {
    if (!enabled || !isVolumeKeysAvailable) return;
    const stop = listenForVolumeKeys((at) => onTapRef.current(at));
    // Coming back from the background (or a notification shade) can drop
    // keyboard focus; take it back so the buttons keep working.
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') reclaimVolumeKeys();
    });
    return () => {
      appState.remove();
      stop();
    };
  }, [enabled]);

  return isVolumeKeysAvailable;
}
