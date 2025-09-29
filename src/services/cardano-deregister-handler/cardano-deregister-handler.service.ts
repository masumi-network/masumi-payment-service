import { TransactionStatus, RegistrationState } from '@prisma/client';
import { prisma } from '@/utils/db';
import {
  BlockfrostProvider,
  IFetcher,
  LanguageVersion,
  MeshTxBuilder,
  Network,
  UTxO,
} from '@meshsdk/core';
import { logger } from '@/utils/logger';
import { convertNetwork } from '@/utils/converter/network-convert';
import { generateWalletExtended } from '@/utils/generator/wallet-generator';
import { lockAndQueryRegistryRequests } from '@/utils/db/lock-and-query-registry-request';
import { getRegistryScriptFromNetworkHandlerV1 } from '@/utils/generator/contract-generator';
import { SERVICE_CONSTANTS } from '@/utils/config';
import { advancedRetryAll, delayErrorResolver } from 'advanced-retry';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { convertErrorString } from '@/utils/converter/error-string-convert';

const mutex = new Mutex();

function validateDeregistrationRequest(request: {
  agentIdentifier: string | null;
}): void {
  if (!request.agentIdentifier) {
    throw new Error('Agent identifier is not set');
  }
}

function findTokenUtxo(utxos: UTxO[], agentIdentifier: string): UTxO {
  const tokenUtxo = utxos.find(
    (utxo) =>
      utxo.output.amount.length > 1 &&
      utxo.output.amount.some((asset) => asset.unit == agentIdentifier),
  );
  if (!tokenUtxo) {
    throw new Error('No token UTXO found');
  }
  return tokenUtxo;
}

function sortAndLimitUtxosForDeregistration(utxos: UTxO[]): {
  collateralUtxo: UTxO;
  limitedFilteredUtxos: UTxO[];
} {
  const filteredUtxos = utxos.sort((a, b) => {
    const aLovelace = parseInt(
      a.output.amount.find(
        (asset) =>
          asset.unit == SERVICE_CONSTANTS.CARDANO.NATIVE_TOKEN ||
          asset.unit == '',
      )?.quantity ?? '0',
    );
    const bLovelace = parseInt(
      b.output.amount.find(
        (asset) =>
          asset.unit == SERVICE_CONSTANTS.CARDANO.NATIVE_TOKEN ||
          asset.unit == '',
      )?.quantity ?? '0',
    );
    return bLovelace - aLovelace;
  });

  const collateralUtxo = filteredUtxos[0];

  const limitedFilteredUtxos = filteredUtxos.slice(
    0,
    Math.min(4, filteredUtxos.length),
  );

  return { collateralUtxo, limitedFilteredUtxos };
}

export async function deRegisterAgentV1() {
  let release: MutexInterface.Releaser | null;
  try {
    release = await tryAcquire(mutex).acquire();
  } catch (e) {
    logger.info('Mutex timeout when locking', { error: e });
    return;
  }

  try {
    //Submit a result for invalid tokens
    const paymentSourcesWithWalletLocked = await lockAndQueryRegistryRequests({
      state: RegistrationState.DeregistrationRequested,
    });

    await Promise.allSettled(
      paymentSourcesWithWalletLocked.map(async (paymentSource) => {
        if (paymentSource.RegistryRequest.length == 0) return;

        logger.info(
          `Deregistering ${paymentSource.RegistryRequest.length} agents for payment source ${paymentSource.id}`,
        );
        const network = convertNetwork(paymentSource.network);

        const registryRequests = paymentSource.RegistryRequest;

        if (registryRequests.length == 0) return;

        const blockchainProvider = new BlockfrostProvider(
          paymentSource.PaymentSourceConfig.rpcProviderApiKey,
        );

        const results = await advancedRetryAll({
          errorResolvers: [
            delayErrorResolver({
              configuration: SERVICE_CONSTANTS.RETRY,
            }),
          ],
          operations: registryRequests.map((request) => async () => {
            validateDeregistrationRequest(request);
            const { wallet, utxos, address } = await generateWalletExtended(
              paymentSource.network,
              paymentSource.PaymentSourceConfig.rpcProviderApiKey,
              request.SmartContractWallet.Secret.encryptedMnemonic,
            );

            if (utxos.length === 0) {
              throw new Error('No UTXOs found for the wallet');
            }
            const { script, policyId } =
              await getRegistryScriptFromNetworkHandlerV1(paymentSource);

            const tokenUtxo = findTokenUtxo(utxos, request.agentIdentifier!);

            const { collateralUtxo, limitedFilteredUtxos } =
              sortAndLimitUtxosForDeregistration(utxos);

            const evaluationTx = await generateDeregisterAgentTransaction(
              blockchainProvider,
              network,
              script,
              address,
              policyId,
              request.agentIdentifier!.slice(policyId.length),
              tokenUtxo,
              collateralUtxo,
              limitedFilteredUtxos,
            );
            const estimatedFee = (await blockchainProvider.evaluateTx(
              evaluationTx,
            )) as Array<{ budget: { mem: number; steps: number } }>;
            const unsignedTx = await generateDeregisterAgentTransaction(
              blockchainProvider,
              network,
              script,
              address,
              policyId,
              request.agentIdentifier!.slice(policyId.length),
              tokenUtxo,
              collateralUtxo,
              limitedFilteredUtxos,
              estimatedFee[0].budget,
            );

            const signedTx = await wallet.signTx(unsignedTx);

            await prisma.registryRequest.update({
              where: { id: request.id },
              data: {
                state: RegistrationState.DeregistrationInitiated,
                CurrentTransaction: {
                  create: {
                    txHash: '',
                    status: TransactionStatus.Pending,
                    BlocksWallet: {
                      connect: {
                        id: request.SmartContractWallet.id,
                      },
                    },
                  },
                },
              },
            });

            //submit the transaction to the blockchain
            const newTxHash = await wallet.submitTx(signedTx);
            await prisma.registryRequest.update({
              where: { id: request.id },
              data: {
                CurrentTransaction: {
                  update: {
                    txHash: newTxHash,
                  },
                },
              },
            });

            logger.debug(`Created withdrawal transaction:
                  Tx ID: ${newTxHash}
                  View (after a bit) on https://${
                    network === 'preprod' ? 'preprod.' : ''
                  }cardanoscan.io/transaction/${newTxHash}
              `);
            return true;
          }),
        });
        let index = 0;
        for (const result of results) {
          const request = registryRequests[index];
          if (result.success == false || result.result != true) {
            const error = result.error;
            logger.error(`Error deregistering agent ${request.id}`, {
              error: error,
            });
            await prisma.registryRequest.update({
              where: { id: request.id },
              data: {
                state: RegistrationState.DeregistrationFailed,
                error: convertErrorString(error),
                SmartContractWallet: {
                  update: {
                    lockedAt: null,
                  },
                },
              },
            });
          }
          index++;
        }
      }),
    );
  } catch (error) {
    logger.error('Error submitting result', { error: error });
  } finally {
    release();
  }
}

async function generateDeregisterAgentTransaction(
  blockchainProvider: IFetcher,
  network: Network,
  script: {
    version: LanguageVersion;
    code: string;
  },
  walletAddress: string,
  policyId: string,
  assetName: string,
  assetUtxo: UTxO,
  collateralUtxo: UTxO,
  utxos: UTxO[],
  exUnits: {
    mem: number;
    steps: number;
  } = {
    mem: 7e6,
    steps: 3e9,
  },
) {
  const txBuilder = new MeshTxBuilder({
    fetcher: blockchainProvider,
  });
  const deserializedAddress =
    txBuilder.serializer.deserializer.key.deserializeAddress(walletAddress);
  //setup minting data separately as the minting function does not work well with hex encoded strings without some magic
  txBuilder
    .txIn(assetUtxo.input.txHash, assetUtxo.input.outputIndex)
    .mintPlutusScript(script.version)
    .mint('-1', policyId, assetName)
    .mintingScript(script.code)
    .mintRedeemerValue({ alternative: 1, fields: [] }, 'Mesh', exUnits)
    .txIn(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
    .txInCollateral(
      collateralUtxo.input.txHash,
      collateralUtxo.input.outputIndex,
    )
    .setTotalCollateral('5000000');
  for (const utxo of utxos) {
    txBuilder.txIn(utxo.input.txHash, utxo.input.outputIndex);
  }
  return await txBuilder
    .requiredSignerHash(deserializedAddress.pubKeyHash)
    .setNetwork(network)
    .metadataValue(674, { msg: ['Masumi', 'DeregisterAgent'] })
    .changeAddress(walletAddress)
    .complete();
}
