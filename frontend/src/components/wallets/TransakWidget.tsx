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

  // Handle dialog close
  const handleClose = () => {
    onClose();
  };

  if (!isOpen) return null;

  const isPreprod = state.network === 'Preprod';

  if (isPreprod) {
    const handleOpenFaucet = () => {
      window.open(
        'https://docs.cardano.org/cardano-testnet/tools/faucet/',
        '_blank',
      );
    };

    return (
      <Dialog open={isOpen} onOpenChange={handleClose}>
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

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="p-0 h-full max-h-[600px]">
        <iframe
          src={`https://global.transak.com?apiKey=${process.env.NEXT_PUBLIC_TRANSAK_API_KEY}&environment=PRODUCTION&cryptoCurrencyList=ADA&defaultCryptoCurrency=ADA&walletAddress=${walletAddress}&themeColor=%23000000&hideMenu=true&exchangeScreenTitle=Top%20up%20your%20Masumi%20Wallet%20with%20ADA`}
          className="w-full h-full rounded-lg"
          allow="camera;microphone;fullscreen;payment"
        />
      </DialogContent>
    </Dialog>
  );
}
