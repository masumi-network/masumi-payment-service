import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useTransactions } from '@/lib/hooks/useTransactions';
import { formatDistanceToNow } from 'date-fns';
import { useRouter } from 'next/router';
import { shortenAddress } from '@/lib/utils';
import { AlertTriangle } from 'lucide-react';
import { type WalletAlertNotification } from '@/lib/hooks/useWalletAlertNotifications';

interface NotificationsDialogProps {
  open: boolean;
  onClose: () => void;
  walletAlerts: WalletAlertNotification[];
  onAcknowledgeWalletAlerts: (walletAlerts?: WalletAlertNotification[]) => void;
}

export function NotificationsDialog({
  open,
  onClose,
  walletAlerts,
  onAcknowledgeWalletAlerts,
}: NotificationsDialogProps) {
  const { transactions, newTransactionsCount, markAllAsRead } = useTransactions();
  const router = useRouter();

  const handleViewTransactions = () => {
    markAllAsRead();
    onClose();
    router.push('/transactions');
  };

  const handleViewWallets = () => {
    onAcknowledgeWalletAlerts(walletAlerts);
    onClose();
    router.push('/wallets');
  };

  const newTransactions = transactions
    .slice(0, newTransactionsCount)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const hasNotifications = walletAlerts.length > 0 || newTransactions.length > 0;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Notifications</DialogTitle>
        </DialogHeader>
        {hasNotifications ? (
          <div className="space-y-4 max-h-96 overflow-y-auto">
            {walletAlerts.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Wallet alerts
                  </p>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onAcknowledgeWalletAlerts(walletAlerts)}
                    >
                      Mark seen
                    </Button>
                    <Button variant="ghost" size="sm" onClick={handleViewWallets}>
                      View wallets
                    </Button>
                  </div>
                </div>
                {walletAlerts.map((wallet, index) => (
                  <div
                    key={wallet.id}
                    className="flex items-start justify-between rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 hover:bg-amber-500/15 cursor-pointer animate-fade-in-up opacity-0"
                    style={{ animationDelay: `${Math.min(index, 7) * 40}ms` }}
                    onClick={handleViewWallets}
                  >
                    <div className="space-y-1">
                      <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                        <AlertTriangle className="h-4 w-4 text-amber-500" />
                        Low balance alert
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {wallet.type === 'Purchasing' ? 'Buying wallet' : 'Selling wallet'}
                        {wallet.note ? ` • ${wallet.note}` : ''}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {shortenAddress(wallet.walletAddress)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {wallet.lowRuleCount === 1
                          ? '1 threshold is currently below its configured limit'
                          : `${wallet.lowRuleCount} thresholds are currently below their configured limits`}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {wallet.lastCheckedAt
                          ? `Last checked ${formatDistanceToNow(new Date(wallet.lastCheckedAt), {
                              addSuffix: true,
                            })}`
                          : 'Awaiting latest wallet balance check'}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {newTransactions.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Transactions
                  </p>
                  <Button variant="ghost" size="sm" onClick={handleViewTransactions}>
                    View all
                  </Button>
                </div>
                {newTransactions.map((transaction, index) => (
                  <div
                    key={transaction.id}
                    className="flex items-start justify-between p-3 rounded-lg hover:bg-muted cursor-pointer animate-fade-in-up opacity-0"
                    style={{ animationDelay: `${Math.min(index + walletAlerts.length, 7) * 40}ms` }}
                    onClick={handleViewTransactions}
                  >
                    <div className="space-y-1">
                      <p className="text-sm font-medium">New {transaction.type} transaction</p>
                      <p className="text-xs text-muted-foreground">
                        Amount:{' '}
                        {transaction.Amounts?.[0]
                          ? `${(parseInt(transaction.Amounts[0].amount) / 1000000).toFixed(2)} ADA`
                          : '—'}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(transaction.createdAt), {
                          addSuffix: true,
                        })}
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {transaction.onChainState}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            No new notifications
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
