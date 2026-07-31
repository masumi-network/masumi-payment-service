/**
 * The two wallets a head is between.
 *
 * A head is not "with an organisation", it is between one of your wallets and
 * one of theirs — and payments route through it only when the agent's seller
 * wallet is that exact counterparty. Nothing in this dialog said so, which is
 * how a perfectly healthy open head sat unused while every payment went to L1:
 * the agent had been registered under a different selling wallet than the one
 * that redeemed the invite, and there was no way to notice.
 *
 * The node keys are shown apart from the wallets on purpose. They look alike
 * and are routinely confused, but a node key is the head's on-chain identity
 * and holds only its own fees, while the wallet is what settles — keeping ADR
 * 0010 §3's separation legible is worth the extra line.
 */

import { ArrowRight } from 'lucide-react';
import { CopyButton } from '@/components/ui/copy-button';
import { shortenAddress } from '@/lib/utils';

type Party = {
  label: string;
  walletId: string | undefined;
  /** The node's own Cardano key hash — its on-chain identity, not its funds. */
  cardanoVkey: string | undefined;
};

function PartyCard({ label, walletId, cardanoVkey }: Party) {
  return (
    <div className="min-w-0 flex-1 space-y-2 rounded-md border bg-muted/10 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>

      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">Settles with</p>
        {walletId ? (
          <div className="flex items-center gap-1">
            <span className="truncate font-mono text-sm">{shortenAddress(walletId, 10)}</span>
            <CopyButton value={walletId} className="h-6 w-6" />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">—</p>
        )}
      </div>

      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">Node key</p>
        {cardanoVkey ? (
          <div className="flex items-center gap-1">
            <span className="truncate font-mono text-xs text-muted-foreground">
              {shortenAddress(cardanoVkey, 8)}
            </span>
            <CopyButton value={cardanoVkey} className="h-6 w-6" />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">—</p>
        )}
      </div>
    </div>
  );
}

export function HydraHeadWallets({
  localWalletId,
  localCardanoVkey,
  remoteWalletId,
  remoteCardanoVkey,
}: {
  localWalletId: string | undefined;
  localCardanoVkey: string | undefined;
  remoteWalletId: string | undefined;
  remoteCardanoVkey: string | undefined;
}) {
  return (
    <div className="space-y-2">
      <h3 className="font-medium">Between</h3>
      <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
        <PartyCard label="Your wallet" walletId={localWalletId} cardanoVkey={localCardanoVkey} />
        <ArrowRight className="mx-auto h-4 w-4 shrink-0 rotate-90 text-muted-foreground sm:rotate-0" />
        <PartyCard label="Counterparty" walletId={remoteWalletId} cardanoVkey={remoteCardanoVkey} />
      </div>
      <p className="text-xs text-muted-foreground">
        A payment uses this head only when the agent&apos;s seller wallet is this exact
        counterparty. If they differ, the payment settles on L1 instead.
      </p>
    </div>
  );
}
