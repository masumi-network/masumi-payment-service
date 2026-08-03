/**
 * Confirming an Init, with the one precondition it actually has.
 *
 * A head is opened by a transaction the node posts from its *own* Cardano key,
 * which is generated empty. Without a UTxO there the node refuses with
 * `NoSeedInput`, and that refusal is invisible from here: nothing is posted,
 * the service waits out its timeout, and the operator gets a gateway timeout
 * that says nothing about money.
 *
 * So the balance is read before the button is offered, and if it is short the
 * dialog says by how much and can send it. Checking after the fact would be
 * technically equivalent and practically useless — by then the operator has
 * waited minutes for a message that does not name the cause.
 */

import { useEffect, useState } from 'react';
import { Loader2, Wallet } from 'lucide-react';
import { toast } from 'react-toastify';
import { Button } from '@/components/ui/button';
import { HydraNotice } from '@/components/hydra/HydraNotice';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useAppContext } from '@/lib/contexts/AppContext';
import {
  fundHydraNode,
  readHydraNodeFunding,
  type HydraNodeFunding,
} from '@/lib/hooks/useHydraHeads';

const ADA = 1_000_000;

function ada(lovelace: string): string {
  return `${(Number(lovelace) / ADA).toFixed(2)} ADA`;
}

export function HydraInitDialog({
  open,
  onOpenChange,
  localParticipantId,
  onConfirm,
  isRunning,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null when the head has no local participant, in which case Init cannot work anyway. */
  localParticipantId: string | null;
  onConfirm: () => void;
  isRunning: boolean;
}) {
  const { apiClient } = useAppContext();
  const [funding, setFunding] = useState<HydraNodeFunding | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [isFunding, setIsFunding] = useState(false);

  useEffect(() => {
    if (!open || localParticipantId === null) {
      setFunding(null);
      return;
    }
    let cancelled = false;
    setIsChecking(true);
    readHydraNodeFunding(apiClient, { id: localParticipantId })
      .then((state) => {
        if (!cancelled) setFunding(state);
      })
      .catch(() => {
        // A failed lookup must not block the action: unknown is not empty, and
        // refusing here would turn a chain hiccup into an outage.
        if (!cancelled) setFunding(null);
      })
      .finally(() => {
        if (!cancelled) setIsChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, localParticipantId, apiClient]);

  async function handleFund() {
    if (localParticipantId === null) return;
    setIsFunding(true);
    try {
      const result = await fundHydraNode(apiClient, { id: localParticipantId });
      toast.success(
        result.transferredLovelace === null
          ? 'The node is already funded'
          : `Sending ${ada(result.transferredLovelace)} to the node. Retry once it confirms.`,
      );
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to fund the node');
    } finally {
      setIsFunding(false);
    }
  }

  const isUnderfunded = funding?.isUnderfunded === true;
  // Checked before funding is offered: sending ADA to a node that cannot act
  // yet is a fix for the wrong problem.
  // Optional-chained through `node` as well: a service that predates this field
  // must degrade to "no opinion", not crash the page. Reading a property off an
  // absent object is how a missing API field becomes a blank screen.
  const nodeBlocker = funding?.node?.isReady === false ? (funding.node.reason ?? null) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Open this head?</DialogTitle>
          <DialogDescription>
            Your node posts a transaction that puts both participants on chain. Once it lands the
            head is open, and the only way back is to close it.
          </DialogDescription>
        </DialogHeader>

        {isChecking ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking the node…
          </p>
        ) : nodeBlocker !== null ? (
          <HydraNotice tone="warn">
            <p>
              {nodeBlocker} Opening now fails as &ldquo;node unreachable&rdquo;, which says nothing
              about the cause. Try again in a minute.
            </p>
          </HydraNotice>
        ) : isUnderfunded && funding ? (
          <HydraNotice tone="warn">
            <p>
              This node&apos;s key holds {ada(funding.balanceLovelace)}. Opening a head spends a
              UTxO from it, so posting fails until it has funds.
            </p>
            <p className="break-all font-mono opacity-80">{funding.address}</p>
          </HydraNotice>
        ) : funding?.checked === true ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Wallet className="h-4 w-4" />
            The node holds {ada(funding.balanceLovelace)}, enough to post.
          </p>
        ) : null}

        {/* Only once the transaction is being posted. Said up front it is
            noise about a wait that has not started; said now it answers the
            question the spinner just raised, and stops a second click. */}
        {isRunning && (
          <p className="text-xs text-muted-foreground">
            Waiting for the transaction to land, usually a block or two. You can close this window.
            The node carries on and the head updates itself.
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {nodeBlocker !== null ? null : isUnderfunded && funding ? (
            <Button type="button" onClick={() => void handleFund()} disabled={isFunding}>
              {isFunding && <Loader2 className="h-4 w-4 animate-spin" />}
              Send {ada(funding.shortfallLovelace)}
            </Button>
          ) : (
            <Button type="button" onClick={onConfirm} disabled={isRunning || isChecking}>
              {isRunning && <Loader2 className="h-4 w-4 animate-spin" />}
              Open the head
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
