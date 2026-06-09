import type { KeyboardEvent } from 'react';

/**
 * Makes a non-button clickable element (e.g. a clickable table row) keyboard-operable.
 * Spread the returned props onto the element alongside its `onClick`:
 *
 *   <tr {...rowActivation(() => openDetails(item))} onClick={() => openDetails(item)}>
 *
 * Enter/Space activate it, matching native button behavior, and Space's default page
 * scroll is suppressed.
 */
export function rowActivation(onActivate: () => void) {
  return {
    role: 'button',
    tabIndex: 0,
    onKeyDown: (event: KeyboardEvent) => {
      // Ignore keys bubbling up from nested controls (action buttons, copy icons).
      if (event.target !== event.currentTarget) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onActivate();
      }
    },
  };
}
