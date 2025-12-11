import { Lucid, Blockfrost } from 'lucid-cardano';
import { TxBuilderLucidV3 } from '@sundaeswap/core/lucid';
import { QueryProviderSundaeSwap } from '@sundaeswap/core';
import { AssetAmount } from '@sundaeswap/asset';
import { ESwapType, EDatumType } from '@sundaeswap/core';
import { logger } from '@/utils/logger';

export interface Token {
  policyId: string;
  assetName: string;
  name: string;
}

export interface SwapResult {
  txHash: string;
  walletAddress: string;
}

export interface SwapParams {
  mnemonic: string;
  fromAmount: number;
  isFromAda?: boolean;
  fromToken: Token;
  toToken: Token;
  poolId: string;
  slippage?: number;
}

async function initializeLucid(blockfrostApiKey: string): Promise<Lucid> {
  return await Lucid.new(
    new Blockfrost(
      'https://cardano-mainnet.blockfrost.io/api/v0',
      blockfrostApiKey,
    ),
    'Mainnet',
  );
}

async function getWalletFromMnemonic(
  mnemonic: string,
  blockfrostApiKey: string,
): Promise<{ address: string; lucid: Lucid }> {
  const lucid = await initializeLucid(blockfrostApiKey);
  lucid.selectWalletFromSeed(mnemonic);
  return {
    address: await lucid.wallet.address(),
    lucid,
  };
}

export async function swapTokens(
  params: SwapParams,
  blockfrostApiKey: string,
): Promise<SwapResult> {
  const startTime = Date.now();
  try {
    logger.info('Initializing swap transaction', {
      component: 'swap-service',
      isFromAda: params.isFromAda,
      amount: params.fromAmount,
      poolId: params.poolId,
    });

    const wallet = await getWalletFromMnemonic(
      params.mnemonic,
      blockfrostApiKey,
    );

    const lovelaceBalance = await wallet.lucid.wallet.getUtxos();
    const adaBalance =
      lovelaceBalance.reduce((acc: bigint, utxo) => {
        const lovelace = (utxo.assets as { lovelace: bigint }).lovelace;
        return acc + lovelace;
      }, 0n) / 1000000n;

    logger.info('Wallet initialized', {
      component: 'swap-service',
      walletAddress: wallet.address,
      adaBalance: String(adaBalance),
    });

    const queryProvider = new QueryProviderSundaeSwap('mainnet');
    const txBuilder = new TxBuilderLucidV3(wallet.lucid, 'mainnet');

    logger.info('Querying pool data', {
      component: 'swap-service',
      poolId: params.poolId,
    });

    const poolData = await queryProvider.findPoolData({
      ident: params.poolId,
    });

    const isFromAda =
      params.isFromAda ??
      (!params.fromToken.policyId ||
        params.fromToken.policyId === '' ||
        params.fromToken.policyId.toLowerCase() === 'native');

    const suppliedAsset = new AssetAmount(
      BigInt(params.fromAmount * 1_000_000),
      isFromAda ? poolData.assetA : poolData.assetB,
    );

    const slippage = params.slippage ?? 0.03;

    const args = {
      swapType: {
        type: ESwapType.MARKET as const,
        slippage,
      },
      pool: poolData,
      orderAddresses: {
        DestinationAddress: {
          address: wallet.address,
          datum: {
            type: EDatumType.NONE as const,
          },
        },
      },
      suppliedAsset: suppliedAsset,
    };

    logger.info('Building swap transaction', {
      component: 'swap-service',
      slippage,
    });

    const { build } = await txBuilder.swap(args);
    const builtTx = await build();
    const { submit } = await builtTx.sign();

    logger.info('Submitting transaction', {
      component: 'swap-service',
    });

    const txHash = await submit();

    logger.info('Transaction submitted successfully', {
      component: 'swap-service',
      txHash,
      walletAddress: wallet.address,
      duration: Date.now() - startTime,
    });

    return {
      txHash,
      walletAddress: wallet.address,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error occurred';
    logger.error('Swap failed', {
      component: 'swap-service',
      error: errorMessage,
      duration: Date.now() - startTime,
    });
    throw error;
  }
}
