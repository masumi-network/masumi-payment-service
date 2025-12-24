import { $Enums, Network, OnChainState } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/utils/db';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import {
  parseDateRange,
  filterByAgentIdentifier,
  aggregatePurchaseEarnings,
  mapUnitAmountToResponse,
  TransactionWithFunds,
} from '@/utils/earnings-helpers';
import { recordBusinessEndpointError } from '@/utils/metrics';

export const getPurchaseEarningsSchemaInput = z.object({
  agentIdentifier: z
    .string()
    .min(57)
    .max(250)
    .describe(
      'The unique identifier of the agent to get purchase earnings for',
    ),
  startDate: z
    .string()
    .date()
    .optional()
    .nullable()
    .describe(
      'Start date for earnings calculation (date format: 2024-01-01). If null, uses earliest available data',
    ),
  endDate: z
    .string()
    .date()
    .optional()
    .nullable()
    .describe(
      'End date for earnings calculation (date format: 2024-01-31). If null, uses current date',
    ),
  network: z
    .nativeEnum(Network)
    .describe('The Cardano network to query earnings from'),
});

export const getPurchaseEarningsSchemaOutput = z.object({
  agentIdentifier: z.string(),
  dateRange: z.string().describe('Actual date range used for calculation'),
  periodStart: z.date(),
  periodEnd: z.date(),
  totalTransactions: z.number(),
  totalEarnings: z.array(
    z.object({
      unit: z.string(),
      amount: z.string(),
    }),
  ),
  totalFeesPaid: z.array(
    z.object({
      unit: z.string(),
      amount: z.string(),
    }),
  ),
  totalRevenue: z.array(
    z.object({
      unit: z.string(),
      amount: z.string(),
    }),
  ),
  monthlyBreakdown: z.array(
    z.object({
      month: z.string(),
      monthNumber: z.number(),
      year: z.number(),
      earnings: z.array(
        z.object({
          unit: z.string(),
          amount: z.string(),
        }),
      ),
      transactions: z.number(),
    }),
  ),
  dailyEarnings: z.array(
    z.object({
      date: z.string(),
      earnings: z.array(
        z.object({
          unit: z.string(),
          amount: z.string(),
        }),
      ),
      revenue: z.array(
        z.object({
          unit: z.string(),
          amount: z.string(),
        }),
      ),
      fees: z.array(
        z.object({
          unit: z.string(),
          amount: z.string(),
        }),
      ),
      transactions: z.number(),
    }),
  ),
});

export const getPurchaseEarnings = readAuthenticatedEndpointFactory.build({
  method: 'get',
  input: getPurchaseEarningsSchemaInput,
  output: getPurchaseEarningsSchemaOutput,
  handler: async ({
    input,
    options,
  }: {
    input: z.infer<typeof getPurchaseEarningsSchemaInput>;
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

      const purchaseRequests = await prisma.purchaseRequest.findMany({
        where: {
          createdAt: {
            gte: periodStart,
            lte: periodEnd,
          },
          unlockTime: {
            lte: new Date().getTime(),
          },
          onChainState: OnChainState.Withdrawn,
          PaymentSource: {
            network: input.network,
            deletedAt: null,
          },
        },
        include: {
          PaidFunds: true,
          WithdrawnForSeller: true,
          PaymentSource: true,
        },
      });

      const agentPurchases = filterByAgentIdentifier(
        purchaseRequests,
        input.agentIdentifier,
      );

      const { earningsMap, revenueMap, feesMap } = aggregatePurchaseEarnings(
        agentPurchases as unknown as TransactionWithFunds[],
      );

      const totalEarnings = Array.from(earningsMap.entries()).map(
        ([unit, amount]) => mapUnitAmountToResponse(unit, amount),
      );

      const totalFeesPaid = Array.from(feesMap.entries()).map(
        ([unit, amount]) => mapUnitAmountToResponse(unit, amount),
      );

      const totalRevenue = Array.from(revenueMap.entries()).map(
        ([unit, amount]) => mapUnitAmountToResponse(unit, amount),
      );

      const transactionsByDate = new Map<string, typeof agentPurchases>();
      agentPurchases.forEach((purchase) => {
        const dateKey = new Date(purchase.createdAt)
          .toISOString()
          .split('T')[0];
        if (!transactionsByDate.has(dateKey)) {
          transactionsByDate.set(dateKey, []);
        }
        transactionsByDate.get(dateKey)!.push(purchase);
      });

      const dailyEarnings = Array.from(transactionsByDate.entries())
        .sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
        .map(([date, dayTransactions]) => {
          const { earningsMap, revenueMap, feesMap } =
            aggregatePurchaseEarnings(
              dayTransactions as unknown as TransactionWithFunds[],
            );

          const earnings = Array.from(earningsMap.entries()).map(
            ([unit, amount]) => mapUnitAmountToResponse(unit, amount),
          );

          const revenue = Array.from(revenueMap.entries()).map(
            ([unit, amount]) => mapUnitAmountToResponse(unit, amount),
          );

          const fees = Array.from(feesMap.entries()).map(([unit, amount]) =>
            mapUnitAmountToResponse(unit, amount),
          );

          return {
            date,
            earnings,
            revenue,
            fees,
            transactions: dayTransactions.length,
          };
        });

      const monthlyMap = new Map<
        string,
        {
          earnings: Map<string, bigint>;
          count: number;
          year: number;
          month: string;
          monthNumber: number;
        }
      >();

      dailyEarnings.forEach((day) => {
        const date = new Date(day.date);
        const year = date.getFullYear();
        const monthNumber = date.getMonth() + 1;
        const month = date.toLocaleString('default', { month: 'long' });
        const key = `${year}-${monthNumber}`;

        if (!monthlyMap.has(key)) {
          monthlyMap.set(key, {
            earnings: new Map(),
            count: 0,
            year,
            month,
            monthNumber,
          });
        }

        const monthData = monthlyMap.get(key)!;
        monthData.count += day.transactions;

        day.earnings.forEach((earning) => {
          const currentAmount =
            monthData.earnings.get(earning.unit) || BigInt(0);
          monthData.earnings.set(
            earning.unit,
            currentAmount + BigInt(earning.amount),
          );
        });
      });

      const monthlyBreakdown = Array.from(monthlyMap.values()).map((data) => ({
        month: data.month,
        monthNumber: data.monthNumber,
        year: data.year,
        earnings: Array.from(data.earnings.entries()).map(([unit, amount]) =>
          mapUnitAmountToResponse(unit, amount),
        ),
        transactions: data.count,
      }));

      return {
        agentIdentifier: input.agentIdentifier,
        dateRange: `${periodStart.toISOString().split('T')[0]} to ${periodEnd.toISOString().split('T')[0]}`,
        periodStart,
        periodEnd,
        totalTransactions: agentPurchases.length,
        totalEarnings,
        totalFeesPaid,
        totalRevenue,
        dailyEarnings,
        monthlyBreakdown,
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
        '/api/v1/purchase/earnings',
        'GET',
        statusCode,
        errorInstance,
        {
          agent_identifier: input.agentIdentifier,
          start_date: input.startDate || 'null',
          end_date: input.endDate || 'null',
          network: input.network,
          user_id: options.id,
          duration: Date.now() - startTime,
        },
      );

      throw error;
    }
  },
});
