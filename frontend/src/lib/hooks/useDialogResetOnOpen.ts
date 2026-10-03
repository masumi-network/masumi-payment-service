import { useEffect } from 'react';

/** Run a reset callback whenever a dialog opens (and when optional deps change). */
export function useDialogResetOnOpen(
  open: boolean,
  reset: () => void,
  deps: readonly unknown[] = [],
) {
  useEffect(() => {
    if (open) {
      reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset runs on open + caller deps only
  }, [open, ...deps]);
}
