/**
 * A wallet on a Hydra screen, shown the way wallets are shown everywhere else.
 *
 * These screens were rendering `walletId` straight from the payload, so an
 * operator was asked to recognise `cmsdk24mu000jo8vbmi2x6c4g` as one of their
 * own wallets. It identifies nothing they have ever seen: it is not on chain,
 * not in any explorer, and not what the wallets page shows.
 *
 * So the address is shown instead, and it behaves like an address does in the
 * rest of the admin: one of ours opens the wallet dialog, anyone else's opens
 * the explorer. Recognising the counterparty is the whole point of the screen
 * it appears on.
 */

import { useState } from 'react';
import { WalletLink } from '@/components/ui/wallet-link';
import {
  WalletDetailsDialog,
  type WalletWithBalance,
} from '@/components/wallets/WalletDetailsDialog';
import { useWallets } from '@/lib/queries/useWallets';

export function HydraWalletLink({
  address,
  network,
  shorten = 12,
  className,
}: {
  address: string | undefined;
  network: string;
  shorten?: number;
  className?: string;
}) {
  const { wallets } = useWallets();
  const [openWallet, setOpenWallet] = useState<WalletWithBalance | null>(null);

  if (!address) {
    return <span className="text-sm text-muted-foreground">Not recorded</span>;
  }

  const own = wallets.find((wallet) => wallet.walletAddress === address);

  return (
    <>
      <WalletLink
        address={address}
        network={network}
        shorten={shorten}
        className={className}
        onInternalClick={own ? () => setOpenWallet(own as WalletWithBalance) : undefined}
      />
      <WalletDetailsDialog
        isOpen={openWallet !== null}
        onClose={() => setOpenWallet(null)}
        wallet={openWallet}
        isChild
      />
    </>
  );
}
