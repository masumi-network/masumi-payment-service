import { BlockfrostProvider } from '@meshsdk/core';
import { logger } from './logger';
import { Network, Prisma } from '@prisma/client';
import { updateWalletBalance, updateAssetBalance } from './metrics';
import { prisma } from './db';

// Type-safe interfaces
interface AssetBalance {
  policyId: string;
  assetName: string;
  quantity: bigint;
}

interface WalletCheckResult {
  success: boolean;
  lovelaceBalance?: bigint;
  assetBalances?: Map<string, AssetBalance>;
  error?: string;
}

// Type for database query result
type ConfigWithRelations = Prisma.WalletMonitorConfigGetPayload<{
  include: {
    PaymentSource: {
      include: {
        PaymentSourceConfig: true;
      };
    };
    WalletThresholds: {
      where: { enabled: true };
      include: {
        HotWallet: true;
        AssetThresholds: true;
      };
    };
  };
}>;

export async function checkAllWalletBalances(): Promise<void> {
  try {
    const now = new Date();

    // Find enabled configs
    const configs = await prisma.walletMonitorConfig.findMany({
      where: {
        enabled: true,
      },
      include: {
        PaymentSource: {
          include: {
            PaymentSourceConfig: true,
          },
        },
        WalletThresholds: {
          where: { enabled: true },
          include: {
            HotWallet: true,
            AssetThresholds: true,
          },
        },
      },
    });

    if (configs.length === 0) {
      return;
    }

    // Filter configs that are due based on interval
    const dueConfigs = configs.filter((config) => {
      if (!config.lastCheckedAt) return true; // Never checked
      const msSinceLastCheck = now.getTime() - config.lastCheckedAt.getTime();
      const intervalMs = config.checkIntervalSeconds * 1000;
      return msSinceLastCheck >= intervalMs;
    });

    if (dueConfigs.length === 0) {
      return; // Nothing due yet
    }

    logger.info('Starting wallet balance checks', {
      component: 'wallet_monitoring',
      configCount: dueConfigs.length,
    });

    const results = await Promise.allSettled(
      dueConfigs.map((config) => checkPaymentSourceWallets(config)),
    );

    const successful = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;

    logger.info('Completed wallet balance checks', {
      component: 'wallet_monitoring',
      successful,
      failed,
    });
  } catch (error) {
    logger.error('Fatal error in wallet balance checking', {
      component: 'wallet_monitoring',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function checkPaymentSourceWallets(
  config: ConfigWithRelations,
): Promise<void> {
  const { id, PaymentSource, WalletThresholds } = config;

  try {
    if (!PaymentSource.PaymentSourceConfig?.rpcProviderApiKey) {
      throw new Error('Missing Blockfrost API key');
    }

    const apiKey = PaymentSource.PaymentSourceConfig.rpcProviderApiKey;

    const results = await Promise.allSettled(
      WalletThresholds.map((threshold) =>
        checkWalletBalance(apiKey, PaymentSource.network, threshold),
      ),
    );

    const allSuccess = results.every((r) => r.status === 'fulfilled');
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => {
        const reason: unknown = r.reason;
        if (reason instanceof Error) {
          return reason.message;
        }
        return String(reason);
      });

    await prisma.walletMonitorConfig.update({
      where: { id },
      data: {
        lastCheckedAt: new Date(),
        lastCheckStatus: allSuccess ? 'success' : 'partial_failure',
        lastCheckError: errors.length > 0 ? errors.join('; ') : null,
      },
    });

    logger.debug('Payment source check complete', {
      component: 'wallet_monitoring',
      paymentSourceId: PaymentSource.id,
      walletCount: WalletThresholds.length,
      status: allSuccess ? 'success' : 'partial_failure',
    });
  } catch (error) {
    await prisma.walletMonitorConfig.update({
      where: { id },
      data: {
        lastCheckedAt: new Date(),
        lastCheckStatus: 'error',
        lastCheckError: error instanceof Error ? error.message : String(error),
      },
    });

    logger.error('Payment source check failed', {
      component: 'wallet_monitoring',
      paymentSourceId: PaymentSource.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function checkWalletBalance(
  apiKey: string,
  network: Network,
  threshold: ConfigWithRelations['WalletThresholds'][0],
): Promise<void> {
  const { HotWallet, adaThresholdLovelace, AssetThresholds } = threshold;
  const address = HotWallet.walletAddress;

  try {
    const result = await fetchWalletBalances(apiKey, address);

    if (!result.success || result.lovelaceBalance === undefined) {
      throw new Error(result.error || 'Failed to fetch balance');
    }

    updateWalletBalance(address, network, result.lovelaceBalance);

    if (result.lovelaceBalance < adaThresholdLovelace) {
      const balanceAda = Number(result.lovelaceBalance) / 1_000_000;
      const thresholdAda = Number(adaThresholdLovelace) / 1_000_000;

      logger.warn('LOW WALLET BALANCE', {
        alert_type: 'wallet_balance_low',
        component: 'wallet_monitoring',
        wallet_id: HotWallet.id,
        wallet_type: HotWallet.type,
        wallet_address: address,
        network,
        balance_lovelace: result.lovelaceBalance.toString(),
        balance_ada: balanceAda.toFixed(6),
        threshold_lovelace: adaThresholdLovelace.toString(),
        threshold_ada: thresholdAda.toFixed(6),
      });
    }

    if (AssetThresholds.length > 0 && result.assetBalances) {
      checkAssetThresholds(
        AssetThresholds,
        result.assetBalances,
        HotWallet,
        address,
        network,
      );
    }
  } catch (error) {
    logger.error('Wallet balance check failed', {
      component: 'wallet_monitoring',
      wallet_id: HotWallet.id,
      wallet_address: address,
      network,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function fetchWalletBalances(
  apiKey: string,
  address: string,
): Promise<WalletCheckResult> {
  const maxRetries = 3;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const provider = new BlockfrostProvider(apiKey);
      const utxos = await provider.fetchAddressUTxOs(address);

      // Calculate lovelace and parse assets
      let lovelaceBalance = 0n;
      const assetMap = new Map<string, AssetBalance>();

      for (const utxo of utxos) {
        for (const asset of utxo.output.amount) {
          const unit = asset.unit;

          if (unit === 'lovelace' || unit === '') {
            lovelaceBalance += BigInt(asset.quantity);
            continue;
          }

          if (unit.length < 56) {
            logger.warn('Invalid asset unit length', {
              component: 'wallet_monitoring',
              unit,
              length: unit.length,
            });
            continue;
          }

          const policyId = unit.slice(0, 56);
          const assetName = unit.slice(56);
          const key = `${policyId}:${assetName}`;

          const existing = assetMap.get(key);
          const quantity = BigInt(asset.quantity);

          if (existing) {
            existing.quantity += quantity;
          } else {
            assetMap.set(key, { policyId, assetName, quantity });
          }
        }
      }

      return {
        success: true,
        lovelaceBalance,
        assetBalances: assetMap,
      };
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check for Blockfrost-specific errors
      const blockfrostError = error as { status_code?: number };

      if (blockfrostError?.status_code === 429) {
        const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        logger.warn('Blockfrost rate limit, retrying...', {
          component: 'wallet_monitoring',
          attempt,
          delayMs,
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      if (blockfrostError?.status_code === 404) {
        return {
          success: true,
          lovelaceBalance: 0n,
          assetBalances: new Map(),
        };
      }

      if (attempt < maxRetries) {
        logger.warn('Blockfrost API error, retrying...', {
          component: 'wallet_monitoring',
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
    }
  }

  return {
    success: false,
    error: lastError?.message || 'Failed to fetch balance',
  };
}

function checkAssetThresholds(
  assetThresholds: ConfigWithRelations['WalletThresholds'][0]['AssetThresholds'],
  assetBalances: Map<string, AssetBalance>,
  hotWallet: ConfigWithRelations['WalletThresholds'][0]['HotWallet'],
  address: string,
  network: Network,
): void {
  for (const threshold of assetThresholds) {
    const key = `${threshold.policyId}:${threshold.assetName}`;
    const balance = assetBalances.get(key);
    const currentBalance = balance?.quantity ?? 0n;

    updateAssetBalance(
      address,
      network,
      threshold.policyId,
      threshold.assetName,
      currentBalance,
    );

    if (currentBalance < threshold.minAmount) {
      const safeDecimals = Math.min(threshold.decimals, 18);

      const displayBalance =
        Number(currentBalance) / Math.pow(10, safeDecimals);
      const displayThreshold =
        Number(threshold.minAmount) / Math.pow(10, safeDecimals);

      logger.warn('LOW ASSET BALANCE', {
        alert_type: 'wallet_asset_balance_low',
        component: 'wallet_monitoring',
        wallet_id: hotWallet.id,
        wallet_type: hotWallet.type,
        wallet_address: address,
        network,
        policy_id: threshold.policyId,
        asset_name: threshold.assetName,
        display_name: threshold.displayName || 'Unknown',
        display_symbol: threshold.displaySymbol || '',
        current_balance: currentBalance.toString(),
        current_balance_display: displayBalance.toFixed(safeDecimals),
        threshold: threshold.minAmount.toString(),
        threshold_display: displayThreshold.toFixed(safeDecimals),
      });
    }
  }
}
