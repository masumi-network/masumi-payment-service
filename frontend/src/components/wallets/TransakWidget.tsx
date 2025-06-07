import { useEffect } from 'react';
import { Button } from '../ui/button';
import { useAppContext } from '@/lib/contexts/AppContext';
import { CopyButton } from '../ui/copy-button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../ui/dialog';
import { shortenAddress } from '@/lib/utils';

interface TransakWidgetProps {
  isOpen: boolean;
  onClose: () => void;
  walletAddress: string;
  onSuccess?: () => void;
}

export function TransakWidget({
  isOpen,
  onClose,
  walletAddress,
  onSuccess,
}: TransakWidgetProps) {
  const { state } = useAppContext();

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data.type === 'TRANSAK_ORDER_SUCCESSFUL') {
        onSuccess?.();
        onClose();
      } else if (event.data.type === 'TRANSAK_ORDER_FAILED') {
        console.error('Order failed:', event.data);
        onClose();
      } else if (
        event.data.type?.includes('TRANSAK_WIDGET_CLOSE') ??
        event.data.type?.includes('TRANSAK_EXIT')
      ) {
        onClose();
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onClose, onSuccess]);

  if (!isOpen) return null;

  const isProduction = process.env.NEXT_PUBLIC_ENVIRONMENT === 'production';
  const isPreprod = state.network === 'Preprod';

  if (isPreprod) {
    const handleOpenFaucet = () => {
      window.open(
        'https://docs.cardano.org/cardano-testnet/tools/faucet/',
        '_blank',
      );
    };

    return (
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Preprod Testnet Faucet</DialogTitle>
            <DialogDescription>
              Use the Cardano Foundation faucet to get test ADA for your wallet.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-2 h-full">
            <div className="bg-muted p-3 rounded-lg break-all flex items-center justify-between">
              <p className="text-sm font-mono text-foreground">
                {shortenAddress(walletAddress)}
              </p>
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

  const transakUrl = new URL(
    isProduction
      ? 'https://global.transak.com'
      : 'https://global-stg.transak.com',
  );
  transakUrl.searchParams.set(
    'apiKey',
    process.env.NEXT_PUBLIC_TRANSAK_API_KEY!,
  );
  transakUrl.searchParams.set(
    'environment',
    isProduction ? 'PRODUCTION' : 'STAGING',
  );
  transakUrl.searchParams.set('cryptoCurrencyList', 'ADA');
  transakUrl.searchParams.set('defaultCryptoCurrency', 'ADA');
  transakUrl.searchParams.set('walletAddress', walletAddress);
  transakUrl.searchParams.set('themeColor', '#000000');
  transakUrl.searchParams.set('hideMenu', 'true');
  transakUrl.searchParams.set(
    'exchangeScreenTitle',
    'Top up your Masumi Wallet with ADA',
  );

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="p-0">
        <iframe
          src={transakUrl.toString()}
          className="w-full h-full rounded-lg"
          allow="camera;microphone;fullscreen;payment"
        />
      </DialogContent>
    </Dialog>
  );
}
