import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { dateRangeUtils, endOfDayLocal, parseDateOnlyLocal } from '@/lib/utils';
import { useAppContext } from '@/lib/contexts/AppContext';
import { getPayment, getPurchase, Payment, Purchase } from '@/lib/api/generated';
import {
  buildTransactionDownloadQuery,
  mergeDownloadedTransactions,
} from './download-details.helpers';

type Transaction =
  | (Payment & { type: 'payment' })
  | (Purchase & {
      type: 'purchase';
    });

interface DownloadDetailsDialogProps {
  open: boolean;
  onClose: () => void;
  onDownload: (startDate: Date, endDate: Date, transactions: Transaction[]) => void;
}

type PresetOption = '24h' | '7d' | '30d' | '90d' | 'custom';

const PRESET_OPTIONS = [
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last week' },
  { value: '30d', label: 'Last month' },
  { value: '90d', label: 'Last 3 months' },
  { value: 'custom', label: 'Custom range' },
];

export function DownloadDetailsDialog({ open, onClose, onDownload }: DownloadDetailsDialogProps) {
  const { apiClient, network } = useAppContext();
  const [selectedPreset, setSelectedPreset] = useState<PresetOption>('24h');
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');

  const fetchAllTransactions = useCallback(async (): Promise<Transaction[]> => {
    const allTx: Transaction[] = [];
    let purchaseCursor: string | null = null;
    let paymentCursor: string | null = null;
    let hasMorePurchases = true;
    let hasMorePayments = true;

    try {
      // Fetch all purchases with pagination. Failures are console-only (no
      // toast) and end the loop with whatever pages already arrived — same
      // contract as the previous handleApiCall onError override.
      while (hasMorePurchases) {
        const purchases: Awaited<ReturnType<typeof getPurchase>> | null = await getPurchase({
          client: apiClient,
          query: buildTransactionDownloadQuery(network, purchaseCursor || undefined),
        }).catch((error: unknown) => {
          console.error('Failed to fetch purchases:', error);
          return null;
        });
        if (purchases && 'error' in purchases && purchases.error) {
          console.error('Failed to fetch purchases:', purchases.error);
          break;
        }

        if (purchases?.data?.data?.Purchases) {
          const nextPurchases = purchases.data.data.Purchases.map(
            (purchase) =>
              ({
                ...purchase,
                type: 'purchase',
              }) as Transaction,
          );
          const mergedPurchases = mergeDownloadedTransactions(allTx, nextPurchases);
          allTx.length = 0;
          allTx.push(...mergedPurchases);
          hasMorePurchases = purchases.data.data.Purchases.length === 100;
          purchaseCursor =
            purchases.data.data.Purchases[purchases.data.data.Purchases.length - 1]?.id;
        } else {
          hasMorePurchases = false;
        }
      }

      // Fetch all payments with pagination (same failure contract as above).
      while (hasMorePayments) {
        const payments: Awaited<ReturnType<typeof getPayment>> | null = await getPayment({
          client: apiClient,
          query: buildTransactionDownloadQuery(network, paymentCursor || undefined),
        }).catch((error: unknown) => {
          console.error('Failed to fetch payments:', error);
          return null;
        });
        if (payments && 'error' in payments && payments.error) {
          console.error('Failed to fetch payments:', payments.error);
          break;
        }

        if (payments?.data?.data?.Payments) {
          const nextPayments = payments.data.data.Payments.map(
            (payment) =>
              ({
                ...payment,
                type: 'payment',
              }) as Transaction,
          );
          const mergedPayments = mergeDownloadedTransactions(allTx, nextPayments);
          allTx.length = 0;
          allTx.push(...mergedPayments);
          hasMorePayments = payments.data.data.Payments.length === 100;
          paymentCursor = payments.data.data.Payments[payments.data.data.Payments.length - 1]?.id;
        } else {
          hasMorePayments = false;
        }
      }

      return allTx;
    } catch (error) {
      console.error('Error fetching transactions:', error);
      return allTx;
    }
  }, [apiClient, network]);

  // Refetches on every dialog open (enabled flip + zero staleTime), matching
  // the previous fetch-on-open effect.
  const { data: allTransactions = [], isFetching: isLoading } = useQuery<Transaction[]>({
    queryKey: ['download-transactions', network],
    queryFn: fetchAllTransactions,
    enabled: open,
    staleTime: 0,
  });
  // Calculate filtered transactions for display
  const getFilteredTransactions = useCallback(() => {
    let startDate: Date;
    let endDate: Date = new Date();

    if (selectedPreset === 'custom') {
      if (!customStartDate || !customEndDate) {
        return [];
      }
      // Parse the date-only inputs as a local-time range (start of the start
      // day to end of the end day); UTC parsing would drop the whole end day
      // for users west of UTC.
      const start = parseDateOnlyLocal(customStartDate);
      const end = parseDateOnlyLocal(customEndDate);
      if (!start || !end) {
        return [];
      }
      startDate = start;
      endDate = endOfDayLocal(end);
    } else {
      const range = dateRangeUtils.getPresetRange(selectedPreset);
      startDate = range.start;
      endDate = range.end;
    }

    const filtered = allTransactions.filter((tx) => {
      const txDate = new Date(tx.createdAt);
      return txDate >= startDate && txDate <= endDate;
    });

    return filtered;
  }, [allTransactions, selectedPreset, customStartDate, customEndDate]);
  // Pure derived state: recomputes from the fetched transactions and the
  // selected range. Empty while the dialog is closed.
  const filteredTransactions = useMemo(
    () => (open ? getFilteredTransactions() : []),
    [open, getFilteredTransactions],
  );

  const handleDownload = () => {
    let startDate: Date;
    let endDate: Date = new Date();

    if (selectedPreset === 'custom') {
      if (!customStartDate || !customEndDate) {
        return; // Don't download if custom dates are not set
      }
      // Same local-time range as the preview count in getFilteredTransactions.
      const start = parseDateOnlyLocal(customStartDate);
      const end = parseDateOnlyLocal(customEndDate);
      if (!start || !end) {
        return;
      }
      startDate = start;
      endDate = endOfDayLocal(end);
    } else {
      // Calculate start date based on preset
      const range = dateRangeUtils.getPresetRange(selectedPreset);
      startDate = range.start;
      endDate = range.end;
    }

    // Use the same filtered transactions
    const filteredTransactions = getFilteredTransactions();

    onDownload(startDate, endDate, filteredTransactions);
    onClose();
  };

  const handleReset = () => {
    setSelectedPreset('24h');
    setCustomStartDate('');
    setCustomEndDate('');
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Download transactions as CSV</DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          <div className="space-y-4">
            <Label className="text-sm font-medium">Select Date Range</Label>
            <Select
              value={selectedPreset}
              onValueChange={(value) => setSelectedPreset(value as PresetOption)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Choose a date range" />
              </SelectTrigger>
              <SelectContent>
                {PRESET_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {selectedPreset === 'custom' && (
            <div className="space-y-4 p-4 bg-muted/20 border border-muted rounded-lg">
              <div className="space-y-2">
                <Label htmlFor="start-date">Start Date</Label>
                <Input
                  id="start-date"
                  type="date"
                  value={customStartDate}
                  max={new Date().toISOString().split('T')[0]}
                  onChange={(e) => setCustomStartDate(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="end-date">End Date</Label>
                <Input
                  id="end-date"
                  type="date"
                  value={customEndDate}
                  max={new Date().toISOString().split('T')[0]}
                  onChange={(e) => setCustomEndDate(e.target.value)}
                />
              </div>
            </div>
          )}

          <div className="text-sm text-muted-foreground">
            <p>
              Transactions:{' '}
              <span className="font-medium">
                {isLoading ? 'Loading...' : filteredTransactions?.length || 0}
              </span>
              {!isLoading && filteredTransactions && (
                <span className="text-muted-foreground">
                  {' '}
                  (payments: {filteredTransactions.filter((t) => t.type === 'payment').length},
                  purchases: {filteredTransactions.filter((t) => t.type === 'purchase').length})
                </span>
              )}
            </p>
            <p>
              Selected range:{' '}
              <span className="font-medium">
                {selectedPreset === 'custom'
                  ? customStartDate && customEndDate
                    ? `${customStartDate} to ${customEndDate}`
                    : 'Please select dates'
                  : PRESET_OPTIONS.find((opt) => opt.value === selectedPreset)?.label}
              </span>
            </p>
          </div>

          <div className="flex justify-between">
            <Button variant="outline" onClick={handleReset}>
              Reset
            </Button>
            <div className="flex justify-end">
              <Button
                onClick={handleDownload}
                disabled={
                  isLoading || (selectedPreset === 'custom' && (!customStartDate || !customEndDate))
                }
              >
                <Download className="h-4 w-4 mr-2" />
                {isLoading ? 'Loading...' : 'Download CSV'}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
