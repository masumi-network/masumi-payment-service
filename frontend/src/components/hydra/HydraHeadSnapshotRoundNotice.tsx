/**
 * A snapshot round that stopped moving, and the admin reset for it.
 *
 * Renders nothing until the server calls the round stuck. The reset discards
 * the round and the unconfirmed transactions in it, so the confirmation is
 * built from the round as it was when the operator opened it, and that exact
 * round's signature is what the server checks. A round that moved in the
 * meantime is refused, not reset.
 */

import { useState } from 'react';
import { toast } from 'react-toastify';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useResync } from '@/lib/hooks/useResync';
import {
  resetHydraSnapshotRound,
  useHydraSnapshotRound,
  type HydraSnapshotRound,
} from '@/lib/hooks/useHydraHeads';
import { HydraNotice } from '@/components/hydra/HydraNotice';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { shortenAddress } from '@/lib/utils';

interface HydraHeadSnapshotRoundNoticeProps {
  headId: string;
  /** Only an Open head has a round to read. */
  isOpen: boolean;
}

function roundLabel(round: HydraSnapshotRound): string {
  return round.snapshotNumber === null ? round.tag : `${round.tag} ${round.snapshotNumber}`;
}

function resetDescription(round: HydraSnapshotRound): string {
  // The round names only the transactions it would confirm. The side-load drops
  // every unconfirmed transaction the node holds, so the list is a floor.
  const named =
    round.txIds.length === 0
      ? 'The round names no transactions.'
      : `The round names ${round.txIds.length} transaction(s):\n${round.txIds.map((txId) => shortenAddress(txId, 12)).join('\n')}`;
  return `Our node goes back to its last confirmed snapshot, which every party already signed. Nothing new enters the head.\n\nOur node drops every transaction it has not confirmed. ${named}\nThe node can hold more unconfirmed transactions than this list shows.\n\nDo not rebuild a dropped payment by hand. The other party's node can still hold the original, and then both can confirm.\n\nThis resets our node only. If the other party's node is stuck on the same round, its operator must reset it too.`;
}

export function HydraHeadSnapshotRoundNotice({
  headId,
  isOpen,
}: HydraHeadSnapshotRoundNoticeProps) {
  const { apiClient } = useAppContext();
  const resync = useResync();
  const { data: round, refetch } = useHydraSnapshotRound(headId, isOpen);
  // The round the operator is confirming. Held apart from the polled one so a
  // refetch under the open dialog cannot change what the confirmation sends.
  const [pending, setPending] = useState<HydraSnapshotRound | null>(null);
  const [isResetting, setIsResetting] = useState(false);

  if (!isOpen || !round?.stuck) return null;

  const handleReset = async () => {
    if (!pending) return;
    setIsResetting(true);
    try {
      const result = await resetHydraSnapshotRound(apiClient, {
        headId,
        expectedSignature: pending.signature,
      });
      toast.success(
        `Reset to confirmed snapshot ${result.confirmedSnapshotNumber}. Unconfirmed transactions were dropped, including the round's ${result.droppedTxIds.length}.`,
      );
      setPending(null);
    } catch (error) {
      // The API layer toasts the cause; catching keeps it from escaping the handler.
      console.error('Hydra snapshot round reset failed', error);
    } finally {
      setIsResetting(false);
    }
    // Outside the try, so a failed refresh is never reported as a failed reset.
    await Promise.allSettled([resync('hydra'), refetch()]);
  };

  return (
    <>
      <HydraNotice
        tone="error"
        action={
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => setPending(round)}
          >
            Reset round
          </Button>
        }
      >
        <p className="font-medium">The snapshot round in this head has stopped moving.</p>
        <p>
          Our node reports {roundLabel(round)} with {round.signatoryCount} signature(s), unchanged
          {round.since ? ` since ${new Date(round.since).toLocaleString()}` : ''}. In-head
          transactions will not confirm until the round completes or is reset.
        </p>
        {round.txIds.length > 0 && (
          <div className="mt-1 space-y-0.5 font-mono text-xs break-all">
            {round.txIds.map((txId) => (
              <p key={txId}>{txId}</p>
            ))}
          </div>
        )}
      </HydraNotice>

      <ConfirmDialog
        elevatedChildStack
        // Only for the round on screen: a round that moved is a new decision.
        open={pending !== null && pending.signature === round.signature}
        onClose={() => {
          if (!isResetting) setPending(null);
        }}
        title={pending ? `Reset stuck round ${roundLabel(pending)}?` : 'Reset stuck round?'}
        description={pending ? resetDescription(pending) : ''}
        acknowledgementLabel="I understand that our node drops all of its unconfirmed transactions."
        confirmLabel="Reset round"
        isLoading={isResetting}
        onConfirm={() => void handleReset()}
      />
    </>
  );
}
