import createHttpError from 'http-errors';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';
import { logger } from '@/utils/logger';

export function mapUnitAmountToResponse(
  unit: string,
  amount: bigint,
): { unit: string; amount: string } {
  return {
    unit: unit === '' ? 'lovelace' : unit,
    amount: amount.toString(),
  };
}

export function parseDateRange(
  startDate: Date | null | undefined,
  endDate: Date | null | undefined,
): { periodStart: Date; periodEnd: Date } {
  const now = new Date();
  const periodStart = startDate ? startDate : new Date('2020-01-01');
  const periodEnd = endDate ? endDate : now;

  if (isNaN(periodStart.getTime()) || isNaN(periodEnd.getTime())) {
    throw createHttpError(400, 'Invalid date format. Use YYYY-MM-DD format.');
  }

  if (periodStart > periodEnd) {
    throw createHttpError(400, 'Start date must be before end date.');
  }

  return { periodStart, periodEnd };
}

export function filterByAgentIdentifier<
  T extends { blockchainIdentifier: string },
>(transactions: T[], agentIdentifier: string | null): T[] {
  if (!agentIdentifier) {
    return transactions;
  }
  const filtered: T[] = [];
  for (const transaction of transactions) {
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

function _aggregateEarningsInternal(
  transactions: TransactionWithFunds[],
  getFundsArray: (
    tx: TransactionWithFunds,
  ) => Array<{ unit: string; amount: bigint }>,
): {
  earningsMap: Map<string, bigint>;
  revenueMap: Map<string, bigint>;
  feesMap: Map<string, bigint>;
} {
  const earningsMap = new Map<string, bigint>();
  const revenueMap = new Map<string, bigint>();
  const feesMap = new Map<string, bigint>();

  transactions.forEach((transaction) => {
    const funds = getFundsArray(transaction);

    funds.forEach((fund) => {
      if (fund.unit === undefined || fund.unit === null) {
        throw createHttpError(
          500,
          `Invalid fund data: unit is ${fund.unit === undefined ? 'undefined' : 'null'}. All funds must have a unit specified (empty string '' for lovelace).`,
        );
      }
      const unit = fund.unit;
      revenueMap.set(unit, (revenueMap.get(unit) || BigInt(0)) + fund.amount);
    });

    if (transaction.WithdrawnForSeller.length > 0) {
      transaction.WithdrawnForSeller.forEach((withdrawn) => {
        if (withdrawn.unit === undefined || withdrawn.unit === null) {
          throw createHttpError(
            500,
            `Invalid withdrawal data: unit is ${withdrawn.unit === undefined ? 'undefined' : 'null'}. All withdrawals must have a unit specified (empty string '' for lovelace).`,
          );
        }
        const unit = withdrawn.unit;
        earningsMap.set(
          unit,
          (earningsMap.get(unit) || BigInt(0)) + withdrawn.amount,
        );
      });
    } else if (transaction.onChainState === 'Withdrawn') {
      funds.forEach((fund) => {
        if (fund.unit === undefined || fund.unit === null) {
          throw createHttpError(
            500,
            `Invalid fund data: unit is ${fund.unit === undefined ? 'undefined' : 'null'}. All funds must have a unit specified (empty string '' for lovelace).`,
          );
        }
        const unit = fund.unit;
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

export function aggregatePaymentEarnings(
  transactions: TransactionWithFunds[],
): {
  earningsMap: Map<string, bigint>;
  revenueMap: Map<string, bigint>;
  feesMap: Map<string, bigint>;
} {
  return _aggregateEarningsInternal(
    transactions,
    (tx) => tx.RequestedFunds || [],
  );
}

export function aggregatePurchaseEarnings(
  transactions: TransactionWithFunds[],
): {
  earningsMap: Map<string, bigint>;
  revenueMap: Map<string, bigint>;
  feesMap: Map<string, bigint>;
} {
  return _aggregateEarningsInternal(transactions, (tx) => tx.PaidFunds || []);
}

export function aggregateEarnings(
  transactions: TransactionWithFunds[],
  usePaidFunds: boolean,
): {
  earningsMap: Map<string, bigint>;
  revenueMap: Map<string, bigint>;
  feesMap: Map<string, bigint>;
} {
  return usePaidFunds
    ? aggregatePurchaseEarnings(transactions)
    : aggregatePaymentEarnings(transactions);
}
