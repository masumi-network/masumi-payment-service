import { Badge } from '@/components/ui/badge';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useAppContext } from '@/lib/contexts/AppContext';
import { formatDateTime } from '@/lib/format-date';
import { useX402LowBalanceRules } from '@/lib/hooks/useX402';
import { X402Wallet } from '@/lib/api/generated';
import { AlertsTab } from './AlertsTab';
import { WalletBalances } from './WalletExtras';

export function WalletDetailsDialog({
  wallet,
  open,
  onClose,
  chainLabel,
}: {
  wallet: X402Wallet | null;
  open: boolean;
  onClose: () => void;
  chainLabel: (caip2: string) => string;
}) {
  const { capabilities } = useAppContext();

  if (!wallet) return null;

  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Wallet details</DialogTitle>
          <DialogDescription>{wallet.type} wallet</DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Overview</h3>
              {capabilities.canAdmin && <WalletLowBalanceBadge walletId={wallet.id} />}
            </div>
            <div className="grid gap-3 rounded-lg bg-muted/40 p-4 sm:grid-cols-2">
              <OverviewField label="Address">
                <span className="break-all font-mono text-xs">{wallet.address}</span>
                <CopyButton value={wallet.address} />
              </OverviewField>
              <OverviewField label="Chain">{chainLabel(wallet.caip2Network)}</OverviewField>
              <OverviewField label="Direction">{wallet.type}</OverviewField>
              <OverviewField label="Created">{formatDateTime(wallet.createdAt)}</OverviewField>
              {wallet.note && <OverviewField label="Note">{wallet.note}</OverviewField>}
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Balances</h3>
            <WalletBalances wallet={wallet} enabled={open} />
          </section>

          {capabilities.canAdmin && (
            <section className="space-y-3 border-t pt-5">
              <h3 className="text-sm font-semibold">Low-balance rules</h3>
              <AlertsTab wallet={wallet} />
            </section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function OverviewField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 flex items-center gap-1 text-sm">{children}</div>
    </div>
  );
}

export function WalletLowBalanceBadge({ walletId }: { walletId: string }) {
  const { rules, isLoading } = useX402LowBalanceRules();
  if (isLoading) return null;

  const lowCount = rules.filter(
    (rule) => rule.evmWalletId === walletId && rule.enabled && rule.status === 'Low',
  ).length;

  return lowCount > 0 ? <Badge variant="warning">Low balance · {lowCount}</Badge> : null;
}
