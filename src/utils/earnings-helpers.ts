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

export type Fund = {
  units: Map<string, number>;
  blockchainFees: number;
};

export function addToFundsMap(
  paymentFunds: Fund,
  unit: string,
  amount: bigint,
): void {
  if (paymentFunds.units.has(unit)) {
    paymentFunds.units.set(
      unit,
      paymentFunds.units.get(unit)! + Number(amount),
    );
  } else {
    paymentFunds.units.set(unit, Number(amount));
  }
}

export function addToFundsMapArray(
  paymentFunds: Fund,
  units: Array<{ unit: string; amount: bigint }>,
  blockchainFees: bigint,
): void {
  for (const unit of units) {
    addToFundsMap(paymentFunds, unit.unit, unit.amount);
  }
  paymentFunds.blockchainFees += Number(blockchainFees);
}

export function addToFundsMapArrayMap(
  map: Map<string, Fund>,
  key: string,
  units: Array<{ unit: string; amount: bigint }>,
  blockchainFees: bigint,
): void {
  if (!map.has(key)) {
    map.set(key, { units: new Map<string, number>(), blockchainFees: 0 });
  }
  addToFundsMapArray(map.get(key)!, units, blockchainFees);
}

export function addToAllFundsMaps(
  totalFunds: Fund,
  dayMap: Map<string, Fund>,
  monthMap: Map<string, Fund>,
  dayKey: string,
  monthKey: string,
  units: Array<{ unit: string; amount: bigint }>,
  blockchainFees: bigint,
): void {
  addToFundsMapArray(totalFunds, units, blockchainFees);
  addToFundsMapArrayMap(dayMap, dayKey, units, blockchainFees);
  addToFundsMapArrayMap(monthMap, monthKey, units, blockchainFees);
}

export function mapTotalFundsOutput(funds: Fund): {
  units: Array<{ unit: string; amount: number }>;
  blockchainFees: number;
} {
  return {
    units: Array.from(funds.units.entries()).map(([unit, amount]) => ({
      unit,
      amount,
    })),
    blockchainFees: funds.blockchainFees,
  };
}
function getDayMonthAndYearFromDate(date: string): {
  day: number;
  month: number;
  year: number;
} {
  const [year, month, day] = date.split('-').map(Number);
  return { day: Number(day), month: Number(month), year: Number(year) };
}
export function mapDailyFundsOutput(fundsByDay: Map<string, Fund>): Array<{
  day: number;
  month: number;
  year: number;
  units: Array<{ unit: string; amount: number }>;
  blockchainFees: number;
}> {
  return Array.from(fundsByDay.entries()).map(([date, fund]) => ({
    ...getDayMonthAndYearFromDate(date),
    units: Array.from(fund.units.entries()).map(([unit, amount]) => ({
      unit,
      amount,
    })),
    blockchainFees: fund.blockchainFees,
  }));
}

function getMonthAndYearFromDate(date: string): {
  month: number;
  year: number;
} {
  const [year, month] = date.split('-').map(Number);
  return { month, year };
}

export function mapMonthlyFundsOutput(fundsByMonth: Map<string, Fund>): Array<{
  month: number;
  year: number;
  units: Array<{ unit: string; amount: number }>;
  blockchainFees: number;
}> {
  return Array.from(fundsByMonth.entries()).map(([date, fund]) => ({
    ...getMonthAndYearFromDate(date),
    units: Array.from(fund.units.entries()).map(([unit, amount]) => ({
      unit,
      amount,
    })),
    blockchainFees: fund.blockchainFees,
  }));
}
