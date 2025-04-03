import { useEffect } from 'react';
import { Button } from '../ui/button';
import { X } from 'lucide-react';
import { createPortal } from 'react-dom';

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

  const content = (
    <div className="fixed inset-0 z-[9999] bg-black/80 flex items-center justify-center">
      <div className="relative w-[450px] h-[650px] bg-white rounded-lg">
        <Button
          variant="ghost"
          size="icon"
          className="absolute right-2 top-2 z-10"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
        <iframe
          src={transakUrl.toString()}
          className="w-full h-full rounded-lg"
          allow="camera;microphone;fullscreen;payment"
        />
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
