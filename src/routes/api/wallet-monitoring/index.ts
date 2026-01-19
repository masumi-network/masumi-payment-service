import { prisma } from '@/utils/db';
import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { Network } from '@prisma/client';
import createHttpError from 'http-errors';
import { z } from '@/utils/zod-openapi';
import { AuthContext } from '@/utils/middleware/auth-middleware';

// ============= SCHEMAS =============

// Output schema for AssetThreshold
const assetThresholdSchema = z.object({
  id: z.string().describe('Unique identifier for the asset threshold'),
  policyId: z.string().describe('Policy ID of the asset'),
  assetName: z.string().describe('Asset name (hex encoded)'),
  displayName: z
    .string()
    .nullable()
    .describe('Human-readable name of the asset'),
  displaySymbol: z
    .string()
    .nullable()
    .describe('Display symbol for the asset (e.g., USDM)'),
  decimals: z.number().describe('Number of decimal places for this asset'),
  minAmount: z
    .string()
    .describe('Minimum amount threshold (as string for large numbers)'),
});

// Output schema for WalletThreshold
const walletThresholdSchema = z.object({
  id: z.string().describe('Unique identifier for the wallet threshold'),
  hotWalletId: z.string().describe('ID of the hot wallet being monitored'),
  enabled: z
    .boolean()
    .describe('Whether monitoring is enabled for this wallet'),
  adaThresholdLovelace: z
    .string()
    .describe('ADA threshold in lovelace (1 ADA = 1,000,000 lovelace)'),
  HotWallet: z.object({
    id: z.string().describe('Hot wallet ID'),
    walletAddress: z.string().describe('Cardano address of the wallet'),
    walletVkey: z.string().describe('Payment key hash'),
    type: z.string().describe('Wallet type (Selling or Purchasing)'),
  }),
  AssetThresholds: z
    .array(assetThresholdSchema)
    .describe('Thresholds for other assets (USDM, etc.)'),
});

// Output schema for WalletMonitorConfig
export const walletMonitorConfigSchema = z
  .object({
    id: z.string().describe('Unique identifier for the monitoring config'),
    paymentSourceId: z
      .string()
      .describe('Payment source this monitoring config belongs to'),
    enabled: z
      .boolean()
      .describe('Whether monitoring is enabled for this payment source'),
    checkIntervalSeconds: z
      .number()
      .describe('How often to check balances (in seconds)'),
    lastCheckedAt: z
      .date()
      .nullable()
      .describe('Last time balances were checked'),
    lastCheckStatus: z
      .string()
      .nullable()
      .describe('Status of last check (success, partial_failure, error)'),
    lastCheckError: z
      .string()
      .nullable()
      .describe('Error message from last check, if any'),
    WalletThresholds: z
      .array(walletThresholdSchema)
      .describe('Individual wallet thresholds'),
  })
  .openapi('WalletMonitorConfig');

// ============= GET ENDPOINT =============

export const getWalletMonitoringInputSchema = z.object({
  paymentSourceId: z
    .string()
    .optional()
    .describe('Filter by specific payment source ID'),
  network: z
    .nativeEnum(Network)
    .optional()
    .describe('Filter by network (Preprod or Mainnet)'),
});

export const getWalletMonitoringOutputSchema = z.object({
  WalletMonitorConfigs: z
    .array(walletMonitorConfigSchema)
    .describe('List of wallet monitoring configurations'),
});

// Helper to convert BigInt fields to strings for JSON serialization
// Type for wallet monitor config with includes from Prisma
type WalletMonitorConfigWithIncludes = {
  id: string;
  paymentSourceId: string;
  enabled: boolean;
  checkIntervalSeconds: number;
  lastCheckedAt: Date | null;
  lastCheckStatus: string | null;
  lastCheckError: string | null;
  WalletThresholds: Array<{
    id: string;
    hotWalletId: string;
    enabled: boolean;
    adaThresholdLovelace: bigint;
    HotWallet: {
      id: string;
      walletAddress: string;
      walletVkey: string;
      type: string;
    };
    AssetThresholds: Array<{
      id: string;
      policyId: string;
      assetName: string;
      displayName: string | null;
      displaySymbol: string | null;
      decimals: number;
      minAmount: bigint;
    }>;
  }>;
};

function serializeConfig(config: WalletMonitorConfigWithIncludes) {
  return {
    ...config,
    WalletThresholds: config.WalletThresholds.map((wt) => ({
      ...wt,
      adaThresholdLovelace: wt.adaThresholdLovelace.toString(),
      AssetThresholds: wt.AssetThresholds.map((at) => ({
        ...at,
        minAmount: at.minAmount.toString(),
      })),
    })),
  };
}

export const walletMonitoringGet = adminAuthenticatedEndpointFactory.build({
  method: 'get',
  input: getWalletMonitoringInputSchema,
  output: getWalletMonitoringOutputSchema,
  handler: async ({
    input,
    ctx,
  }: {
    input: z.infer<typeof getWalletMonitoringInputSchema>;
    ctx: AuthContext;
  }) => {
    const configs = await prisma.walletMonitorConfig.findMany({
      where: {
        paymentSourceId: input.paymentSourceId,
        PaymentSource: {
          network: input.network
            ? { equals: input.network }
            : { in: ctx.networkLimit },
          deletedAt: null,
        },
      },
      include: {
        WalletThresholds: {
          include: {
            HotWallet: {
              select: {
                id: true,
                walletAddress: true,
                walletVkey: true,
                type: true,
              },
            },
            AssetThresholds: true,
          },
        },
      },
    });
    return { WalletMonitorConfigs: configs.map(serializeConfig) };
  },
});

// ============= POST ENDPOINT (Create) =============

export const createWalletMonitoringInputSchema = z.object({
  paymentSourceId: z
    .string()
    .describe('Payment source ID to add monitoring to'),
  enabled: z
    .boolean()
    .default(false)
    .describe('Whether monitoring is enabled (default: false for safety)'),
  checkIntervalSeconds: z.coerce
    .number()
    .min(60)
    .max(86400)
    .default(3600)
    .describe(
      'How often to check balances in seconds (min: 60, max: 86400, default: 3600 = 1 hour)',
    ),
  walletThresholds: z
    .array(
      z.object({
        hotWalletId: z.string().describe('Hot wallet ID to monitor'),
        enabled: z
          .boolean()
          .default(true)
          .describe('Whether this wallet threshold is enabled'),
        adaThresholdLovelace: z
          .string()
          .max(25)
          .default('10000000')
          .describe('ADA threshold in lovelace (default: 10 ADA = 10,000,000)'),
        assetThresholds: z
          .array(
            z.object({
              policyId: z
                .string()
                .length(56)
                .describe('Policy ID of the asset (56 hex characters)'),
              assetName: z
                .string()
                .describe('Asset name in hex (can be empty string)'),
              displayName: z
                .string()
                .optional()
                .describe('Human-readable name (e.g., "USD Masumi")'),
              displaySymbol: z
                .string()
                .optional()
                .describe('Display symbol (e.g., "USDM")'),
              decimals: z.coerce
                .number()
                .min(0)
                .max(18)
                .default(0)
                .describe(
                  'Number of decimal places (0 for no decimals, 6 for USDM)',
                ),
              minAmount: z
                .string()
                .max(25)
                .describe('Minimum amount threshold in smallest unit'),
            }),
          )
          .optional()
          .describe('Optional asset thresholds for tokens like USDM'),
      }),
    )
    .min(1)
    .describe('At least one wallet threshold is required'),
});

export const walletMonitoringPost = adminAuthenticatedEndpointFactory.build({
  method: 'post',
  input: createWalletMonitoringInputSchema,
  output: walletMonitorConfigSchema,
  handler: async ({
    input,
    ctx,
  }: {
    input: z.infer<typeof createWalletMonitoringInputSchema>;
    ctx: AuthContext;
  }) => {
    // Verify payment source exists and user has access
    const paymentSource = await prisma.paymentSource.findFirst({
      where: {
        id: input.paymentSourceId,
        network: { in: ctx.networkLimit },
        deletedAt: null,
      },
    });

    if (!paymentSource) {
      throw createHttpError(404, 'Payment source not found');
    }

    // Check if config already exists
    const existing = await prisma.walletMonitorConfig.findUnique({
      where: { paymentSourceId: input.paymentSourceId },
    });

    if (existing) {
      throw createHttpError(
        409,
        'Monitoring config already exists for this payment source. Use PATCH to update it.',
      );
    }

    // Verify all hot wallets exist and belong to this payment source
    const hotWalletIds = input.walletThresholds.map((wt) => wt.hotWalletId);
    const hotWallets = await prisma.hotWallet.findMany({
      where: {
        id: { in: hotWalletIds },
        paymentSourceId: input.paymentSourceId,
        deletedAt: null,
      },
    });

    if (hotWallets.length !== hotWalletIds.length) {
      throw createHttpError(
        400,
        'One or more hot wallets not found or do not belong to this payment source',
      );
    }

    // Create config with thresholds in transaction
    const config = await prisma.$transaction(async (tx) => {
      const newConfig = await tx.walletMonitorConfig.create({
        data: {
          paymentSourceId: input.paymentSourceId,
          enabled: input.enabled,
          checkIntervalSeconds: input.checkIntervalSeconds,
        },
      });

      for (const threshold of input.walletThresholds) {
        await tx.walletThreshold.create({
          data: {
            walletMonitorConfigId: newConfig.id,
            hotWalletId: threshold.hotWalletId,
            enabled: threshold.enabled,
            adaThresholdLovelace: BigInt(threshold.adaThresholdLovelace),
            AssetThresholds: threshold.assetThresholds
              ? {
                  createMany: {
                    data: threshold.assetThresholds.map((at) => ({
                      ...at,
                      minAmount: BigInt(at.minAmount),
                    })),
                  },
                }
              : undefined,
          },
        });
      }

      return tx.walletMonitorConfig.findUniqueOrThrow({
        where: { id: newConfig.id },
        include: {
          WalletThresholds: {
            include: {
              HotWallet: {
                select: {
                  id: true,
                  walletAddress: true,
                  walletVkey: true,
                  type: true,
                },
              },
              AssetThresholds: true,
            },
          },
        },
      });
    });

    return serializeConfig(config);
  },
});

// ============= PATCH ENDPOINT (Update) =============

export const updateWalletMonitoringInputSchema = z.object({
  id: z.string().describe('Monitoring config ID to update'),
  enabled: z.boolean().optional().describe('Enable or disable monitoring'),
  checkIntervalSeconds: z.coerce
    .number()
    .min(60)
    .max(86400)
    .optional()
    .describe('Update check interval in seconds'),
});

export const walletMonitoringPatch = adminAuthenticatedEndpointFactory.build({
  method: 'patch',
  input: updateWalletMonitoringInputSchema,
  output: walletMonitorConfigSchema,
  handler: async ({
    input,
    ctx,
  }: {
    input: z.infer<typeof updateWalletMonitoringInputSchema>;
    ctx: AuthContext;
  }) => {
    const existing = await prisma.walletMonitorConfig.findFirst({
      where: {
        id: input.id,
        PaymentSource: {
          network: { in: ctx.networkLimit },
          deletedAt: null,
        },
      },
    });

    if (!existing) {
      throw createHttpError(404, 'Monitoring config not found');
    }

    const updated = await prisma.walletMonitorConfig.update({
      where: { id: input.id },
      data: {
        enabled: input.enabled,
        checkIntervalSeconds: input.checkIntervalSeconds,
      },
      include: {
        WalletThresholds: {
          include: {
            HotWallet: {
              select: {
                id: true,
                walletAddress: true,
                walletVkey: true,
                type: true,
              },
            },
            AssetThresholds: true,
          },
        },
      },
    });

    return serializeConfig(updated);
  },
});

// ============= DELETE ENDPOINT =============

export const deleteWalletMonitoringInputSchema = z.object({
  id: z.string().describe('Monitoring config ID to delete'),
});

export const walletMonitoringDelete = adminAuthenticatedEndpointFactory.build({
  method: 'delete',
  input: deleteWalletMonitoringInputSchema,
  output: walletMonitorConfigSchema,
  handler: async ({
    input,
    ctx,
  }: {
    input: z.infer<typeof deleteWalletMonitoringInputSchema>;
    ctx: AuthContext;
  }) => {
    const existing = await prisma.walletMonitorConfig.findFirst({
      where: {
        id: input.id,
        PaymentSource: {
          network: { in: ctx.networkLimit },
          deletedAt: null,
        },
      },
      include: {
        WalletThresholds: {
          include: {
            HotWallet: {
              select: {
                id: true,
                walletAddress: true,
                walletVkey: true,
                type: true,
              },
            },
            AssetThresholds: true,
          },
        },
      },
    });

    if (!existing) {
      throw createHttpError(404, 'Monitoring config not found');
    }

    // Cascade delete handled by Prisma schema (onDelete: Cascade)
    await prisma.walletMonitorConfig.delete({
      where: { id: input.id },
    });

    return serializeConfig(existing);
  },
});
