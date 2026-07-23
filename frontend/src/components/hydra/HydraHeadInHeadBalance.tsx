import { useHydraHeadBalance } from '@/lib/hooks/useHydraHeads';
import { formatAssetAmount } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';

interface HydraHeadInHeadBalanceProps {
  headId: string;
  /** In-head funds are only readable while the head is Open (live snapshot). */
  isOpen: boolean;
  network: string | undefined;
}

/**
 * Shows THIS node's own funds currently inside the head (ADA + native tokens) —
 * the local participant's committed balance, not the counterparty's. Read live
 * from the head snapshot via GET /hydra/head/balance.
 */
export function HydraHeadInHeadBalance({ headId, isOpen, network }: HydraHeadInHeadBalanceProps) {
  const { data, isLoading, isError } = useHydraHeadBalance(headId, isOpen);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">Your in-head balance</h3>
        <span className="text-xs text-muted-foreground">
          Own funds only — excludes the counterparty
        </span>
      </div>

      {!isOpen ? (
        <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          In-head balance is available once the head is open.
        </div>
      ) : isLoading ? (
        <div className="flex items-center gap-2 rounded-md border p-4 text-sm text-muted-foreground">
          <Spinner className="h-4 w-4" /> Reading head snapshot…
        </div>
      ) : isError || !data ? (
        <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          Could not read the in-head balance.
        </div>
      ) : !data.connected ? (
        <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          Head is not currently connected — balance unavailable.
        </div>
      ) : data.balance.length === 0 ? (
        <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          No funds committed to the head yet ({data.utxoCount} UTxOs).
        </div>
      ) : (
        <div className="rounded-md border divide-y">
          {data.balance.map((asset) => (
            <div
              key={asset.unit || 'ada'}
              className="flex items-center justify-between px-4 py-2 text-sm"
            >
              <span className="text-muted-foreground">{formatFundLabel(asset.unit, network)}</span>
              <span className="font-mono">
                {formatAssetAmount(asset.quantity, asset.unit || 'lovelace', network)}
              </span>
            </div>
          ))}
          <div className="px-4 py-2 text-xs text-muted-foreground">
            {data.utxoCount} in-head UTxO(s)
          </div>
        </div>
      )}
    </div>
  );
}

function formatFundLabel(unit: string, network: string | undefined): string {
  if (unit === '') return network?.toLowerCase() === 'mainnet' ? 'ADA' : 'tADA';
  // formatAssetAmount already appends the friendly unit; keep the left label short.
  return 'Token';
}
