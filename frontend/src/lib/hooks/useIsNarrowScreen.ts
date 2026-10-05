import { useSyncExternalStore } from 'react';

// Tailwind's lg breakpoint: below it the full sidebar leaves the page too little room.
const DESKTOP_QUERY = '(min-width: 1024px)';

function subscribe(onChange: () => void) {
  const mediaQuery = window.matchMedia(DESKTOP_QUERY);
  mediaQuery.addEventListener('change', onChange);
  return () => mediaQuery.removeEventListener('change', onChange);
}

function getSnapshot() {
  return !window.matchMedia(DESKTOP_QUERY).matches;
}

function getServerSnapshot() {
  return false;
}

export function useIsNarrowScreen(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
