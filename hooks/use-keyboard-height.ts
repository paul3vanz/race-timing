import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

// Height of the on-screen keyboard (0 when hidden). Android here draws the
// keyboard over the app instead of resizing it, so a scrolling form adds this
// much padding at the bottom to let its last fields scroll up above the keys.
export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      (e) => setHeight(e.endCoordinates.height),
    );
    const hide = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setHeight(0),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  return height;
}
