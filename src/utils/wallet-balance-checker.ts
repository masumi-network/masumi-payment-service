import { BlockfrostProvider } from '@meshsdk/core';
import { logger } from './logger';
import { Network } from '@prisma/client';
import { updateWalletBalance } from './metrics';

interface WalletConfig {
  address: string;
  network: Network;
  thresholdAda: number;
}

export async function checkAllWalletBalances(): Promise<void> {
  const walletsToCheck: WalletConfig[] = [];

  // Preprod wallets (active monitoring)
  const preprodApiKey = process.env.BLOCKFROST_API_KEY_PREPROD;
  const preprodAddresses = process.env.MONITOR_WALLET_ADDRESSES_PREPROD?.split(
    ',',
  )
    .map((addr) => addr.trim())
    .filter(Boolean);

  if (preprodApiKey && preprodAddresses && preprodAddresses.length > 0) {
    walletsToCheck.push(
      ...preprodAddresses.map((addr) => ({
        address: addr,
        network: Network.Preprod,
        thresholdAda: 10, // 10 ADA threshold for preprod
      })),
    );
  }

  // Mainnet wallets (commented out - uncomment when needed)
  // const mainnetApiKey = process.env.BLOCKFROST_API_KEY_MAINNET;
  // const mainnetAddresses = process.env.MONITOR_WALLET_ADDRESSES_MAINNET
  //   ?.split(',')
  //   .map((addr) => addr.trim())
  //   .filter(Boolean);
  //
  // if (mainnetApiKey && mainnetAddresses && mainnetAddresses.length > 0) {
  //   walletsToCheck.push(
  //     ...mainnetAddresses.map((addr) => ({
  //       address: addr,
  //       network: Network.Mainnet,
  //       thresholdAda: 50, // 50 ADA threshold for mainnet
  //     })),
  //   );
  // }

  if (walletsToCheck.length === 0) {
    logger.debug('No wallet addresses configured for balance monitoring');
    return;
  }

  logger.info('Starting wallet balance checks', {
    walletCount: walletsToCheck.length,
  });

  // Check all wallets
  await Promise.allSettled(
    walletsToCheck.map(async (config) => {
      const apiKey =
        config.network === Network.Preprod ? preprodApiKey : undefined;

      if (!apiKey) {
        logger.warn('Missing Blockfrost API key', { network: config.network });
        return;
      }

      await checkWalletBalance(
        apiKey,
        config.address,
        config.network,
        config.thresholdAda,
      );
    }),
  );

  logger.info('Completed wallet balance checks');
}

async function checkWalletBalance(
  apiKey: string,
  address: string,
  network: Network,
  thresholdAda: number,
): Promise<void> {
  if (!address || address.trim() === '') {
    return;
  }

  try {
    const provider = new BlockfrostProvider(apiKey);
    const utxos = await provider.fetchAddressUTxOs(address);

    // Calculate total lovelace (handle both 'lovelace' and '' unit)
    const totalLovelace = utxos.reduce((sum, utxo) => {
      const lovelaceAsset = utxo.output.amount.find(
        (asset) => asset.unit === 'lovelace' || asset.unit === '',
      );
      return sum + BigInt(lovelaceAsset?.quantity ?? '0');
    }, 0n);

    const balanceAda = Number(totalLovelace) / 1_000_000;

    // Update wallet balance metric for OpenTelemetry/SigNoz monitoring
    updateWalletBalance(address, network, totalLovelace);

    if (balanceAda < thresholdAda) {
      logger.warn('LOW WALLET BALANCE', {
        alert_type: 'wallet_balance_low',
        wallet_address: address,
        network: network,
        balance_lovelace: totalLovelace.toString(),
        balance_ada: balanceAda.toFixed(6),
        threshold_ada: thresholdAda,
      });
    } else {
      logger.info('Wallet balance OK', {
        wallet_address: address,
        network: network,
        balance_ada: balanceAda.toFixed(6),
      });
    }
  } catch (error: unknown) {
    // Handle rate limiting gracefully
    if (
      typeof error === 'object' &&
      error !== null &&
      'status_code' in error &&
      error.status_code === 429
    ) {
      logger.warn('Blockfrost API rate limit hit', {
        wallet_address: address,
        network: network,
      });
      return;
    }

    logger.error('Error checking wallet balance', {
      wallet_address: address,
      network: network,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
