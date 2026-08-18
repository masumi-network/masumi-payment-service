/**
 * How much of this wallet goes into the head.
 *
 * A commit is the one lifecycle action that needs a number from the operator.
 * The service carves a dedicated L1 UTxO of exactly this amount and commits
 * only that, so the rest of the wallet — its other ADA, its stablecoins, an
 * agent's registry NFT — stays on L1 and spendable.
 *
 * It used to be a plain confirmation, which posted no amount at all and was
 * rejected by input validation every time. There was no other control anywhere
 * in the admin that could commit, so the first funding of a head could not be
 * done from here.
 */

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { adaToLovelace } from '@/components/hydra/ada-amount';

export function HydraCommitDialog({
  open,
  onOpenChange,
  network,
  onConfirm,
  isRunning,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Labels the amount the way every other amount in the session is labelled. */
  network: string | undefined;
  onConfirm: (lovelace: string) => void;
  isRunning: boolean;
}) {
  const [amount, setAmount] = useState('');
  const ticker = network?.toLowerCase() === 'mainnet' ? 'ADA' : 'tADA';
  const lovelace = adaToLovelace(amount);

  // Cleared on the way out rather than the way in: an amount left over from the
  // head funded a minute ago is the wrong number for this one, and it would sit
  // pre-filled and ready to send.
  const close = () => {
    setAmount('');
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Fund this head</DialogTitle>
          <DialogDescription>
            This amount is split off into its own L1 transaction and put into the head. Everything
            else in the wallet stays on L1. It comes back when the head closes.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="hydra-commit-amount">Amount</Label>
          <div className="relative">
            <Input
              id="hydra-commit-amount"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="0.00"
              inputMode="decimal"
              className="w-44 pr-16 font-mono"
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
              {ticker}
            </span>
          </div>
          <p className="max-w-sm text-xs text-muted-foreground">
            Costs one L1 confirmation before the deposit is built, so this takes a block or two.
          </p>
        </div>

        {isRunning && (
          <p className="text-xs text-muted-foreground">
            Carving the amount, then committing it. You can close this window; the head updates
            itself.
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              if (lovelace === null) return;
              setAmount('');
              onConfirm(lovelace);
            }}
            disabled={isRunning || lovelace === null}
          >
            {isRunning && <Loader2 className="h-4 w-4 animate-spin" />}
            Fund the head
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
