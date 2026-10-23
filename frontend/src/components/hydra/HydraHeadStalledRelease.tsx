/**
 * The re-apply action for a head whose replay holds on a released body.
 *
 * Shown inside the stall notice, and only for `replay-apply-retry`. A release
 * marks its row so that a later confirmation of the body stops replay instead
 * of being applied. When the server says the row is an action whose requests
 * are still where the release left them, the operator can put it back on the
 * reservation and let replay apply it. Otherwise this says why not.
 */

import { useState } from 'react';
import { toast } from 'react-toastify';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useResync } from '@/lib/hooks/useResync';
import {
  reapplyHydraL2Reservation,
  useHydraStalledRelease,
  type HydraStalledRelease,
} from '@/lib/hooks/useHydraHeads';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { shortenAddress } from '@/lib/utils';

const REPLAY_APPLY_RETRY = 'replay-apply-retry';

function reapplyDescription(release: HydraStalledRelease): string {
  const ids = [...release.purchaseRequestIds, ...release.paymentRequestIds]
    .map((id) => shortenAddress(id, 8))
    .join(', ');
  const releasedBy = release.releasedBy === 'operator' ? 'an admin' : 'automatic recovery';
  return `The body ${shortenAddress(release.intendedTxHash, 12)} was released by ${releasedBy} on ${new Date(release.releasedAt).toLocaleString()}, and our node shows it confirmed in the head after all.\n\nRe-applying puts ${ids} back on this reservation and its in-flight action. The next sync pass then applies the body like any confirmed transaction, and the head starts syncing again.`;
}

export function HydraHeadStalledRelease({
  headId,
  stalledReason,
}: {
  headId: string;
  stalledReason: string | null | undefined;
}) {
  const { apiClient } = useAppContext();
  const resync = useResync();
  const isHeld = stalledReason === REPLAY_APPLY_RETRY;
  const { data: release, refetch } = useHydraStalledRelease(headId, isHeld);
  // The row the operator is confirming, held apart from the polled read so a
  // refetch under the open dialog cannot change what the call sends.
  const [pending, setPending] = useState<HydraStalledRelease | null>(null);
  const [isReapplying, setIsReapplying] = useState(false);

  if (!isHeld || !release) return null;

  if (!release.reapplicable) {
    return (
      <p className="mt-2 text-xs">
        Replay holds on a released reservation that cannot be re-applied here:{' '}
        {release.blockedReason}
      </p>
    );
  }

  const handleReapply = async () => {
    if (!pending) return;
    setIsReapplying(true);
    try {
      await reapplyHydraL2Reservation(apiClient, {
        headId,
        transactionId: pending.transactionId,
        expectedUpdatedAt: pending.updatedAt,
      });
      toast.success('Re-applied the reservation. The next sync pass applies its body.');
      setPending(null);
    } catch (error) {
      // The API layer toasts the cause; catching keeps it from escaping the handler.
      console.error('Hydra L2 reservation re-apply failed', error);
    } finally {
      setIsReapplying(false);
    }
    // Outside the try, so a failed refresh is never reported as a failed re-apply.
    await Promise.allSettled([resync('hydra'), refetch()]);
  };

  return (
    <>
      <div className="mt-2 flex items-start justify-between gap-3">
        <p className="text-xs">
          It is a reservation that was released, but whose body confirmed anyway. Its requests are
          still where the release left them, so it can be re-applied.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => setPending(release)}
        >
          Re-apply
        </Button>
      </div>
      {/* Keyed by row version, so a dialog never carries over to a later one. */}
      <ConfirmDialog
        key={pending ? `${pending.transactionId}:${pending.updatedAt}` : 'none'}
        elevatedChildStack
        open={pending !== null && release.updatedAt === pending.updatedAt}
        onClose={() => {
          if (!isReapplying) setPending(null);
        }}
        title="Re-apply this released L2 reservation?"
        description={pending ? reapplyDescription(pending) : ''}
        confirmLabel="Re-apply reservation"
        isLoading={isReapplying}
        onConfirm={() => void handleReapply()}
      />
    </>
  );
}
