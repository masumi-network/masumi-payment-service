import { ArrowLeftRight, PlusCircle, Share } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** Export, top up and (mainnet only) swap. The parent owns what each one opens. */
export function WalletActionsBar({
  network,
  isExporting,
  onExport,
  onTopUp,
  onSwap,
}: {
  network: 'Preprod' | 'Mainnet';
  isExporting: boolean;
  onExport: () => void;
  onTopUp: () => void;
  onSwap: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" onClick={onTopUp}>
        <PlusCircle className="h-4 w-4" />
        <span>Top Up</span>
      </Button>
      {network === 'Mainnet' && (
        <Button variant="outline" onClick={onSwap}>
          <ArrowLeftRight className="h-4 w-4" />
          <span>Swap Assets</span>
        </Button>
      )}
      <Button variant="outline" onClick={onExport} disabled={isExporting}>
        <Share className="h-4 w-4" />
        <span>Export Wallet</span>
      </Button>
    </div>
  );
}
