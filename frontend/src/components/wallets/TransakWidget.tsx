import { useEffect } from 'react';
import { Button } from '../ui/button';
import { useAppContext } from '@/lib/contexts/AppContext';
import { CopyButton } from '../ui/copy-button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog';
import { shortenAddress } from '@/lib/utils';
import { ExternalLink } from 'lucide-react';

interface TransakWidgetProps {
  isOpen: boolean;
  onClose: () => void;
  walletAddress: string;
  onSuccess?: () => void;
  isChild?: boolean;
  elevatedGrandchildStack?: boolean;
}

export function TransakWidget({
  isOpen,
  onClose,
  walletAddress,
  onSuccess,
  isChild,
  elevatedGrandchildStack,
}: TransakWidgetProps) {
  const { network } = useAppContext();

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data.type === 'TRANSAK_ORDER_SUCCESSFUL') {
        onSuccess?.();
        onClose();
      } else if (event.data.type === 'TRANSAK_ORDER_FAILED') {
        console.error('Order failed:', event.data);
        onClose();
      } else if (
        event.data.type?.includes('TRANSAK_WIDGET_CLOSE') ||
        event.data.type?.includes('TRANSAK_EXIT')
      ) {
        onClose();
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onClose, onSuccess]);

  if (!isOpen) return null;

  if (network === 'Preprod') {
    const handleOpenFaucet = () => {
      window.open('https://docs.cardano.org/cardano-testnet/tools/faucet/', '_blank');
    };

    return (
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent
          variant={isChild ? 'slide-from-right' : 'default'}
          hideOverlay={isChild}
          onBack={isChild ? onClose : undefined}
          elevatedGrandchildStack={elevatedGrandchildStack}
        >
          <DialogHeader>
            <DialogTitle>Preprod Testnet Faucet</DialogTitle>
            <DialogDescription>
              Use the Cardano Foundation faucet to get test ADA for your wallet.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-2 h-full">
            <div className="bg-muted p-3 rounded-lg break-all flex items-center justify-between">
              <p className="text-sm font-mono text-foreground">{shortenAddress(walletAddress)}</p>
              <CopyButton value={walletAddress} />
            </div>
            <Button onClick={handleOpenFaucet} className="w-full mt-2">
              Open Faucet
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  const exchanges = [
    { name: 'Coinbase', url: 'https://www.coinbase.com/price/cardano' },
    { name: 'Kraken', url: 'https://www.kraken.com/prices/ada-cardano-price-chart' },
    { name: 'Binance', url: 'https://www.binance.com/en/price/cardano' },
    { name: 'Crypto.com', url: 'https://crypto.com/price/cardano' },
  ];

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent
        variant={isChild ? 'slide-from-right' : 'default'}
        hideOverlay={isChild}
        onBack={isChild ? onClose : undefined}
        elevatedGrandchildStack={elevatedGrandchildStack}
      >
        <DialogHeader>
          <DialogTitle>Top Up Wallet</DialogTitle>
          <DialogDescription>
            Send ADA to your wallet address to fund it. You can purchase ADA from any major
            cryptocurrency exchange and withdraw it to the address below.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 mt-2">
          <div className="bg-muted p-3 rounded-lg break-all flex items-center justify-between">
            <p className="text-sm font-mono text-foreground">{shortenAddress(walletAddress)}</p>
            <CopyButton value={walletAddress} />
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">Buy ADA on an exchange</p>
            <div className="grid grid-cols-2 gap-2">
              {exchanges.map((exchange) => (
                <Button
                  key={exchange.name}
                  variant="outline"
                  size="sm"
                  className="justify-between"
                  onClick={() => window.open(exchange.url, '_blank')}
                >
                  {exchange.name}
                  <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
              ))}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
