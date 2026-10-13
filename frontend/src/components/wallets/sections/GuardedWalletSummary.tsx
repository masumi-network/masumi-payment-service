import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { WalletLink } from '@/components/ui/wallet-link';
import { formatLovelaceAsAda } from '@/lib/format-lovelace-display';
import type { GetWalletGuardedResponses } from '@/lib/api/generated';
import { periodUsePercent } from '@/components/wallets/guarded-hydra-utils';
import { GuardedHydraSection } from './GuardedHydraSection';

type GuardedState = NonNullable<GetWalletGuardedResponses[200]['data']>;
type Guarded = NonNullable<GuardedState['guardedWallet']>;

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 bg-background px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm font-medium">{children}</div>
    </div>
  );
}

/** A guarded wallet that exists: its limits, its Hydra moves, and the way out. */
export function GuardedWalletSummary({
  hotWalletId,
  network,
  guarded,
  chain,
  chainError,
  isSubmitting,
  onDetach,
}: {
  hotWalletId: string;
  network: 'Preprod' | 'Mainnet';
  guarded: Guarded;
  chain: GuardedState['chain'];
  chainError: string | null;
  isSubmitting: boolean;
  onDetach: () => void;
}) {
  const usePercent =
    chain == null ? 0 : periodUsePercent(chain.spentInPeriodLovelace, chain.periodLimitLovelace);

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-hidden rounded-lg border">
        <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
          <div className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 h-4 w-4 text-primary" />
            <div>
              <div className="text-sm font-medium">Guarded smart wallet</div>
              <div className="text-xs text-muted-foreground">
                Every purchase needs {guarded.threshold} of {guarded.quorumVkhs.length} Exchain
                co-signatures within the mandate.
              </div>
            </div>
          </div>
          <div className="shrink-0 whitespace-nowrap">
            <WalletLink address={guarded.scriptAddress} network={network} shorten={8} />
          </div>
        </div>
        {chain ? (
          <div className="grid grid-cols-2 gap-px bg-border">
            <Stat label="Balance">{formatLovelaceAsAda(chain.lovelace)}</Stat>
            <Stat label="Spent this period">
              <span>
                {formatLovelaceAsAda(chain.spentInPeriodLovelace)}
                <span className="font-normal text-muted-foreground">
                  {' '}
                  of {formatLovelaceAsAda(chain.periodLimitLovelace)}
                </span>
              </span>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${usePercent}%` }}
                />
              </div>
            </Stat>
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

      <GuardedHydraSection
        hotWalletId={hotWalletId}
        ownerAddress={guarded.ownerAddress}
        network={network}
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
