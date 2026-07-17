import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, ExternalLink } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { getWalletTransferFunds } from '@/lib/api/generated';
import type { WalletFundTransfer } from '@/lib/api/generated';
import { useAppContext } from '@/lib/contexts/AppContext';
import { extractApiPayload } from '@/lib/api-response';
import { shortenAddress, getExplorerUrl } from '@/lib/utils';
import { formatDateTime } from '@/lib/format-date';

const PAGE_SIZE = 10;
const TERMINAL_STATUSES: WalletFundTransfer['status'][] = [
  'Confirmed',
  'FailedViaTimeout',
  'FailedViaManualReset',
  'RolledBack',
];

function statusBadgeVariant(status: WalletFundTransfer['status']) {
  if (status === 'Confirmed') return 'default' as const;
  if (status === 'Pending') return 'secondary' as const;
  return 'destructive' as const;
}

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
    <div className="bg-muted rounded-lg p-4 space-y-2">
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
          <div key={transfer.id} className="rounded-md border bg-background/50 p-3 space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">
                {Number(transfer.lovelaceAmount) / 1e6} ADA
                {transfer.assets && transfer.assets.length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {' '}
                    + {transfer.assets.length} token{transfer.assets.length > 1 ? 's' : ''}
                  </span>
                )}
              </span>
              <Badge variant={statusBadgeVariant(transfer.status)}>{transfer.status}</Badge>
            </div>
            <div className="text-xs text-muted-foreground">
              to {shortenAddress(transfer.toAddress)} · {formatDateTime(transfer.createdAt)}
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
