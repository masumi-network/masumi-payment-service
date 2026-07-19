import { ArrowUpRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { convertBaseUnitsToDecimal } from '@/lib/convertDecimalToBaseUnits';
import { formatDate } from '@/lib/format-date';
import { getExplorerUrl, shortenAddress } from '@/lib/utils';

type FundDistribution = {
  id: string;
  createdAt: string | Date;
  fundWalletId: string | null;
  targetWalletId: string;
  priority: 'Warning' | 'Critical';
  assetUnit: string;
  amount: string;
  status: 'Pending' | 'Submitted' | 'Confirmed' | 'Failed';
  txHash: string | null;
  error: string | null;
};

function statusVariant(status: FundDistribution['status']) {
  switch (status) {
    case 'Confirmed':
      return 'success' as const;
    case 'Failed':
      return 'destructive' as const;
    case 'Submitted':
      return 'processing' as const;
    case 'Pending':
      return 'pending' as const;
  }
}

function formatDistributionAmount(distribution: FundDistribution) {
  if (distribution.assetUnit === 'lovelace') {
    return `${convertBaseUnitsToDecimal(distribution.amount)} ADA`;
  }

  return `${distribution.amount} ${shortenAddress(distribution.assetUnit, 8)}`;
}

export function FundDistributionList({
  distributions,
  isLoading,
  network,
}: {
  distributions: FundDistribution[];
  isLoading: boolean;
  network: string;
}) {
  if (isLoading) {
    return (
      <div className="flex justify-center py-6">
        <Spinner size={16} />
      </div>
    );
  }

  if (distributions.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        No top-ups yet. They appear here once a wallet on this payment source runs low.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {distributions.map((distribution) => (
        <div key={distribution.id} className="rounded-md border p-3 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">{formatDistributionAmount(distribution)}</span>
            <div className="flex items-center gap-2">
              {distribution.fundWalletId == null && distribution.status === 'Pending' && (
                <Badge variant="outline" className="text-xs">
                  Awaiting fund wallet
                </Badge>
              )}
              {distribution.priority === 'Critical' && (
                <Badge variant="outline" className="text-xs">
                  Critical
                </Badge>
              )}
              <Badge variant={statusVariant(distribution.status)} className="text-xs">
                {distribution.status}
              </Badge>
            </div>
          </div>
          <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{formatDate(distribution.createdAt)}</span>
            {distribution.txHash && (
              <a
                href={getExplorerUrl(distribution.txHash, network, 'transaction')}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                {shortenAddress(distribution.txHash)}
                <ArrowUpRight className="h-3 w-3" />
              </a>
            )}
          </div>
          {distribution.error && (
            <p className="mt-1 text-xs text-destructive break-words">{distribution.error}</p>
          )}
        </div>
      ))}
    </div>
  );
}
