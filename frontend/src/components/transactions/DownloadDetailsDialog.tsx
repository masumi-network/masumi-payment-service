import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { useState, useEffect, useCallback } from 'react';
import { Download } from 'lucide-react';
import { dateRangeUtils } from '@/lib/utils';
import { useAppContext } from '@/lib/contexts/AppContext';
import {
  getPayment,
  getPurchase,
  GetPaymentResponses,
  GetPurchaseResponses,
} from '@/lib/api/generated';
import { handleApiCall } from '@/lib/utils';

type Transaction =
  | (GetPaymentResponses['200']['data']['Payments'][0] & { type: 'payment' })
  | (GetPurchaseResponses['200']['data']['Purchases'][0] & {
    type: 'purchase';
  });

interface DownloadDetailsDialogProps {
  open: boolean;
  onClose: () => void;
  onDownload: (
    startDate: Date,
    endDate: Date,
    transactions: Transaction[],
  ) => void;
}

type PresetOption = '24h' | '7d' | '30d' | '90d' | 'custom';

const PRESET_OPTIONS = [
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last week' },
  { value: '30d', label: 'Last month' },
  { value: '90d', label: 'Last 3 months' },
  { value: 'custom', label: 'Custom range' },
];

export function DownloadDetailsDialog({
  open,
  onClose,
  onDownload,
}: DownloadDetailsDialogProps) {
  const { apiClient } = useAppContext();
  const [selectedPreset, setSelectedPreset] = useState<PresetOption>('24h');
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [allTransactions, setAllTransactions] = useState<Transaction[]>([]);
  const [filteredTransactions, setFilteredTransactions] = useState<Transaction[]>([]);

  const fetchAllTransactions = useCallback(async () => {
    setIsLoading(true);

    const allTx: Transaction[] = [];
    let purchaseCursor: string | null = null;
    let paymentCursor: string | null = null;
    let hasMorePurchases = true;
    let hasMorePayments = true;

    try {
      // Fetch all purchases with pagination
      while (hasMorePurchases) {
        const purchases = await handleApiCall(
          () =>
            getPurchase({
              client: apiClient,
              query: {
                network: 'Preprod',
                cursorId: purchaseCursor || undefined,
                includeHistory: 'true',
                limit: 100,
              },
            }),
          {
            onError: (error: unknown) => {
              console.error('Failed to fetch purchases:', error);
            },
            errorMessage: 'Failed to fetch purchases',
          },
        );

        if (purchases?.data?.data?.Purchases) {
          purchases.data.data.Purchases.forEach((purchase) => {
            allTx.push({
              ...purchase,
              type: 'purchase',
            } as Transaction);
          });
          hasMorePurchases = purchases.data.data.Purchases.length === 100;
          purchaseCursor =
            purchases.data.data.Purchases[
              purchases.data.data.Purchases.length - 1
            ]?.id;
        } else {
          hasMorePurchases = false;
        }
      }

      // Fetch all payments with pagination
      while (hasMorePayments) {
        const payments = await handleApiCall(
          () =>
            getPayment({
              client: apiClient,
              query: {
                network: 'Preprod',
                cursorId: paymentCursor || undefined,
                includeHistory: 'true',
                limit: 100,
              },
            }),
          {
            onError: (error: unknown) => {
              console.error('Failed to fetch payments:', error);
            },
            errorMessage: 'Failed to fetch payments',
          },
        );

        if (payments?.data?.data?.Payments) {
          payments.data.data.Payments.forEach((payment) => {
            allTx.push({
              ...payment,
              type: 'payment',
            } as Transaction);
          });
          hasMorePayments = payments.data.data.Payments.length === 100;
          paymentCursor =
            payments.data.data.Payments[payments.data.data.Payments.length - 1]
              ?.id;
        } else {
          hasMorePayments = false;
        }
      }

      setAllTransactions(allTx);
    } catch (error) {
      console.error('Error fetching transactions:', error);
    } finally {
      setIsLoading(false);
    }
  }, [apiClient]);
  // Calculate filtered transactions for display
  const getFilteredTransactions = useCallback(() => {
    let startDate: Date;
    let endDate: Date = new Date();

    if (selectedPreset === 'custom') {
      if (!customStartDate || !customEndDate) {
        return [];
      }
      startDate = new Date(customStartDate);
      endDate = new Date(customEndDate);
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
  useEffect(() => {
    if (open) {
      fetchAllTransactions();
    }
  }, [open, fetchAllTransactions]);
  useEffect(() => {
    if (open) {
      setFilteredTransactions(getFilteredTransactions());
    }
  }, [open, allTransactions, selectedPreset, customStartDate, customEndDate, getFilteredTransactions]);

  const handleDownload = () => {
    let startDate: Date;
    let endDate: Date = new Date();

    if (selectedPreset === 'custom') {
      if (!customStartDate || !customEndDate) {
        return; // Don't download if custom dates are not set
      }
      startDate = new Date(customStartDate);
      endDate = new Date(customEndDate);
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
              onValueChange={(value) =>
                setSelectedPreset(value as PresetOption)
              }
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
                  (payments:{' '}
                  {
                    filteredTransactions.filter((t) => t.type === 'payment')
                      .length
                  }
                  , purchases:{' '}
                  {
                    filteredTransactions.filter((t) => t.type === 'purchase')
                      .length
                  }
                  )
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
                  : PRESET_OPTIONS.find((opt) => opt.value === selectedPreset)
                    ?.label}
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
                  isLoading ||
                  (selectedPreset === 'custom' &&
                    (!customStartDate || !customEndDate))
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
