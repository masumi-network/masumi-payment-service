import { $Enums, Network, OnChainState } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/utils/db';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import {
  parseDateRange,
  filterByAgentIdentifier,
} from '@/utils/earnings-helpers';
import { recordBusinessEndpointError } from '@/utils/metrics';
import { ez } from 'express-zod-api';
import spacetime from 'spacetime';

type PaymentFunds = {
  units: Map<string, number>;
  blockchainFees: number;
};

function addToPaymentFundsMap(
  paymentFunds: PaymentFunds,
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

function addToPaymentFundsMapArray(
  paymentFunds: PaymentFunds,
  units: Array<{ unit: string; amount: bigint }>,
  blockchainFees: bigint,
): void {
  for (const unit of units) {
    addToPaymentFundsMap(paymentFunds, unit.unit, unit.amount);
  }
  paymentFunds.blockchainFees += Number(blockchainFees);
}

function addToPaymentFundsMapArrayMap(
  map: Map<string, PaymentFunds>,
  key: string,
  units: Array<{ unit: string; amount: bigint }>,
  blockchainFees: bigint,
): void {
  if (!map.has(key)) {
    map.set(key, { units: new Map<string, number>(), blockchainFees: 0 });
  }
  addToPaymentFundsMapArray(map.get(key)!, units, blockchainFees);
}

export const getPaymentIncomeSchemaInput = z.object({
  agentIdentifier: z
    .string()
    .min(57)
    .max(250)
    .describe(
      'The unique identifier of the agent to get payment income for, if not provided, will return income for all agents',
    )
    .nullable(),
  startDate: ez
    .dateIn()
    .optional()
    .nullable()
    .describe(
      'Start date for income calculation (date format: 2024-01-01). If null, uses earliest available data. If provided, will be converted to the local time zone of the user',
    ),
  endDate: ez
    .dateIn()
    .optional()
    .nullable()
    .describe(
      'End date for income calculation (date format: 2024-01-31). If null, uses current date. If provided, will be converted to the local time zone of the user',
    ),
  timeZone: z
    .string()
    .optional()
    .default('Etc/UTC')
    .describe(
      'The time zone to use for the income calculation. If not provided, will use the UTC time zone. Must be a valid IANA time zone name, see https://en.wikipedia.org/wiki/List_of_tz_database_time_zones',
    ),
  network: z
    .nativeEnum(Network)
    .describe('The Cardano network to query income from'),
});

const unitAmountSchema = z.object({
  unit: z.string(),
  amount: z.number(),
});

export const getPaymentIncomeSchemaOutput = z.object({
  agentIdentifier: z.string().nullable(),
  periodStart: z.date(),
  periodEnd: z.date(),
  totalTransactions: z.number(),
  totalIncome: z.object({
    units: z.array(unitAmountSchema),
    blockchainFees: z.number(),
  }),
  totalRefunded: z.object({
    units: z.array(unitAmountSchema),
    blockchainFees: z.number(),
  }),
  totalPending: z.object({
    units: z.array(unitAmountSchema),
    blockchainFees: z.number(),
  }),
  dailyIncome: z.array(
    z.object({
      date: z.string().describe('The date in the format YYYY-MM-DD'),
      units: z.array(unitAmountSchema),
      blockchainFees: z.number(),
    }),
  ),
  dailyRefunded: z.array(
    z.object({
      date: z.string().describe('The date in the format YYYY-MM-DD'),
      units: z.array(unitAmountSchema),
      blockchainFees: z.number(),
    }),
  ),
  dailyPending: z.array(
    z.object({
      date: z.string().describe('The date in the format YYYY-MM-DD'),
      units: z.array(unitAmountSchema),
      blockchainFees: z.number(),
    }),
  ),
  monthlyIncome: z.array(
    z.object({
      date: z.string().describe('The date in the format YYYY-MM'),
      units: z.array(unitAmountSchema),
      blockchainFees: z.number(),
    }),
  ),
  monthlyRefunded: z.array(
    z.object({
      date: z.string().describe('The date in the format YYYY-MM'),
      units: z.array(unitAmountSchema),
      blockchainFees: z.number(),
    }),
  ),
  monthlyPending: z.array(
    z.object({
      date: z.string().describe('The date in the format YYYY-MM'),
      units: z.array(unitAmountSchema),
      blockchainFees: z.number(),
    }),
  ),
});

function getDayNumberLocal(date: Date, timeZone: string): string {
  const sp = spacetime.fromUnixSeconds(date.getTime() / 1000).goto(timeZone);
  return sp.format('{YYYY}-{MM}-{DD}');
}

function getMonthNumberLocal(date: Date, timeZone: string): string {
  const sp = spacetime.fromUnixSeconds(date.getTime() / 1000).goto(timeZone);
  return sp.format('{YYYY}-{MM}');
}

export const getPaymentIncome = readAuthenticatedEndpointFactory.build({
  method: 'get',
  input: getPaymentIncomeSchemaInput,
  output: getPaymentIncomeSchemaOutput,
  handler: async ({
    input,
    options,
  }: {
    input: z.infer<typeof getPaymentIncomeSchemaInput>;
    options: {
      id: string;
      permission: $Enums.Permission;
      networkLimit: $Enums.Network[];
      usageLimited: boolean;
    };
  }) => {
    const startTime = Date.now();
    try {
      await checkIsAllowedNetworkOrThrowUnauthorized(
        options.networkLimit,
        input.network,
        options.permission,
      );

      const { periodStart, periodEnd } = parseDateRange(
        input.startDate,
        input.endDate,
      );

      const allPayments = await prisma.paymentRequest.findMany({
        where: {
          payByTime: {
            gte: periodStart.getTime(),
            lte: periodEnd.getTime(),
          },
          onChainState: { not: null },
          PaymentSource: {
            network: input.network,
            deletedAt: null,
          },
        },
        orderBy: [
          {
            payByTime: 'asc',
          },
          {
            id: 'asc',
          },
        ],
        include: {
          RequestedFunds: true,
          WithdrawnForBuyer: true,
          WithdrawnForSeller: true,
          PaymentSource: true,
        },
      });

      const allPaymentsFiltered = filterByAgentIdentifier(
        allPayments,
        input.agentIdentifier,
      );

      const totalRefundedMap = {
        units: new Map<string, number>(),
        blockchainFees: 0,
      };
      const totalIncomeMap: PaymentFunds = {
        units: new Map<string, number>(),
        blockchainFees: 0,
      };
      const totalPendingMap = {
        units: new Map<string, number>(),
        blockchainFees: 0,
      };

      const dayRefundedMap = new Map<string, PaymentFunds>();
      const dayIncomeMap = new Map<string, PaymentFunds>();
      const dayPendingMap = new Map<string, PaymentFunds>();

      const monthlyRefundedMap = new Map<string, PaymentFunds>();
      const monthlyIncomeMap = new Map<string, PaymentFunds>();
      const monthlyPendingMap = new Map<string, PaymentFunds>();

      for (const payment of allPaymentsFiltered) {
        //get the day number in the local time zone of the user
        const dayDateLocal = getDayNumberLocal(
          new Date(Number(payment.payByTime)),
          input.timeZone ?? 'Etc/UTC',
        );
        const monthDateLocal = getMonthNumberLocal(
          new Date(Number(payment.payByTime)),
          input.timeZone ?? 'Etc/UTC',
        );

        if (payment.onChainState === OnChainState.Withdrawn) {
          addToPaymentFundsMapArray(
            totalIncomeMap,
            payment.RequestedFunds,
            payment.totalSellerCardanoFees,
          );
          addToPaymentFundsMapArrayMap(
            dayIncomeMap,
            dayDateLocal,
            payment.RequestedFunds,
            payment.totalSellerCardanoFees,
          );
          addToPaymentFundsMapArrayMap(
            monthlyIncomeMap,
            monthDateLocal,
            payment.RequestedFunds,
            payment.totalSellerCardanoFees,
          );
        } else if (payment.onChainState === OnChainState.RefundWithdrawn) {
          addToPaymentFundsMapArray(
            totalRefundedMap,
            payment.RequestedFunds,
            payment.totalSellerCardanoFees,
          );
          addToPaymentFundsMapArrayMap(
            dayRefundedMap,
            dayDateLocal,
            payment.RequestedFunds,
            payment.totalSellerCardanoFees,
          );
          addToPaymentFundsMapArrayMap(
            monthlyRefundedMap,
            monthDateLocal,
            payment.RequestedFunds,
            payment.totalSellerCardanoFees,
          );
        } else if (payment.onChainState === OnChainState.DisputedWithdrawn) {
          if (payment.WithdrawnForBuyer.length > 0) {
            addToPaymentFundsMapArray(
              totalRefundedMap,
              payment.WithdrawnForBuyer,
              payment.totalSellerCardanoFees,
            );
            addToPaymentFundsMapArrayMap(
              dayRefundedMap,
              dayDateLocal,
              payment.WithdrawnForBuyer,
              payment.totalSellerCardanoFees,
            );
            addToPaymentFundsMapArrayMap(
              monthlyRefundedMap,
              monthDateLocal,
              payment.WithdrawnForBuyer,
              payment.totalSellerCardanoFees,
            );
          }
          if (payment.WithdrawnForSeller.length > 0) {
            addToPaymentFundsMapArray(
              totalIncomeMap,
              payment.WithdrawnForSeller,
              payment.totalSellerCardanoFees,
            );
          }
          addToPaymentFundsMapArrayMap(
            dayIncomeMap,
            dayDateLocal,
            payment.WithdrawnForSeller,
            payment.totalSellerCardanoFees,
          );
          addToPaymentFundsMapArrayMap(
            monthlyIncomeMap,
            monthDateLocal,
            payment.WithdrawnForSeller,
            payment.totalSellerCardanoFees,
          );
        } else if (payment.onChainState !== OnChainState.FundsOrDatumInvalid) {
          addToPaymentFundsMapArray(
            totalPendingMap,
            payment.RequestedFunds,
            payment.totalSellerCardanoFees,
          );
          addToPaymentFundsMapArrayMap(
            dayPendingMap,
            dayDateLocal,
            payment.RequestedFunds,
            payment.totalSellerCardanoFees,
          );
          addToPaymentFundsMapArrayMap(
            monthlyPendingMap,
            monthDateLocal,
            payment.RequestedFunds,
            payment.totalSellerCardanoFees,
          );
        }
      }

      return {
        agentIdentifier: input.agentIdentifier,
        periodStart,
        periodEnd,
        totalTransactions: allPaymentsFiltered.length,
        totalIncome: {
          units: Array.from(totalIncomeMap.units.entries()).map(
            ([key, value]) => ({
              unit: key,
              amount: value,
            }),
          ),
          blockchainFees: totalIncomeMap.blockchainFees,
        },
        totalRefunded: {
          units: Array.from(totalRefundedMap.units.entries()).map(
            ([key, value]) => ({
              unit: key,
              amount: value,
            }),
          ),
          blockchainFees: totalRefundedMap.blockchainFees,
        },
        totalPending: {
          units: Array.from(totalPendingMap.units.entries()).map(
            ([key, value]) => ({
              unit: key,
              amount: value,
            }),
          ),
          blockchainFees: totalPendingMap.blockchainFees,
        },
        dailyIncome: Array.from(dayIncomeMap.entries()).map(([key, value]) => ({
          date: key,
          units: Array.from(value.units.entries()).map(([key, value]) => ({
            unit: key,
            amount: value,
          })),
          blockchainFees: value.blockchainFees,
        })),
        dailyRefunded: Array.from(dayRefundedMap.entries()).map(
          ([key, value]) => ({
            date: key,
            units: Array.from(value.units.entries()).map(([key, value]) => ({
              unit: key,
              amount: value,
            })),
            blockchainFees: value.blockchainFees,
          }),
        ),
        dailyPending: Array.from(dayPendingMap.entries()).map(
          ([key, value]) => ({
            date: key,
            units: Array.from(value.units.entries()).map(([key, value]) => ({
              unit: key,
              amount: value,
            })),
            blockchainFees: value.blockchainFees,
          }),
        ),
        monthlyIncome: Array.from(monthlyIncomeMap.entries()).map(
          ([key, value]) => ({
            date: key,
            units: Array.from(value.units.entries()).map(([key, value]) => ({
              unit: key,
              amount: value,
            })),
            blockchainFees: value.blockchainFees,
          }),
        ),
        monthlyRefunded: Array.from(monthlyRefundedMap.entries()).map(
          ([key, value]) => ({
            date: key,
            units: Array.from(value.units.entries()).map(([key, value]) => ({
              unit: key,
              amount: value,
            })),
            blockchainFees: value.blockchainFees,
          }),
        ),
        monthlyPending: Array.from(monthlyPendingMap.entries()).map(
          ([key, value]) => ({
            date: key,
            units: Array.from(value.units.entries()).map(([key, value]) => ({
              unit: key,
              amount: value,
            })),
            blockchainFees: value.blockchainFees,
          }),
        ),
      };
    } catch (error: unknown) {
      const errorInstance =
        error instanceof Error ? error : new Error(String(error));
      const statusCode =
        (errorInstance as { statusCode?: number; status?: number })
          .statusCode ||
        (errorInstance as { statusCode?: number; status?: number }).status ||
        500;

      recordBusinessEndpointError(
        '/api/v1/payment/income',
        'GET',
        statusCode,
        errorInstance,
        {
          agent_identifier: input.agentIdentifier ?? 'all',
          start_date: input.startDate?.toISOString() || 'null',
          end_date: input.endDate?.toISOString() || 'null',
          network: input.network,
          user_id: options.id,
          duration: Date.now() - startTime,
        },
      );

      throw error;
    }
  },
});
