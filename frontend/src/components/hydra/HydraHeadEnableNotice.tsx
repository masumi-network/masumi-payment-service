/**
 * The way back from a disabled head.
 *
 * Every lifecycle action on a disabled head is greyed out with "re-enable it
 * before running lifecycle actions", and nothing in the admin UI could do that
 * — `PATCH /hydra/head` had no caller at all. An operator whose head disabled
 * itself (a failed InitTx verification does it without anyone touching a
 * toggle) was told what to do and given no way to do it.
 *
 * Re-enabling is not a flag flip, so it is not a switch. The endpoint drops the
 * head's InitTx binding and proves the head against L1 again; the interesting
 * outcome is the refusal, which names why the head cannot come back. That
 * message is shown here in full rather than in a toast that scrolls away,
 * because it is usually the same reason the head was disabled in the first
 * place.
 */

import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { toast } from 'react-toastify';
import { HydraNotice } from '@/components/hydra/HydraNotice';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useResync } from '@/lib/hooks/useResync';
import { setHydraHeadEnabled } from '@/lib/hooks/hydra/heads';
import type { HydraHead } from '@/lib/hooks/hydra/types';

export function HydraHeadEnableNotice({ head }: { head: HydraHead }) {
  const { apiClient } = useAppContext();
  const resync = useResync();
  const [isEnabling, setIsEnabling] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  if (head.isEnabled !== false) return null;

  async function handleEnable() {
    setIsEnabling(true);
    setRefusal(null);
    try {
      await setHydraHeadEnabled(apiClient, { id: head.id, isEnabled: true });
      await resync('hydra');
      toast.success('Head re-enabled. Its opening transaction was verified on chain again.');
    } catch (error) {
      // Kept on screen, not toasted: this is the diagnosis, and it is the
      // reason the next attempt will fail the same way.
      setRefusal(error instanceof Error ? error.message : 'Re-enabling the head failed');
    } finally {
      setIsEnabling(false);
    }
  }

  return (
    <div className="space-y-2">
      <HydraNotice
        tone="warn"
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={isEnabling}
            onClick={handleEnable}
          >
            {isEnabling ? <Spinner className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
            {isEnabling ? 'Verifying' : 'Re-enable'}
          </Button>
        }
      >
        This head is disabled, so no lifecycle action will run on it. Re-enabling checks its opening
        transaction against the chain first, and leaves it disabled if that check does not pass.
      </HydraNotice>

      {refusal && (
        <HydraNotice tone="error">
          <span className="break-words">Still disabled: {refusal}</span>
        </HydraNotice>
      )}
    </div>
  );
}
