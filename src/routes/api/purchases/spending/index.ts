import { Network, OnChainState } from '@prisma/client';
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

export const postPurchaseSpendingSchemaInput = z.object({
  agentIdentifier: z
    .string()
    .min(57)
    .max(250)
    .describe(
      'The unique identifier of the agent to get purchase spending for, if not provided, will return spending for all agents',
    )
    .nullable(),
  startDate: ez
    .dateIn()
    .optional()
    .nullable()
    .describe(
      'Start date for spendings calculation (date format: 2024-01-01). If null, uses earliest available data. If provided, will be converted to the local time zone of the user',
    ),
  endDate: ez
    .dateIn()
    .optional()
    .nullable()
    .describe(
      'End date for spendings calculation (date format: 2024-01-31). If null, uses current date. If provided, will be converted to the local time zone of the user',
    ),
  timeZone: z
    .string()
    .optional()
    .default('Etc/UTC')
    .describe(
      'The time zone to use for the spendings calculation. If not provided, will use the UTC time zone. Must be a valid IANA time zone name, see https://en.wikipedia.org/wiki/List_of_tz_database_time_zones',
    ),
  network: z
    .nativeEnum(Network)
    .describe('The Cardano network to query spending from'),
});

const unitAmountSchema = z
  .object({
    unit: z.string(),
    amount: z.number(),
  })
  .describe(
    'The amount of the unit in the smallest unit. Meaning if the unit is ADA, the amount is in lovelace (1 ADA = 10000000 lovelace) and its unit is ""',
  );

export const postPurchaseSpendingSchemaOutput = z.object({
  agentIdentifier: z.string().nullable(),
  periodStart: z.date(),
  periodEnd: z.date(),
  totalTransactions: z.number(),
  totalSpend: z.object({
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
  dailySpend: z.array(
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
  monthlySpend: z.array(
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

export const postPurchaseSpending = readAuthenticatedEndpointFactory.build({
  method: 'post',
  input: postPurchaseSpendingSchemaInput,
  output: postPurchaseSpendingSchemaOutput,
  handler: async ({
    input,
    ctx,
  }: {
    input: z.infer<typeof postPurchaseSpendingSchemaInput>;
    ctx: AuthContext;
  }) => {
    const startTime = Date.now();
    try {
      await checkIsAllowedNetworkOrThrowUnauthorized(
        ctx.networkLimit,
        input.network,
        ctx.permission,
      );

      const { periodStart, periodEnd } = parseDateRange(
        input.startDate,
        input.endDate,
      );

      const allPurchases = await prisma.purchaseRequest.findMany({
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
          PaidFunds: true,
          WithdrawnForBuyer: true,
          WithdrawnForSeller: true,
          PaymentSource: true,
        },
      });

      const allPurchasesFiltered = filterByAgentIdentifier(
        allPurchases,
        input.agentIdentifier,
      );

      const totalRefundedMap = {
        units: new Map<string, number>(),
        blockchainFees: 0,
      };
      const totalSpendMap: Fund = {
        units: new Map<string, number>(),
        blockchainFees: 0,
      };
      const totalPendingMap = {
        units: new Map<string, number>(),
        blockchainFees: 0,
      };

      const dayRefundedMap = new Map<string, Fund>();
      const daySpendMap = new Map<string, Fund>();
      const dayPendingMap = new Map<string, Fund>();

      const monthlyRefundedMap = new Map<string, Fund>();
      const monthlySpendMap = new Map<string, Fund>();
      const monthlyPendingMap = new Map<string, Fund>();

      for (const purchase of allPurchasesFiltered) {
        //get the day number in the local time zone of the user
        const dayDateLocal = getDayNumberLocal(
          new Date(Number(purchase.payByTime)),
          input.timeZone ?? 'Etc/UTC',
        );
        const monthDateLocal = getMonthNumberLocal(
          new Date(Number(purchase.payByTime)),
          input.timeZone ?? 'Etc/UTC',
        );

        if (purchase.onChainState === OnChainState.Withdrawn) {
          addToAllFundsMaps(
            totalSpendMap,
            daySpendMap,
            monthlySpendMap,
            dayDateLocal,
            monthDateLocal,
            purchase.PaidFunds,
            purchase.totalBuyerCardanoFees,
          );
        } else if (purchase.onChainState === OnChainState.RefundWithdrawn) {
          addToAllFundsMaps(
            totalRefundedMap,
            dayRefundedMap,
            monthlyRefundedMap,
            dayDateLocal,
            monthDateLocal,
            purchase.PaidFunds,
            purchase.totalBuyerCardanoFees,
          );
        } else if (purchase.onChainState === OnChainState.DisputedWithdrawn) {
          if (purchase.WithdrawnForBuyer.length > 0) {
            addToAllFundsMaps(
              totalRefundedMap,
              dayRefundedMap,
              monthlyRefundedMap,
              dayDateLocal,
              monthDateLocal,
              purchase.WithdrawnForBuyer,
              purchase.totalBuyerCardanoFees,
            );
          }
          if (purchase.WithdrawnForSeller.length > 0) {
            addToAllFundsMaps(
              totalSpendMap,
              daySpendMap,
              monthlySpendMap,
              dayDateLocal,
              monthDateLocal,
              purchase.WithdrawnForSeller,
              purchase.WithdrawnForBuyer.length === 0
                ? purchase.totalBuyerCardanoFees
                : 0n,
            );
          }
        } else {
          addToAllFundsMaps(
            totalPendingMap,
            dayPendingMap,
            monthlyPendingMap,
            dayDateLocal,
            monthDateLocal,
            purchase.PaidFunds,
            purchase.totalBuyerCardanoFees,
          );
        }
      }

      return {
        agentIdentifier: input.agentIdentifier,
        periodStart,
        periodEnd,
        totalTransactions: allPurchasesFiltered.length,
        totalSpend: mapTotalFundsOutput(totalSpendMap),
        totalRefunded: mapTotalFundsOutput(totalRefundedMap),
        totalPending: mapTotalFundsOutput(totalPendingMap),
        dailySpend: mapDailyFundsOutput(daySpendMap),
        dailyRefunded: mapDailyFundsOutput(dayRefundedMap),
        dailyPending: mapDailyFundsOutput(dayPendingMap),
        monthlySpend: mapMonthlyFundsOutput(monthlySpendMap),
        monthlyRefunded: mapMonthlyFundsOutput(monthlyRefundedMap),
        monthlyPending: mapMonthlyFundsOutput(monthlyPendingMap),
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
        '/api/v1/purchase/spending',
        'POST',
        statusCode,
        errorInstance,
        {
          agent_identifier: input.agentIdentifier ?? 'all',
          start_date: input.startDate?.toISOString() || 'null',
          end_date: input.endDate?.toISOString() || 'null',
          network: input.network,
          user_id: ctx.id,
          duration: Date.now() - startTime,
        },
      );

      throw error;
    }
  },
});
