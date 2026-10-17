/**
 * Expired L2 reservations that no proof can release, and the admin release.
 *
 * Renders nothing until the server marks a reservation releasable. A release
 * cannot be undone and the service cannot prove the body is dead, so the
 * confirmation names the one case it cannot rule out and asks the operator to
 * have checked it. The row's updatedAt as the operator saw it is what the
 * server checks; a row that changed in the meantime is refused.
 */

import { useState } from 'react';
import { toast } from 'react-toastify';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useResync } from '@/lib/hooks/useResync';
import {
  releaseHydraL2Reservation,
  useHydraL2Reservations,
  type HydraL2Reservation,
} from '@/lib/hooks/useHydraHeads';
import { HydraNotice } from '@/components/hydra/HydraNotice';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { shortenAddress } from '@/lib/utils';

interface HydraHeadL2ReservationsNoticeProps {
  headId: string;
  /** Only an Open head can release a reservation. */
  isOpen: boolean;
}

function requestSummary(reservation: HydraL2Reservation): string {
  const ids = [...reservation.purchaseRequestIds, ...reservation.paymentRequestIds];
  return ids.length === 0 ? 'no request' : ids.map((id) => shortenAddress(id, 8)).join(', ');
}

function releaseDescription(reservation: HydraL2Reservation): string {
  const restore =
    reservation.kind === 'initial-lock'
      ? 'Each purchase goes back to locking, so it can lock again.'
      : 'Each request goes back to retrying its action against the escrow it had before.';
  const nudge = reservation.releaseNudgeTxHash
    ? `Its release nudge ${shortenAddress(reservation.releaseNudgeTxHash, 12)} never showed up in a verified snapshot.`
    : 'It has no release nudge. Automatic recovery did not send one in the time it gets, or cannot send one for this row.';
  const inputs =
    reservation.inputsReportedUnspent === null
      ? ''
      : `\n\nOur node reports ${reservation.inputsReportedUnspent} of ${reservation.inputRefs.length} body input(s) unspent. That count comes from our node and is not proof.`;
  return `The wallet ${reservation.walletAddress ? shortenAddress(reservation.walletAddress, 10) : ''} is freed. ${restore}\n\n${nudge}${inputs}\n\nThe service cannot rule out one case: the body ${reservation.intendedTxHash ? shortenAddress(reservation.intendedTxHash, 12) : ''} applied in a snapshot our node withheld. Then the purchase locks twice. Before you release, check on the other party's node or on L1 that the body did not apply.\n\nIf the body confirms later, the head stops replaying its history until an operator reviews it.`;
}

export function HydraHeadL2ReservationsNotice({
  headId,
  isOpen,
}: HydraHeadL2ReservationsNoticeProps) {
  const { apiClient } = useAppContext();
  const resync = useResync();
  const { data: reservations, refetch } = useHydraL2Reservations(headId, isOpen);
  // The row the operator is confirming, held apart from the polled list so a
  // refetch under the open dialog cannot change what the release sends.
  const [pending, setPending] = useState<HydraL2Reservation | null>(null);
  const [isReleasing, setIsReleasing] = useState(false);

  const releasable = (reservations ?? []).filter((reservation) => reservation.releasable);
  // A choice made for one version of a row never carries to a later one. Set
  // during render, so the dialog never paints for a row that changed.
  const current = pending
    ? releasable.find((reservation) => reservation.transactionId === pending.transactionId)
    : undefined;
  const isPendingStale = pending !== null && (!isOpen || current?.updatedAt !== pending.updatedAt);
  if (isPendingStale && !isReleasing) setPending(null);

  if (!isOpen || releasable.length === 0) return null;

  const handleRelease = async () => {
    if (!pending) return;
    setIsReleasing(true);
    try {
      const result = await releaseHydraL2Reservation(apiClient, {
        headId,
        transactionId: pending.transactionId,
        expectedUpdatedAt: pending.updatedAt,
      });
      toast.success(
        `Released the reservation. ${result.purchaseRequestIds.length + result.paymentRequestIds.length} request(s) went back to where it found them.`,
      );
      setPending(null);
    } catch (error) {
      // The API layer toasts the cause; catching keeps it from escaping the handler.
      console.error('Hydra L2 reservation release failed', error);
    } finally {
      setIsReleasing(false);
    }
    // Outside the try, so a failed refresh is never reported as a failed release.
    await Promise.allSettled([resync('hydra'), refetch()]);
  };

  return (
    <>
      <HydraNotice tone="error">
        <p className="font-medium">
          {releasable.length} expired L2 reservation(s) hold a wallet that automatic recovery cannot
          free.
        </p>
        <p>
          The service frees an expired reservation only once its release nudge shows up in a
          verified snapshot. Recovery cannot prove these dead, and it never nudges some of them.
          Review each one before you release it.
        </p>
        <div className="mt-2 space-y-2">
          {releasable.map((reservation) => (
            <div key={reservation.transactionId} className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-0.5 text-xs">
                <p className="font-mono break-all">
                  {reservation.intendedTxHash ?? reservation.transactionId}
                </p>
                <p>
                  {reservation.kind === 'initial-lock' ? 'Initial lock' : 'Action'} for{' '}
                  {requestSummary(reservation)}
                  {reservation.expiresAt
                    ? `, expired ${new Date(reservation.expiresAt).toLocaleString()}`
                    : ''}
                  {reservation.rejectedByHeadReason
                    ? `. Head said: ${reservation.rejectedByHeadReason}`
                    : ''}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => setPending(reservation)}
              >
                Release
              </Button>
            </div>
          ))}
        </div>
      </HydraNotice>

      {/* Keyed by row version: the acknowledgement for one version of a row
          must never carry over to a later one. */}
      <ConfirmDialog
        key={pending ? `${pending.transactionId}:${pending.updatedAt}` : 'none'}
        elevatedChildStack
        open={pending !== null && current?.updatedAt === pending.updatedAt}
        onClose={() => {
          if (!isReleasing) setPending(null);
        }}
        title="Release this L2 reservation without a proof?"
        description={pending ? releaseDescription(pending) : ''}
        acknowledgementLabel="I checked that the body did not apply on the other party's node or on L1."
        confirmLabel="Release reservation"
        isLoading={isReleasing}
        onConfirm={() => void handleRelease()}
      />
    </>
  );
}
