/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useCallback } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { getPayment, getPurchase } from '@/lib/api/generated';
import { Spinner } from '@/components/ui/spinner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, Calendar } from 'lucide-react';

interface AgentEarningsData {
  totalEarnings: number;
  totalFees: number;
  transactionCount: number;
  averageEarningPerTransaction: number;
  periodEarnings: number;
  periodFees: number;
  periodTransactions: number;
}

interface AgentEarningsOverviewProps {
  agentIdentifier: string;
  agentName: string;
}

type Transaction = (any & { type: 'payment' }) | (any & { type: 'purchase' });

type TimePeriod = '1d' | '7d' | '30d' | 'all';

export function AgentEarningsOverview({
  agentIdentifier,
  agentName,
}: AgentEarningsOverviewProps) {
  const { apiClient, state, selectedPaymentSourceId } = useAppContext();
  const [earningsData, setEarningsData] = useState<AgentEarningsData | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState<TimePeriod>('30d');

  // Calculate fee amount based on transaction amount and selected payment source fee rate
  const calculateFeeAmount = useCallback(
    (transaction: Transaction): number => {
      const selectedPaymentSource = state.paymentSources.find(
        (ps) => ps.id === selectedPaymentSourceId,
      );

      const feeRatePermille = selectedPaymentSource?.feeRatePermille;
      if (!feeRatePermille) {
        return 0; // No fee applied
      }

      const feeRate = feeRatePermille / 1000; // Convert permille to decimal

      let amount = 0;

      if (transaction.type === 'payment' && transaction.RequestedFunds?.[0]) {
        amount = parseInt(transaction.RequestedFunds[0].amount) / 1000000;
      } else if (
        transaction.type === 'purchase' &&
        transaction.PaidFunds?.[0]
      ) {
        amount = parseInt(transaction.PaidFunds[0].amount) / 1000000;
      }

      return amount * feeRate;
    },
    [state.paymentSources, selectedPaymentSourceId],
  );

  const fetchAgentEarnings = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const selectedPaymentSource = state.paymentSources.find(
        (ps) => ps.id === selectedPaymentSourceId,
      );
      const smartContractAddress = selectedPaymentSource?.smartContractAddress;

      // Calculate date based on selected period
      const periodStartDate =
        selectedPeriod === 'all'
          ? new Date(0) // Start from epoch for all time
          : (() => {
              const periodDays =
                selectedPeriod === '1d' ? 1 : selectedPeriod === '7d' ? 7 : 30;
              const date = new Date();
              date.setDate(date.getDate() - periodDays);
              return date;
            })();

      // Fetch all payments for this agent
      const paymentsResponse = await getPayment({
        client: apiClient,
        query: {
          network: state.network,
          includeHistory: 'true',
          limit: 100, // Get more transactions for better accuracy
          filterSmartContractAddress: smartContractAddress || undefined,
        },
      });

      // Fetch all purchases for this agent
      const purchasesResponse = await getPurchase({
        client: apiClient,
        query: {
          network: state.network,
          includeHistory: 'true',
          limit: 100, // Get more transactions for better accuracy
          filterSmartContractAddress: smartContractAddress || undefined,
        },
      });

      // Filter transactions by agent identifier and last 30 days
      const allTransactions: Transaction[] = [];

      if (paymentsResponse.data?.data?.Payments) {
        paymentsResponse.data.data.Payments.forEach((payment: any) => {
          if (payment.agentIdentifier === agentIdentifier) {
            allTransactions.push({ ...payment, type: 'payment' });
          }
        });
      }

      if (purchasesResponse.data?.data?.Purchases) {
        purchasesResponse.data.data.Purchases.forEach((purchase: any) => {
          if (purchase.agentIdentifier === agentIdentifier) {
            allTransactions.push({ ...purchase, type: 'purchase' });
          }
        });
      }

      // Filter for selected period
      const periodTransactions = allTransactions.filter((transaction) => {
        const transactionDate = new Date(transaction.createdAt);
        return transactionDate >= periodStartDate;
      });

      // Calculate earnings and fees
      let totalEarnings = 0;
      let totalFees = 0;
      let periodEarnings = 0;
      let periodFees = 0;

      // Process all transactions
      allTransactions.forEach((transaction) => {
        let amount = 0;
        if (transaction.type === 'payment' && transaction.RequestedFunds?.[0]) {
          amount = parseInt(transaction.RequestedFunds[0].amount) / 1000000;
        } else if (
          transaction.type === 'purchase' &&
          transaction.PaidFunds?.[0]
        ) {
          amount = parseInt(transaction.PaidFunds[0].amount) / 1000000;
        }

        const fee = calculateFeeAmount(transaction);
        totalEarnings += amount;
        totalFees += fee;

        // Check if transaction is in selected period
        const transactionDate = new Date(transaction.createdAt);
        if (transactionDate >= periodStartDate) {
          periodEarnings += amount;
          periodFees += fee;
        }
      });

      const averageEarningPerTransaction =
        allTransactions.length > 0 ? totalEarnings / allTransactions.length : 0;

      setEarningsData({
        totalEarnings,
        totalFees,
        transactionCount: allTransactions.length,
        averageEarningPerTransaction,
        periodEarnings,
        periodFees,
        periodTransactions: periodTransactions.length,
      });
    } catch (err) {
      console.error('Error fetching agent earnings:', err);
      setError('Failed to load earnings data');
    } finally {
      setIsLoading(false);
    }
  }, [
    agentIdentifier,
    apiClient,
    state.network,
    state.paymentSources,
    selectedPaymentSourceId,
    calculateFeeAmount,
    selectedPeriod,
  ]);

  useEffect(() => {
    if (agentIdentifier) {
      fetchAgentEarnings();
    }
  }, [agentIdentifier, fetchAgentEarnings]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Spinner size={24} />
        <span className="ml-2">Loading earnings data...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 text-center">
        <p className="text-destructive">{error}</p>
        <button
          onClick={fetchAgentEarnings}
          className="mt-2 text-sm text-primary hover:underline"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!earningsData) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        No earnings data available
      </div>
    );
  }

  const getPeriodLabel = (period: TimePeriod) => {
    switch (period) {
      case '1d':
        return 'Last 24 Hours';
      case '7d':
        return 'Last 7 Days';
      case '30d':
        return 'Last 30 Days';
      case 'all':
        return 'All Time';
      default:
        return 'Last 30 Days';
    }
  };

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h3 className="text-lg font-semibold">Earnings Overview</h3>
        <p className="text-sm text-muted-foreground">{agentName}</p>
      </div>

      {/* Period Selector */}
      <div className="flex justify-center">
        <div className="flex bg-muted rounded-lg p-1">
          {(['1d', '7d', '30d', 'all'] as TimePeriod[]).map((period) => (
            <button
              key={period}
              onClick={() => setSelectedPeriod(period)}
              className={`px-3 py-1 text-sm rounded-md transition-colors ${
                selectedPeriod === period
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {getPeriodLabel(period)}
            </button>
          ))}
        </div>
      </div>

      {/* Selected Period Summary */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Calendar className="h-5 w-5" />
            {getPeriodLabel(selectedPeriod)}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="text-center">
              <div className="text-2xl font-bold text-green-600">
                {selectedPeriod === 'all'
                  ? earningsData.totalEarnings.toFixed(2)
                  : earningsData.periodEarnings.toFixed(2)}{' '}
                ₳
              </div>
              <div className="text-sm text-muted-foreground">
                Total Earnings
              </div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-blue-600">
                {selectedPeriod === 'all'
                  ? earningsData.totalFees.toFixed(2)
                  : earningsData.periodFees.toFixed(2)}{' '}
                ₳
              </div>
              <div className="text-sm text-muted-foreground">Total Fees</div>
            </div>
          </div>
          <div className="text-center">
            <Badge variant="secondary">
              {selectedPeriod === 'all'
                ? earningsData.transactionCount
                : earningsData.periodTransactions}{' '}
              transactions
            </Badge>
          </div>
          {selectedPeriod === 'all' && (
            <div className="text-center">
              <div className="text-sm text-muted-foreground">
                Avg: {earningsData.averageEarningPerTransaction.toFixed(2)} ₳
                per transaction
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Fee Rate Info */}
      <div className="text-center text-sm text-muted-foreground">
        {(() => {
          const selectedPaymentSource = state.paymentSources.find(
            (ps) => ps.id === selectedPaymentSourceId,
          );
          const feeRate = selectedPaymentSource?.feeRatePermille ?? 50;
          return (
            <p>
              Fee rate: {(feeRate / 10).toFixed(1)}%
              {selectedPaymentSource
                ? ` (${selectedPaymentSource.network})`
                : ' (default)'}
            </p>
          );
        })()}
      </div>
    </div>
  );
}
