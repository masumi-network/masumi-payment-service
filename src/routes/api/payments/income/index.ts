import { Network, OnChainState } from '@/generated/prisma/client';
import { z } from 'zod';
import { prisma } from '@/utils/db';
import {
  AuthContext,
  checkIsAllowedNetworkOrThrowUnauthorized,
} from '@/utils/middleware/auth-middleware';
import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import {
  parseDateRange,
  filterByAgentIdentifier,
  Fund,
  addToAllFundsMaps,
  mapDailyFundsOutput,
  mapMonthlyFundsOutput,
  mapTotalFundsOutput,
} from '@/utils/earnings-helpers';
import { recordBusinessEndpointError } from '@/utils/metrics';
import { ez } from 'express-zod-api';
import spacetime from 'spacetime';

export const postPaymentIncomeSchemaInput = z.object({
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
  network: z.nativeEnum(Network).describe('The Cardano network to query income from'),
});

const unitAmountSchema = z
  .object({
    unit: z.string(),
    amount: z.number(),
  })
  .describe(
    'The amount of the unit in the smallest unit. Meaning if the unit is ADA, the amount is in lovelace (1 ADA = 10000000 lovelace) and its unit is ""',
  );

export const postPaymentIncomeSchemaOutput = z.object({
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
      day: z.number().describe('The day of the month'),
      month: z.number().describe('The month'),
      year: z.number().describe('The year'),
      units: z.array(unitAmountSchema),
      blockchainFees: z.number(),
    }),
  ),
  dailyRefunded: z.array(
    z.object({
      day: z.number().describe('The day of the month'),
      month: z.number().describe('The month'),
      year: z.number().describe('The year'),
      units: z.array(unitAmountSchema),
      blockchainFees: z.number(),
    }),
  ),
  dailyPending: z.array(
    z.object({
      day: z.number().describe('The day of the month'),
      month: z.number().describe('The month'),
      year: z.number().describe('The year'),
      units: z.array(unitAmountSchema),
      blockchainFees: z.number(),
    }),
  ),
  monthlyIncome: z.array(
    z.object({
      month: z.number().describe('The month'),
      year: z.number().describe('The year'),
      units: z.array(unitAmountSchema),
      blockchainFees: z.number(),
    }),
  ),
  monthlyRefunded: z.array(
    z.object({
      month: z.number().describe('The month'),
      year: z.number().describe('The year'),
      units: z.array(unitAmountSchema),
      blockchainFees: z.number(),
    }),
  ),
  monthlyPending: z.array(
    z.object({
      month: z.number().describe('The month'),
      year: z.number().describe('The year'),
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
  method: 'post',
  input: postPaymentIncomeSchemaInput,
  output: postPaymentIncomeSchemaOutput,
  handler: async ({
    input,
    ctx,
  }: {
    input: z.infer<typeof postPaymentIncomeSchemaInput>;
    ctx: AuthContext;
  }) => {
    const startTime = Date.now();
    try {
      await checkIsAllowedNetworkOrThrowUnauthorized(
        ctx.networkLimit,
        input.network,
        ctx.permission,
      );

      const { periodStart, periodEnd } = parseDateRange(input.startDate, input.endDate);

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

      const allPaymentsFiltered = filterByAgentIdentifier(allPayments, input.agentIdentifier);

      const totalRefundedMap = {
        units: new Map<string, number>(),
        blockchainFees: 0,
      };
      const totalIncomeMap: Fund = {
        units: new Map<string, number>(),
        blockchainFees: 0,
      };
      const totalPendingMap = {
        units: new Map<string, number>(),
        blockchainFees: 0,
      };

      const dayRefundedMap = new Map<string, Fund>();
      const dayIncomeMap = new Map<string, Fund>();
      const dayPendingMap = new Map<string, Fund>();

      const monthlyRefundedMap = new Map<string, Fund>();
      const monthlyIncomeMap = new Map<string, Fund>();
      const monthlyPendingMap = new Map<string, Fund>();

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
          addToAllFundsMaps(
            totalIncomeMap,
            dayIncomeMap,
            monthlyIncomeMap,
            dayDateLocal,
            monthDateLocal,
            payment.RequestedFunds,
            payment.totalSellerCardanoFees,
          );
        } else if (payment.onChainState === OnChainState.RefundWithdrawn) {
          addToAllFundsMaps(
            totalRefundedMap,
            dayRefundedMap,
            monthlyRefundedMap,
            dayDateLocal,
            monthDateLocal,
            payment.RequestedFunds,
            payment.totalSellerCardanoFees,
          );
        } else if (payment.onChainState === OnChainState.DisputedWithdrawn) {
          if (payment.WithdrawnForSeller.length > 0) {
            addToAllFundsMaps(
              totalIncomeMap,
              dayIncomeMap,
              monthlyIncomeMap,
              dayDateLocal,
              monthDateLocal,
              payment.WithdrawnForSeller,
              payment.totalSellerCardanoFees,
            );
          }
          if (payment.WithdrawnForBuyer.length > 0) {
            addToAllFundsMaps(
              totalRefundedMap,
              dayRefundedMap,
              monthlyRefundedMap,
              dayDateLocal,
              monthDateLocal,
              payment.WithdrawnForBuyer,
              payment.WithdrawnForSeller.length === 0 ? payment.totalSellerCardanoFees : 0n,
            );
          }
        } else if (payment.onChainState !== OnChainState.FundsOrDatumInvalid) {
          addToAllFundsMaps(
            totalPendingMap,
            dayPendingMap,
            monthlyPendingMap,
            dayDateLocal,
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
        totalIncome: mapTotalFundsOutput(totalIncomeMap),
        totalRefunded: mapTotalFundsOutput(totalRefundedMap),
        totalPending: mapTotalFundsOutput(totalPendingMap),
        dailyIncome: mapDailyFundsOutput(dayIncomeMap),
        dailyRefunded: mapDailyFundsOutput(dayRefundedMap),
        dailyPending: mapDailyFundsOutput(dayPendingMap),
        monthlyIncome: mapMonthlyFundsOutput(monthlyIncomeMap),
        monthlyRefunded: mapMonthlyFundsOutput(monthlyRefundedMap),
        monthlyPending: mapMonthlyFundsOutput(monthlyPendingMap),
      };
    } catch (error: unknown) {
      const errorInstance = error instanceof Error ? error : new Error(String(error));
      const statusCode =
        (errorInstance as { statusCode?: number; status?: number }).statusCode ||
        (errorInstance as { statusCode?: number; status?: number }).status ||
        500;

      recordBusinessEndpointError('/api/v1/payment/income', 'POST', statusCode, errorInstance, {
        agent_identifier: input.agentIdentifier ?? 'all',
        start_date: input.startDate?.toISOString() || 'null',
        end_date: input.endDate?.toISOString() || 'null',
        network: input.network,
        user_id: ctx.id,
        duration: Date.now() - startTime,
      });

      throw error;
    }
  },
});
