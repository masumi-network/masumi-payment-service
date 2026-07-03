import { AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

type ContractSyncStatus = 'in_sync' | 'outdated_contract' | 'custom_address';

interface PaymentSourceSyncBadgeProps {
  status: ContractSyncStatus;
  className?: string;
}

/**
 * Flags a Web3CardanoV2 payment source that is on a RETIRED on-chain contract
 * version (registry policyId no longer matches the current default). Such a
 * source has orphaned agents and a stale baked-in payment address; it must be
 * repointed (re-seed / scripts/replace-v2-payment-source.ts) and its agents
 * re-registered. `custom_address` and `in_sync` render nothing.
 */
export function PaymentSourceSyncBadge({ status, className }: PaymentSourceSyncBadgeProps) {
  if (status !== 'outdated_contract') {
    return null;
  }
  return (
    <Badge
      variant="outline"
      title="This V2 source is on a retired contract version (registry policyId mismatch). Its registered agents are orphaned and its on-chain payment address is stale. Repoint it (re-seed or scripts/replace-v2-payment-source.ts) and re-register agents."
      className={cn(
        'whitespace-nowrap border-red-300 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300',
        className,
      )}
    >
      <AlertTriangle className="mr-1 h-3 w-3" />
      Outdated contract
    </Badge>
  );
}
