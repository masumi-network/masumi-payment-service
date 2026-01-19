import { useState, useEffect, useCallback } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import {
  getPayment,
  Payment,
  PaymentSourceExtended,
} from '@/lib/api/generated';
import { Spinner } from '@/components/ui/spinner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Calendar } from 'lucide-react';
import formatBalance from '@/lib/formatBalance';
import { getUsdmConfig } from '@/lib/constants/defaultWallets';
import { usePaymentSourceExtendedAll } from '@/lib/hooks/usePaymentSourceExtendedAll';

interface AgentEarningsData {
  totalPayments: number;
  totalEarnings: Map<string, number>;
}

interface AgentEarningsOverviewProps {
  agentIdentifier: string;
  agentName: string;
}

type TimePeriod = '1d' | '7d' | '30d' | 'all';

export function AgentEarningsOverview({
  agentIdentifier,
  agentName,
}: AgentEarningsOverviewProps) {
  const { apiClient, selectedPaymentSourceId, network } = useAppContext();
  const [earningsData, setEarningsData] = useState<AgentEarningsData | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState<TimePeriod>('30d');

  const { paymentSources } = usePaymentSourceExtendedAll();

  const [currentNetworkPaymentSources, setCurrentNetworkPaymentSources] =
    useState<PaymentSourceExtended[]>([]);
  useEffect(() => {
    setCurrentNetworkPaymentSources(
      paymentSources.filter((ps) => ps.network === network),
    );
  }, [paymentSources, network]);
  const fetchAgentEarnings = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const selectedPaymentSource = currentNetworkPaymentSources.find(
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

      // Filter transactions by agent identifier and last 30 days
      const allPayments: Payment[] = [];
      let morePages = true;
      while (morePages) {
        // Fetch all payments for this agent
        const paymentsResponse = await getPayment({
          client: apiClient,
          query: {
            network: network,
            includeHistory: 'true',
            limit: 100, // Get more transactions for better accuracy
            filterSmartContractAddress: smartContractAddress || undefined,
          },
        });

        if (
          paymentsResponse.data?.data == undefined ||
          paymentsResponse.data?.data?.Payments.length < 100
        ) {
          morePages = false;
        }

        if (paymentsResponse.data?.data?.Payments) {
          paymentsResponse.data.data.Payments.filter(
            (payment) =>
              payment.agentIdentifier === agentIdentifier &&
              new Date(parseInt(payment.unlockTime || '0')) >=
              periodStartDate &&
              new Date(parseInt(payment.unlockTime || '0')) <= new Date() &&
              (payment.onChainState === 'Withdrawn' ||
                payment.onChainState === 'ResultSubmitted' ||
                payment.onChainState === 'DisputedWithdrawn'),
          ).forEach((payment) => {
            allPayments.push(payment);
          });
        }
      }

      // Calculate earnings and fees
      const totalEarnings = new Map<string, number>();

      allPayments.forEach((payment) => {
        if (payment.onChainState === 'DisputedWithdrawn') {
          payment.WithdrawnForSeller.forEach((fund) => {
            totalEarnings.set(
              fund.unit,
              (totalEarnings.get(fund.unit) ?? 0) + parseInt(fund.amount),
            );
          });
          return;
        }
        payment.RequestedFunds.forEach((fund) => {
          totalEarnings.set(
            fund.unit,
            (totalEarnings.get(fund.unit) ?? 0) + parseInt(fund.amount),
          );
        });
      });

      setEarningsData({
        totalPayments: allPayments.length,
        totalEarnings,
      });
    } catch (err) {
      console.error('Error fetching agent earnings:', err);
      setError('Failed to load earnings data');
    } finally {
      setIsLoading(false);
    }
  }, [
    currentNetworkPaymentSources,
    network,
    selectedPeriod,
    selectedPaymentSourceId,
    apiClient,
    agentIdentifier,
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

  const formatTokenBalance = (token: { unit: string; quantity: number }) => {
    if (token.unit === 'lovelace' || token.unit === '') {
      const ada = token.quantity / 1000000;
      const formattedAmount = ada === 0 ? '0' : formatBalance(ada.toFixed(2));
      return formattedAmount + ' ₳';
    }

    // For USDM, match by policyId and assetName (hex) - network aware
    const usdmConfig = getUsdmConfig(network);
    const isUSDM = token.unit === usdmConfig.fullAssetId;
    if (isUSDM) {
      const usdm = token.quantity / 1000000;
      const formattedAmount = usdm === 0 ? '0' : formatBalance(usdm.toFixed(2));
      return formattedAmount + ' USDM';
    }

    const amount = token.quantity;
    const formattedAmount =
      amount === 0 ? '0' : formatBalance(amount.toFixed(0));
    return formattedAmount + ' ' + token.unit;
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
              className={`px-3 py-1 text-sm rounded-md transition-colors ${selectedPeriod === period
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
            <div className="flex flex-col gap-2">
              {Array.from(earningsData.totalEarnings.entries()).map(
                ([key, value]) => (
                  <div key={key} className="text-sm text-muted-foreground">
                    {formatTokenBalance({ unit: key, quantity: value })}
                  </div>
                ),
              )}
              {earningsData.totalPayments === 0 && (
                <div className="text-sm text-muted-foreground">
                  No earnings data available in the selected period
                </div>
              )}
            </div>
          </div>
          <div className="text-center">
            <Badge variant="secondary">
              {earningsData.totalPayments} transactions
            </Badge>
          </div>
        </CardContent>
      </Card>

      {/* Fee Rate Info */}
      <div className="text-center text-sm text-muted-foreground">
        {(() => {
          const selectedPaymentSource = currentNetworkPaymentSources.find(
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
