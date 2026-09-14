import type { ReactNode } from 'react';
import Image from 'next/image';
import { Button } from '../ui/button';
import { useAppContext } from '@/lib/contexts/AppContext';
import { CopyButton } from '../ui/copy-button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog';
import { Droplets, ExternalLink, Wallet } from 'lucide-react';
import { getExplorerUrl } from '@/lib/utils';
import adaIcon from '@/assets/ada.png';

interface TransakWidgetProps {
  isOpen: boolean;
  onClose: () => void;
  walletAddress: string;
  /**
   * Legacy Transak-iframe success callback. No Transak iframe is rendered
   * anymore (this dialog only shows static faucet/exchange links), so it is
   * never invoked. Kept so existing call sites keep compiling.
   */
  onSuccess?: () => void;
  isChild?: boolean;
  /** Stack above a default parent modal (e.g. register agent opened from AI Agents). */
  elevatedChildStack?: boolean;
  elevatedGrandchildStack?: boolean;
}

const MAINNET_EXCHANGES = [
  { name: 'Coinbase', url: 'https://www.coinbase.com/price/cardano' },
  { name: 'Kraken', url: 'https://www.kraken.com/prices/ada-cardano-price-chart' },
  { name: 'Crypto.com', url: 'https://crypto.com/price/cardano' },
] as const;

function WalletDepositAddress({
  address,
  network,
}: {
  address: string;
  network: 'Preprod' | 'Mainnet';
}) {
  const explorerUrl = getExplorerUrl(address, network);

  return (
    <div className="overflow-hidden rounded-lg border bg-muted/30">
      <div className="flex items-center gap-2 border-b bg-muted/50 px-3 py-2">
        <Image src={adaIcon} alt="" width={18} height={18} className="rounded-full" aria-hidden />
        <span className="text-xs font-medium text-muted-foreground">Wallet address</span>
      </div>
      <div className="flex items-start gap-1 px-3 py-3">
        <p className="min-w-0 flex-1 break-all font-mono text-xs leading-relaxed text-foreground">
          {address}
        </p>
        <CopyButton value={address} className="h-8 w-8 shrink-0" />
      </div>
      <div className="border-t px-3 py-2">
        <a
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
        >
          View on Cardanoscan
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </div>
  );
}

function TopUpDialogShell({
  isOpen,
  onClose,
  isChild,
  elevatedChildStack,
  elevatedGrandchildStack,
  icon,
  title,
  description,
  children,
}: {
  isOpen: boolean;
  onClose: () => void;
  isChild?: boolean;
  elevatedChildStack?: boolean;
  elevatedGrandchildStack?: boolean;
  icon: ReactNode;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent
        size="md"
        variant={isChild ? 'slide-from-right' : 'default'}
        hideOverlay={isChild}
        onBack={isChild ? onClose : undefined}
        elevatedChildStack={elevatedChildStack}
        elevatedGrandchildStack={elevatedGrandchildStack}
      >
        <DialogHeader className="space-y-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            {icon}
          </div>
          <div className="space-y-1.5">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </div>
        </DialogHeader>
        <div className="mt-1 space-y-4">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

export function TransakWidget({
  isOpen,
  onClose,
  walletAddress,
  isChild,
  elevatedChildStack,
  elevatedGrandchildStack,
}: TransakWidgetProps) {
  const { network } = useAppContext();

  if (!isOpen) return null;

  if (network === 'Preprod') {
    return (
      <TopUpDialogShell
        isOpen={isOpen}
        onClose={onClose}
        isChild={isChild}
        elevatedChildStack={elevatedChildStack}
        elevatedGrandchildStack={elevatedGrandchildStack}
        icon={<Droplets className="h-5 w-5" aria-hidden />}
        title="Top up wallet"
        description="Send test ADA to this wallet address."
      >
        <WalletDepositAddress address={walletAddress} network="Preprod" />

        <p className="text-sm text-muted-foreground">
          Use the Cardano Preprod faucet if you need test ADA. Paste this address when you request
          funds.
        </p>

        <Button
          type="button"
          variant="outline"
          className="w-full gap-2"
          onClick={() =>
            window.open('https://docs.cardano.org/cardano-testnet/tools/faucet/', '_blank')
          }
        >
          <Droplets className="h-4 w-4" aria-hidden />
          Open Preprod faucet
        </Button>

        <p className="text-xs text-muted-foreground">
          Test ADA has no real value. Request only what you need.
        </p>
      </TopUpDialogShell>
    );
  }

  return (
    <TopUpDialogShell
      isOpen={isOpen}
      onClose={onClose}
      isChild={isChild}
      elevatedChildStack={elevatedChildStack}
      elevatedGrandchildStack={elevatedGrandchildStack}
      icon={<Wallet className="h-5 w-5" aria-hidden />}
      title="Top up wallet"
      description="Send ADA to this wallet address from another wallet or exchange."
    >
      <WalletDepositAddress address={walletAddress} network="Mainnet" />

      <p className="text-sm text-muted-foreground">
        Your balance updates after the transaction confirms on chain.
      </p>

      <div className="rounded-lg border border-dashed px-3 py-2.5">
        <p className="text-xs font-medium text-muted-foreground">Need to buy ADA first?</p>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
          {MAINNET_EXCHANGES.map((exchange) => (
            <a
              key={exchange.name}
              href={exchange.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              {exchange.name}
              <ExternalLink className="h-3 w-3" />
            </a>
          ))}
        </div>
      </div>
    </TopUpDialogShell>
  );
}
