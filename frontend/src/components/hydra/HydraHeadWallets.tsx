/**
 * The two wallets a head is between.
 *
 * A head is not "with an organisation", it is between one of your wallets and
 * one of theirs, and payments route through it only when the agent's seller
 * wallet is that exact counterparty. Nothing in this dialog said so, which is
 * how a perfectly healthy open head sat unused while every payment went to L1:
 * the agent had been registered under a different selling wallet than the one
 * that redeemed the invite, and there was no way to notice.
 *
 * The node keys are shown apart from the wallets on purpose. They look alike
 * and are routinely confused, but a node key is the head's on-chain identity
 * and holds only its own fees, while the wallet is what settles, keeping ADR
 * 0010 §3's separation legible is worth the extra line.
 */

import { ArrowRight } from 'lucide-react';
import { CopyButton } from '@/components/ui/copy-button';
import { WalletLink } from '@/components/ui/wallet-link';
import { shortenAddress } from '@/lib/utils';
import { HydraWalletLink } from '@/components/hydra/HydraWalletLink';

type Party = {
  label: string;
  wallet:
    | {
        walletVkey: string;
        walletAddress: string;
      }
    | undefined;
  network: string;
  onWalletClick?: () => void;
  /** The node's own Cardano key hash — its on-chain identity, not its funds. */
  cardanoVkey: string | undefined;
};

function PartyCard({ label, wallet, network, onWalletClick, cardanoVkey }: Party) {
  return (
    <div className="min-w-0 flex-1 space-y-2 rounded-md border bg-muted/10 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>

      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">Settles with</p>
        {wallet ? (
          <WalletLink
            address={wallet.walletAddress}
            vkey={wallet.walletVkey}
            network={network}
            shorten={10}
            onInternalClick={onWalletClick}
          />
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
  localWallet,
  localCardanoVkey,
  remoteWallet,
  remoteCardanoVkey,
  network,
  onLocalWalletClick,
  onRemoteWalletClick,
}: {
  localWallet: Party['wallet'];
  localCardanoVkey: string | undefined;
  remoteWallet: Party['wallet'];
  remoteCardanoVkey: string | undefined;
  network: string;
  onLocalWalletClick?: () => void;
  onRemoteWalletClick?: () => void;
}) {
  return (
    <div className="space-y-2">
      <h3 className="font-medium">Between</h3>
      <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
        <PartyCard
          label="Your wallet"
          wallet={localWallet}
          cardanoVkey={localCardanoVkey}
          network={network}
          onWalletClick={onLocalWalletClick}
        />
        <ArrowRight className="mx-auto h-4 w-4 shrink-0 rotate-90 text-muted-foreground sm:rotate-0" />
        <PartyCard
          label="Counterparty"
          wallet={remoteWallet}
          cardanoVkey={remoteCardanoVkey}
          network={network}
          onWalletClick={onRemoteWalletClick}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        A payment uses this head only when the agent&apos;s seller wallet is this exact
        counterparty. If they differ, the payment settles on L1 instead.
      </p>
    </div>
  );
}
