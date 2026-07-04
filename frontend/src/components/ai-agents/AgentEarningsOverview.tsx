import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { getPayment, Payment } from '@/lib/api/generated';
import { Spinner } from '@/components/ui/spinner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Calendar } from 'lucide-react';
import { formatSixDecimalAmount, groupDigits } from '@/lib/utils';
import { getUsdmConfig, USDCX_CONFIG } from '@/lib/constants/defaultWallets';
import { usePaymentSourceExtendedAll } from '@/lib/hooks/usePaymentSourceExtendedAll';

interface AgentEarningsData {
  totalPayments: number;
  totalEarnings: Map<string, bigint>;
}

interface AgentEarningsOverviewProps {
  agentIdentifier: string;
  agentName: string;
}

type TimePeriod = '1d' | '7d' | '30d' | 'all';

export function AgentEarningsOverview({ agentIdentifier, agentName }: AgentEarningsOverviewProps) {
  const { apiClient, selectedPaymentSourceId, network } = useAppContext();
  const [earningsData, setEarningsData] = useState<AgentEarningsData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState<TimePeriod>('30d');

  const { paymentSources, isLoading: isPaymentSourcesLoading } = usePaymentSourceExtendedAll();

  const currentNetworkPaymentSources = useMemo(
    () => paymentSources.filter((ps) => ps.network === network),
    [paymentSources, network],
  );
  // Epoch counter prevents stale writes when the period (or payment source)
  // changes while a previous multi-page fetch is still in flight — only the
  // latest request may set state, and only it clears the loading spinner.
  const earningsFetchEpochRef = useRef(0);

  const fetchAgentEarnings = useCallback(async () => {
    const epoch = ++earningsFetchEpochRef.current;
    try {
      setIsLoading(true);
      setError(null);

      const selectedPaymentSource = currentNetworkPaymentSources.find(
        (ps) => ps.id === selectedPaymentSourceId,
      );
      const smartContractAddress = selectedPaymentSource?.smartContractAddress;

      if (!smartContractAddress) {
        setEarningsData({ totalPayments: 0, totalEarnings: new Map() });
        return;
      }

      // Calculate date based on selected period
      const periodStartDate =
        selectedPeriod === 'all'
          ? new Date(0) // Start from epoch for all time
          : (() => {
              const periodDays = selectedPeriod === '1d' ? 1 : selectedPeriod === '7d' ? 7 : 30;
              const date = new Date();
              date.setDate(date.getDate() - periodDays);
              return date;
            })();

      const allPayments: Payment[] = [];
      let cursorId: string | undefined = undefined;
      let hasMorePages = true;

      while (hasMorePages) {
        const paymentsResponse = await getPayment({
          client: apiClient,
          query: {
            network: network,
            includeHistory: 'true',
            limit: 100,
            filterSmartContractAddress: smartContractAddress,
            cursorId: cursorId,
          },
        });
        // A newer fetch superseded this one — stop paging and drop the result.
        if (earningsFetchEpochRef.current !== epoch) return;

        const payments: Payment[] = paymentsResponse.data?.data?.Payments ?? [];
        const paymentsToProcess = cursorId ? payments.slice(1) : payments;

        paymentsToProcess
          .filter(
            (payment) =>
              payment.agentIdentifier === agentIdentifier &&
              new Date(parseInt(payment.unlockTime || '0')) >= periodStartDate &&
              new Date(parseInt(payment.unlockTime || '0')) <= new Date() &&
              (payment.onChainState === 'Withdrawn' ||
                payment.onChainState === 'ResultSubmitted' ||
                payment.onChainState === 'DisputedWithdrawn'),
          )
          .forEach((payment) => allPayments.push(payment));

        if (payments.length < 100) {
          hasMorePages = false;
        } else {
          const lastId = payments[payments.length - 1].id;
          if (lastId === cursorId) {
            hasMorePages = false;
          } else {
            cursorId = lastId;
          }
        }
      }

      // Calculate earnings and fees. BigInt accumulation: fund amounts arrive
      // as strings precisely because they can exceed Number.MAX_SAFE_INTEGER,
      // where parseInt silently loses precision.
      const totalEarnings = new Map<string, bigint>();

      allPayments.forEach((payment) => {
        if (payment.onChainState === 'DisputedWithdrawn') {
          payment.WithdrawnForSeller.forEach((fund) => {
            totalEarnings.set(
              fund.unit,
              (totalEarnings.get(fund.unit) ?? BigInt(0)) + BigInt(fund.amount),
            );
          });
          return;
        }
        payment.RequestedFunds.forEach((fund) => {
          totalEarnings.set(
            fund.unit,
            (totalEarnings.get(fund.unit) ?? BigInt(0)) + BigInt(fund.amount),
          );
        });
      });

      setEarningsData({
        totalPayments: allPayments.length,
        totalEarnings,
      });
    } catch (err) {
      if (earningsFetchEpochRef.current !== epoch) return;
      console.error('Error fetching agent earnings:', err);
      setError('Failed to load earnings data');
    } finally {
      if (earningsFetchEpochRef.current === epoch) {
        setIsLoading(false);
      }
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
    if (agentIdentifier && !isPaymentSourcesLoading) {
      fetchAgentEarnings();
    }
  }, [agentIdentifier, isPaymentSourcesLoading, fetchAgentEarnings]);

  if (!agentIdentifier) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        Earnings are not available for agents that have not been registered.
      </div>
    );
  }

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
        <button onClick={fetchAgentEarnings} className="mt-2 text-sm text-primary hover:underline">
          Try again
        </button>
      </div>
    );
  }

  if (!earningsData) {
    return <div className="p-8 text-center text-muted-foreground">No earnings data available</div>;
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

  // BigInt-safe formatting (formatSixDecimalAmount truncates to 2 fraction
  // digits, matching the previous toFixed(2) display), zero shown as '0'.
  const formatTokenBalance = (token: { unit: string; quantity: bigint }) => {
    const isZero = token.quantity === BigInt(0);
    if (token.unit === 'lovelace' || token.unit === '') {
      const formattedAmount = isZero ? '0' : formatSixDecimalAmount(token.quantity);
      return formattedAmount + ' ADA';
    }

    const isUSDCx = token.unit === USDCX_CONFIG.fullAssetId;
    if (isUSDCx) {
      const formattedAmount = isZero ? '0' : formatSixDecimalAmount(token.quantity);
      return formattedAmount + ' USDCx';
    }

    // For USDM, match by fullAssetId - keep for legacy records
    const usdmConfig = getUsdmConfig(network);
    const isUSDM = token.unit === usdmConfig.fullAssetId;
    if (isUSDM) {
      const formattedAmount = isZero ? '0' : formatSixDecimalAmount(token.quantity);
      return formattedAmount + ' USDM';
    }

    // Unknown native token — decimals unknown, show grouped base units.
    const formattedAmount = isZero ? '0' : groupDigits(token.quantity.toString());
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
              className={`px-3 py-1 text-sm rounded-md transition-colors ${
                selectedPeriod === period
                  ? 'bg-background text-foreground shadow-xs'
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
              {Array.from(earningsData.totalEarnings.entries()).map(([key, value]) => (
                <div key={key} className="text-sm text-muted-foreground">
                  {formatTokenBalance({ unit: key, quantity: value })}
                </div>
              ))}
              {earningsData.totalPayments === 0 && (
                <div className="text-sm text-muted-foreground">
                  No earnings data available in the selected period
                </div>
              )}
            </div>
          </div>
          <div className="text-center">
            <Badge variant="secondary">{earningsData.totalPayments} transactions</Badge>
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
              {selectedPaymentSource ? ` (${selectedPaymentSource.network})` : ' (default)'}
            </p>
          );
        })()}
      </div>
    </div>
  );
}
