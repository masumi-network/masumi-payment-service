import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { WalletLink } from '@/components/ui/wallet-link';
import type { GetWalletGuardedResponses } from '@/lib/api/generated';
import { periodUsePercent } from '@/components/wallets/guarded-hydra-utils';
import { assetLabelOf, formatAssetAmount } from '@/components/wallets/guarded-assets';
import { GuardedOwnerSection } from './GuardedOwnerSection';

type GuardedState = NonNullable<GetWalletGuardedResponses[200]['data']>;
type Guarded = NonNullable<GuardedState['guardedWallet']>;

type ChainAsset = NonNullable<GuardedState['chain']>['assets'][number];

/** One asset: what the wallet holds, and what the period limit lets agents spend. */
function AssetRow({ asset, network }: { asset: ChainAsset; network: 'Preprod' | 'Mainnet' }) {
  const amount = (quantity: string) => formatAssetAmount(quantity, asset.unit, network);
  return (
    <div className="grid grid-cols-2 gap-px bg-border">
      <div className="flex flex-col gap-1 bg-background px-4 py-3">
        <div className="text-xs text-muted-foreground">
          {assetLabelOf(asset.unit, network)} balance
        </div>
        <div className="text-sm font-medium">{amount(asset.quantity)}</div>
      </div>
      <div className="flex flex-col gap-1 bg-background px-4 py-3">
        <div className="text-xs text-muted-foreground">Spent this period</div>
        {asset.limit == null || asset.spentInPeriod == null ? (
          <div className="text-sm text-muted-foreground">No limit: agents cannot move it</div>
        ) : (
          <div className="text-sm font-medium">
            {amount(asset.spentInPeriod)}
            <span className="font-normal text-muted-foreground"> of {amount(asset.limit)}</span>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${periodUsePercent(asset.spentInPeriod, asset.limit)}%` }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** A guarded wallet that exists: its limits, its Hydra moves, and the way out. */
export function GuardedWalletSummary({
  hotWalletId,
  agentVkh,
  network,
  guarded,
  chain,
  chainError,
  isSubmitting,
  onDetach,
}: {
  hotWalletId: string;
  agentVkh: string;
  network: 'Preprod' | 'Mainnet';
  guarded: Guarded;
  chain: GuardedState['chain'];
  chainError: string | null;
  isSubmitting: boolean;
  onDetach: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-hidden rounded-lg border">
        <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
          <div className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 h-4 w-4 text-primary" />
            <div>
              <div className="text-sm font-medium">Guarded smart wallet</div>
              <div className="text-xs text-muted-foreground">
                Agents pay in {assetLabelOf(guarded.governedAsset, network)}. Every purchase needs{' '}
                {guarded.threshold} of {guarded.quorumVkhs.length} Exchain co-signatures within the
                mandate.
              </div>
            </div>
          </div>
          <div className="shrink-0 whitespace-nowrap">
            <WalletLink address={guarded.scriptAddress} network={network} shorten={8} />
          </div>
        </div>
        {chain ? (
          <div className="flex flex-col gap-px bg-border">
            {chain.assets.map((asset) => (
              <AssetRow key={asset.unit} asset={asset} network={network} />
            ))}
          </div>
        ) : (
          <div className="px-4 py-3 text-sm text-destructive">
            Could not read the wallet on chain: {chainError}
          </div>
        )}
        <div className="border-t px-4 py-2 text-xs text-muted-foreground">
          Exchain wallet{' '}
          <span className="font-mono">{guarded.exchainWalletId ?? 'not registered'}</span>
        </div>
      </div>

      <GuardedOwnerSection
        hotWalletId={hotWalletId}
        agentVkh={agentVkh}
        network={network}
        guarded={guarded}
        chain={chain}
      />

      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={onDetach}
          disabled={isSubmitting}
        >
          Remove guard
        </Button>
      </div>
    </div>
  );
}
