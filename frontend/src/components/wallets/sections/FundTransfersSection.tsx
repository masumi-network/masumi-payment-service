import { Button } from '@/components/ui/button';
import { RefreshCw, ExternalLink, ArrowUpRight } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { getWalletTransferFunds } from '@/lib/api/generated';
import type { WalletFundTransfer } from '@/lib/api/generated';
import { useAppContext } from '@/lib/contexts/AppContext';
import { extractApiPayload } from '@/lib/api-response';
import { shortenAddress, getExplorerUrl } from '@/lib/utils';
import { formatDateTime } from '@/lib/format-date';
import { FundTransferStatusBadge } from '@/components/wallets/FundTransferStatusBadge';
import { formatAda, formatAssetAmount } from '@/components/wallets/fund-transfer-format';

const PAGE_SIZE = 10;
const TERMINAL_STATUSES: WalletFundTransfer['status'][] = [
  'Confirmed',
  'FailedViaTimeout',
  'FailedViaManualReset',
  'RolledBack',
];

/**
 * Fund-transfer history for one wallet: outgoing transfers queued through the
 * Transfer Funds action, with their on-chain status. Confirmed transfers link
 * to the explorer. Fetches its own data so the parent dialog stays unchanged
 * beyond mounting it; polls while a transfer is still in flight.
 */
export function FundTransfersSection({
  walletAddress,
  network,
}: {
  walletAddress: string;
  network: 'Preprod' | 'Mainnet';
}) {
  const { apiClient } = useAppContext();

  const { data, isFetching, refetch } = useQuery({
    queryKey: ['fundTransfers', walletAddress],
    enabled: walletAddress !== '',
    // Keep polling while anything is still Pending so Pending → Confirmed shows
    // up without a manual refresh; stop once every row is terminal.
    refetchInterval: (query) => {
      const rows = query.state.data ?? [];
      return rows.some((t) => !TERMINAL_STATUSES.includes(t.status)) ? 6000 : false;
    },
    queryFn: async () => {
      const res = await getWalletTransferFunds({
        client: apiClient,
        query: { walletAddress, limit: PAGE_SIZE },
      });
      return extractApiPayload(res)?.transfers ?? [];
    },
  });

  const transfers = data ?? [];
  if (transfers.length === 0) return null;

  return (
    <div className="bg-muted rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">Fund Transfers</div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh fund transfers"
          className="h-7 w-7"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
        </Button>
      </div>
      <div className="space-y-2">
        {transfers.map((transfer) => (
          <div
            key={transfer.id}
            className="dark:border-muted-foreground/20 rounded-lg border p-3 space-y-1.5"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 space-y-0.5">
                <div className="text-sm font-medium tabular-nums">
                  {formatAda(transfer.lovelaceAmount)} ADA
                </div>
                {transfer.assets?.map((asset) => (
                  <div key={asset.unit} className="text-xs text-muted-foreground tabular-nums">
                    {formatAssetAmount(asset, network)}
                  </div>
                ))}
              </div>
              <FundTransferStatusBadge status={transfer.status} />
            </div>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <ArrowUpRight className="h-3 w-3 shrink-0" />
              <span className="truncate">{shortenAddress(transfer.toAddress)}</span>
              <span className="shrink-0">· {formatDateTime(transfer.createdAt)}</span>
            </div>
            {transfer.txHash && (
              <a
                href={getExplorerUrl(transfer.txHash, network, 'transaction')}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                {shortenAddress(transfer.txHash)} <ExternalLink className="h-3 w-3" />
              </a>
            )}
            {transfer.errorNote && <p className="text-xs text-destructive">{transfer.errorNote}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
