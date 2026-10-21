/**
 * A snapshot round that stopped moving, and the admin reset for it.
 *
 * Renders nothing until the server calls the round stuck. The reset discards
 * the round and the unconfirmed transactions in it, so the confirmation is
 * built from the round as it was when the operator opened it, and that exact
 * round's signature is what the server checks. A round that moved in the
 * meantime is refused, not reset.
 *
 * The other party's node is not reachable from here, so its operator reads the
 * confirmed snapshot number off it and the admin types it in. The server
 * refuses a reset when that number is ahead of ours, because the reset would
 * discard a snapshot only the other party holds, or more than one behind ours,
 * which within the protocol no party can be.
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { shortenAddress } from '@/lib/utils';

interface HydraHeadSnapshotRoundNoticeProps {
  headId: string;
  /** Only an Open head has a round to read. */
  isOpen: boolean;
}

function roundLabel(round: HydraSnapshotRound): string {
  return round.snapshotNumber === null ? round.tag : `${round.tag} ${round.snapshotNumber}`;
}

// One stuck round as the server recorded it. The signature repeats when the same
// round is stuck again after a reset; the recorded `since` does not.
function roundInstance(round: HydraSnapshotRound): string {
  return `${round.signature}|${round.since ?? ''}`;
}

function resetDescription(round: HydraSnapshotRound, peerNumber: number): string {
  // The round names only the transactions it would confirm. The side-load drops
  // every unconfirmed transaction the node holds, so the list is a floor.
  const named =
    round.txIds.length === 0
      ? 'The round names no transactions.'
      : `The round names ${round.txIds.length} transaction(s):\n${round.txIds.map((txId) => shortenAddress(txId, 12)).join('\n')}`;
  return `Our node goes back to its last confirmed snapshot, which every party already signed. Nothing new enters the head.\n\nOur node drops every transaction it has not confirmed. ${named}\nThe node can hold more unconfirmed transactions than this list shows.\n\nDo not rebuild a dropped payment by hand. The other party's node can still hold the original, and then both can confirm.\n\nThis resets our node only. If the other party's node is stuck on the same round, its operator must reset it too. If it is one snapshot behind ours, its operator side-loads our node's confirmed snapshot instead.\n\nYou entered ${peerNumber} as the snapshot the other party's node has confirmed. If that is not what its operator reported, cancel and check again.`;
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
  const [pending, setPending] = useState<{ round: HydraSnapshotRound; peerNumber: number } | null>(
    null,
  );
  // The number typed for the other party's node, kept with the round it was typed for.
  const [peerInput, setPeerInput] = useState<{ instance: string; value: string } | null>(null);
  const [isResetting, setIsResetting] = useState(false);
  const peerSnapshot = peerInput?.value.trim() ?? '';
  // Whole numbers only, and short enough to stay a safe integer.
  const peerNumber = /^\d{1,15}$/.test(peerSnapshot) ? Number(peerSnapshot) : null;

  // A choice made for one round never carries to a later one, even one that
  // comes back with the same signature. Set during render, not in an effect,
  // so the dialog never paints for a round that is gone. The typed number goes
  // the same way: a stale lower number would pass the server's check.
  const isPendingStale =
    pending !== null &&
    (!isOpen || !round?.stuck || roundInstance(round) !== roundInstance(pending.round));
  if (isPendingStale && !isResetting) setPending(null);
  const isPeerInputStale =
    peerInput !== null && (!isOpen || !round?.stuck || roundInstance(round) !== peerInput.instance);
  if (isPeerInputStale && !isResetting) setPeerInput(null);

  if (!isOpen || !round?.stuck) return null;

  const handleReset = async () => {
    if (!pending) return;
    setIsResetting(true);
    try {
      const result = await resetHydraSnapshotRound(apiClient, {
        headId,
        expectedSignature: pending.round.signature,
        peerConfirmedSnapshotNumber: pending.peerNumber,
      });
      toast.success(
        `Reset to confirmed snapshot ${result.confirmedSnapshotNumber}. Unconfirmed transactions were dropped, including the round's ${result.droppedTxIds.length}.`,
      );
      setPending(null);
      setPeerInput(null);
    } catch (error) {
      // The API layer toasts the cause; catching keeps it from escaping the handler.
      console.error('Hydra snapshot round reset failed', error);
    } finally {
      // Every attempt, failed ones too, ends the choice. A reset that reached the
      // node can leave the same round in flight while the other party moves on,
      // so a retry needs its number read again.
      setPending(null);
      setPeerInput(null);
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
            disabled={peerNumber === null}
            onClick={() => {
              if (peerNumber !== null) setPending({ round, peerNumber });
            }}
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
        <div className="mt-3 max-w-xs space-y-1">
          <Label htmlFor={`peer-snapshot-${headId}`}>
            Snapshot the other party&apos;s node has confirmed
          </Label>
          <Input
            id={`peer-snapshot-${headId}`}
            inputMode="numeric"
            placeholder="Ask the other party's operator"
            value={peerInput?.value ?? ''}
            onChange={(event) =>
              setPeerInput({ instance: roundInstance(round), value: event.target.value })
            }
          />
          <p className="text-xs">
            Required. The other party&apos;s operator reads it from GET /snapshot on their node (0
            if it shows InitialSnapshot). Resetting is refused if it is ahead of our node (the reset
            would discard a snapshot only the other party holds) or more than one behind it.
          </p>
        </div>
      </HydraNotice>

      <ConfirmDialog
        elevatedChildStack
        open={pending !== null && roundInstance(pending.round) === roundInstance(round)}
        onClose={() => {
          if (!isResetting) setPending(null);
        }}
        title={pending ? `Reset stuck round ${roundLabel(pending.round)}?` : 'Reset stuck round?'}
        description={pending ? resetDescription(pending.round, pending.peerNumber) : ''}
        acknowledgementLabel="I understand that our node drops all of its unconfirmed transactions."
        confirmLabel="Reset round"
        isLoading={isResetting}
        onConfirm={() => void handleReset()}
      />
    </>
  );
}
