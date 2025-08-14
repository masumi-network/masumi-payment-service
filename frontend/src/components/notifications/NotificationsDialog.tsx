import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useTransactions } from '@/lib/hooks/useTransactions';
import { useRouter } from 'next/router';
import { formatDistanceToNow } from 'date-fns';

interface NotificationsDialogProps {
  open: boolean;
  onClose: () => void;
}

export function NotificationsDialog({
  open,
  onClose,
}: NotificationsDialogProps) {
  const router = useRouter();
  const { transactions, newTransactionsCount, markAllAsRead } =
    useTransactions();

  const handleViewTransactions = () => {
    onClose();
    markAllAsRead();
    router.push('/transactions');
  };

  const newTransactions = transactions
    .slice(0, newTransactionsCount)
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Notifications</DialogTitle>
        </DialogHeader>
        {newTransactions.length > 0 ? (
          <div className="space-y-4 max-h-96 overflow-y-auto">
            <div className="space-y-2">
              {newTransactions.map((transaction) => (
                <div
                  key={transaction.id}
                  className="flex items-start justify-between p-3 rounded-lg hover:bg-muted cursor-pointer"
                  onClick={handleViewTransactions}
                >
                  <div className="space-y-1">
                    <p className="text-sm font-medium">
                      New {transaction.type} transaction
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Amount:{' '}
                      {transaction.Amounts?.[0]
                        ? `${(parseInt(transaction.Amounts[0].amount) / 1000000).toFixed(2)} ₳`
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
            <button
              onClick={handleViewTransactions}
              className="w-full text-sm text-primary hover:underline"
            >
              View all transactions
            </button>
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
