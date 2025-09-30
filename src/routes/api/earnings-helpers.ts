import createHttpError from 'http-errors';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';
import { logger } from '@/utils/logger';

export function parseDateRange(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
): { periodStart: Date; periodEnd: Date } {
  const now = new Date();
  const periodStart = startDate ? new Date(startDate) : new Date('2020-01-01');
  const periodEnd = endDate ? new Date(endDate) : now;

  if (isNaN(periodStart.getTime()) || isNaN(periodEnd.getTime())) {
    throw createHttpError(400, 'Invalid date format. Use YYYY-MM-DD format.');
  }

  if (periodStart > periodEnd) {
    throw createHttpError(400, 'Start date must be before end date.');
  }

  const oneYearInMs = 365 * 24 * 60 * 60 * 1000;
  if (periodEnd.getTime() - periodStart.getTime() > oneYearInMs) {
    throw createHttpError(
      400,
      'Date range exceeds maximum allowed period of 1 year. Please narrow your date range.',
    );
  }

  return { periodStart, periodEnd };
}

export function filterByAgentIdentifier<
  T extends { blockchainIdentifier: string },
>(transactions: T[], agentIdentifier: string): T[] {
  const filtered: T[] = [];

  for (const transaction of transactions) {
    if (transaction.blockchainIdentifier === agentIdentifier) {
      filtered.push(transaction);
      continue;
    }

    try {
      const decoded = decodeBlockchainIdentifier(
        transaction.blockchainIdentifier,
      );
      if (decoded && decoded.agentIdentifier === agentIdentifier) {
        filtered.push(transaction);
      }
    } catch (error) {
      logger.warn('Failed to decode blockchain identifier', {
        blockchainIdentifier: transaction.blockchainIdentifier,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return filtered;
}

export type TransactionWithFunds = {
  onChainState: string;
  PaidFunds?: Array<{ unit: string; amount: bigint }>;
  RequestedFunds?: Array<{ unit: string; amount: bigint }>;
  WithdrawnForSeller: Array<{ unit: string; amount: bigint }>;
  PaymentSource: { feeRatePermille: number };
};

export function aggregateEarnings(
  transactions: TransactionWithFunds[],
  usePaidFunds: boolean,
): {
  earningsMap: Map<string, bigint>;
  revenueMap: Map<string, bigint>;
  feesMap: Map<string, bigint>;
} {
  const earningsMap = new Map<string, bigint>();
  const revenueMap = new Map<string, bigint>();
  const feesMap = new Map<string, bigint>();

  transactions.forEach((transaction) => {
    const fundsSource = usePaidFunds
      ? transaction.PaidFunds
      : transaction.RequestedFunds;
    const funds = fundsSource || [];

    funds.forEach((fund) => {
      const unit = fund.unit || '';
      revenueMap.set(unit, (revenueMap.get(unit) || BigInt(0)) + fund.amount);
    });

    transaction.WithdrawnForSeller.forEach((withdrawn) => {
      const unit = withdrawn.unit || '';
      earningsMap.set(
        unit,
        (earningsMap.get(unit) || BigInt(0)) + withdrawn.amount,
      );
    });

    if (
      transaction.onChainState === 'Withdrawn' &&
      transaction.WithdrawnForSeller.length === 0
    ) {
      funds.forEach((fund) => {
        const unit = fund.unit || '';
        const feeRate = BigInt(transaction.PaymentSource.feeRatePermille);
        const estimatedEarnings = (fund.amount * (1000n - feeRate)) / 1000n;
        earningsMap.set(
          unit,
          (earningsMap.get(unit) || BigInt(0)) + estimatedEarnings,
        );
      });
    }
  });

  revenueMap.forEach((revenue, unit) => {
    const earnings = earningsMap.get(unit) || BigInt(0);
    const fee = revenue - earnings;
    if (fee > 0) {
      feesMap.set(unit, fee);
    }
  });

  return { earningsMap, revenueMap, feesMap };
}
