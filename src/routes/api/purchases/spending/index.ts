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

type PurchaseFunds = {
  units: Map<string, number>;
  blockchainFees: number;
};

function addToPurchaseFundsMap(
  purchaseFunds: PurchaseFunds,
  unit: string,
  amount: bigint,
): void {
  if (purchaseFunds.units.has(unit)) {
    purchaseFunds.units.set(
      unit,
      purchaseFunds.units.get(unit)! + Number(amount),
    );
  } else {
    purchaseFunds.units.set(unit, Number(amount));
  }
}

function addToPurchaseFundsMapArray(
  purchaseFunds: PurchaseFunds,
  units: Array<{ unit: string; amount: bigint }>,
  blockchainFees: bigint,
): void {
  for (const unit of units) {
    addToPurchaseFundsMap(purchaseFunds, unit.unit, unit.amount);
  }
  purchaseFunds.blockchainFees += Number(blockchainFees);
}

function addToPurchaseFundsMapArrayMap(
  map: Map<string, PurchaseFunds>,
  key: string,
  units: Array<{ unit: string; amount: bigint }>,
  blockchainFees: bigint,
): void {
  if (!map.has(key)) {
    map.set(key, { units: new Map<string, number>(), blockchainFees: 0 });
  }
  addToPurchaseFundsMapArray(map.get(key)!, units, blockchainFees);
}

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
  monthlySpend: z.array(
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

export const postPurchaseSpending = readAuthenticatedEndpointFactory.build({
  method: 'post',
  input: postPurchaseSpendingSchemaInput,
  output: postPurchaseSpendingSchemaOutput,
  handler: async ({
    input,
    options,
  }: {
    input: z.infer<typeof postPurchaseSpendingSchemaInput>;
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
      const totalSpendMap: PurchaseFunds = {
        units: new Map<string, number>(),
        blockchainFees: 0,
      };
      const totalPendingMap = {
        units: new Map<string, number>(),
        blockchainFees: 0,
      };

      const dayRefundedMap = new Map<string, PurchaseFunds>();
      const daySpendMap = new Map<string, PurchaseFunds>();
      const dayPendingMap = new Map<string, PurchaseFunds>();

      const monthlyRefundedMap = new Map<string, PurchaseFunds>();
      const monthlySpendMap = new Map<string, PurchaseFunds>();
      const monthlyPendingMap = new Map<string, PurchaseFunds>();

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
          addToPurchaseFundsMapArray(
            totalSpendMap,
            purchase.PaidFunds,
            purchase.totalBuyerCardanoFees,
          );
          addToPurchaseFundsMapArrayMap(
            daySpendMap,
            dayDateLocal,
            purchase.PaidFunds,
            purchase.totalBuyerCardanoFees,
          );
          addToPurchaseFundsMapArrayMap(
            monthlySpendMap,
            monthDateLocal,
            purchase.PaidFunds,
            purchase.totalBuyerCardanoFees,
          );
        } else if (purchase.onChainState === OnChainState.RefundWithdrawn) {
          addToPurchaseFundsMapArray(
            totalRefundedMap,
            purchase.PaidFunds,
            purchase.totalBuyerCardanoFees,
          );
          addToPurchaseFundsMapArrayMap(
            dayRefundedMap,
            dayDateLocal,
            purchase.PaidFunds,
            purchase.totalBuyerCardanoFees,
          );
          addToPurchaseFundsMapArrayMap(
            monthlyRefundedMap,
            monthDateLocal,
            purchase.PaidFunds,
            purchase.totalBuyerCardanoFees,
          );
        } else if (purchase.onChainState === OnChainState.DisputedWithdrawn) {
          if (purchase.WithdrawnForBuyer.length > 0) {
            addToPurchaseFundsMapArray(
              totalRefundedMap,
              purchase.WithdrawnForBuyer,
              purchase.totalBuyerCardanoFees,
            );
            addToPurchaseFundsMapArrayMap(
              dayRefundedMap,
              dayDateLocal,
              purchase.WithdrawnForBuyer,
              purchase.totalBuyerCardanoFees,
            );
            addToPurchaseFundsMapArrayMap(
              monthlyRefundedMap,
              monthDateLocal,
              purchase.WithdrawnForBuyer,
              purchase.totalBuyerCardanoFees,
            );
          }
          if (purchase.WithdrawnForSeller.length > 0) {
            addToPurchaseFundsMapArray(
              totalSpendMap,
              purchase.WithdrawnForSeller,
              purchase.totalBuyerCardanoFees,
            );
          }
          addToPurchaseFundsMapArrayMap(
            daySpendMap,
            monthDateLocal,
            purchase.WithdrawnForSeller,
            purchase.totalBuyerCardanoFees,
          );
          addToPurchaseFundsMapArrayMap(
            monthlySpendMap,
            monthDateLocal,
            purchase.WithdrawnForSeller,
            purchase.totalBuyerCardanoFees,
          );
        } else {
          addToPurchaseFundsMapArray(
            totalPendingMap,
            purchase.PaidFunds,
            purchase.totalBuyerCardanoFees,
          );
          addToPurchaseFundsMapArrayMap(
            dayPendingMap,
            dayDateLocal,
            purchase.PaidFunds,
            purchase.totalBuyerCardanoFees,
          );
          addToPurchaseFundsMapArrayMap(
            monthlyPendingMap,
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
        totalSpend: {
          units: Array.from(totalSpendMap.units.entries()).map(
            ([key, value]) => ({
              unit: key,
              amount: value,
            }),
          ),
          blockchainFees: totalSpendMap.blockchainFees,
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
        dailySpend: Array.from(daySpendMap.entries()).map(([key, value]) => ({
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
        monthlySpend: Array.from(monthlySpendMap.entries()).map(
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
        '/api/v1/purchase/spending',
        'POST',
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
