import {
  TransactionStatus,
  RegistrationState,
  PricingType,
} from '@/generated/prisma/client';
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
import { DEFAULTS, SERVICE_CONSTANTS } from '@/utils/config';
import { getRegistryScriptFromNetworkHandlerV1 } from '@/utils/generator/contract-generator';
import { blake2b } from 'ethereum-cryptography/blake2b';
import { stringToMetadata } from '@/utils/converter/metadata-string-convert';
import { advancedRetryAll, delayErrorResolver } from 'advanced-retry';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { errorToString } from '@/utils/converter/error-string-convert';
import { sortUtxosByLovelaceDesc } from '@/utils/utxo';

const mutex = new Mutex();

function validateRegistrationPricing(request: {
  Pricing: {
    pricingType: PricingType;
    FixedPricing: { Amounts: Array<{ [key: string]: unknown }> } | null;
  };
}): void {
  if (
    request.Pricing.pricingType != PricingType.Fixed &&
    request.Pricing.pricingType != PricingType.Free
  ) {
    throw new Error('Other than fixed and free pricing is not supported yet');
  }

  if (
    request.Pricing.pricingType == PricingType.Fixed &&
    (request.Pricing.FixedPricing == null ||
      request.Pricing.FixedPricing.Amounts.length == 0)
  ) {
    throw new Error('No fixed pricing found, this is likely a bug');
  }

  if (
    request.Pricing.pricingType == PricingType.Free &&
    request.Pricing.FixedPricing != null
  ) {
    throw new Error('Free pricing requires no fixed pricing to be set');
  }
}

function generateAssetName(firstUtxo: UTxO): string {
  const txId = firstUtxo.input.txHash;
  const txIndex = firstUtxo.input.outputIndex;
  const serializedOutput = txId + txIndex.toString(16).padStart(8, '0');

  const serializedOutputUint8Array = new Uint8Array(
    Buffer.from(serializedOutput.toString(), 'hex'),
  );
  // Hash the serialized output using blake2b_256
  const blake2b256 = blake2b(serializedOutputUint8Array, 32);
  return Buffer.from(blake2b256).toString('hex');
}

function buildAgentMetadata(request: {
  name: string;
  description: string | null;
  apiBaseUrl: string | null;
  ExampleOutputs: Array<{ name: string; mimeType: string; url: string }>;
  capabilityName?: string | null;
  capabilityVersion?: string | null;
  authorName: string | null;
  authorContactEmail: string | null;
  authorContactOther: string | null;
  authorOrganization: string | null;
  privacyPolicy: string | null;
  terms: string | null;
  other: string | null;
  tags: string[];
  Pricing: {
    pricingType: PricingType;
    FixedPricing?: {
      Amounts: Array<{ unit: string; amount: bigint; [key: string]: unknown }>;
    } | null;
  };
  metadataVersion: number;
}): AgentMetadata {
  return {
    name: stringToMetadata(request.name),
    description: stringToMetadata(request.description),
    api_base_url: stringToMetadata(request.apiBaseUrl),
    example_output: request.ExampleOutputs.map((exampleOutput) => ({
      name: stringToMetadata(exampleOutput.name),
      mime_type: stringToMetadata(exampleOutput.mimeType),
      url: stringToMetadata(exampleOutput.url),
    })),
    capability:
      request.capabilityName && request.capabilityVersion
        ? {
            name: stringToMetadata(request.capabilityName),
            version: stringToMetadata(request.capabilityVersion),
          }
        : undefined,
    author: {
      name: stringToMetadata(request.authorName),
      contact_email: stringToMetadata(request.authorContactEmail),
      contact_other: stringToMetadata(request.authorContactOther),
      organization: stringToMetadata(request.authorOrganization),
    },
    legal: {
      privacy_policy: stringToMetadata(request.privacyPolicy),
      terms: stringToMetadata(request.terms),
      other: stringToMetadata(request.other),
    },
    tags: request.tags,
    agentPricing:
      request.Pricing.pricingType == PricingType.Fixed
        ? {
            pricingType: PricingType.Fixed,
            fixedPricing:
              request.Pricing.FixedPricing?.Amounts.map((pricing) => ({
                unit: stringToMetadata(pricing.unit),
                amount: pricing.amount.toString(),
              })) ?? [],
          }
        : {
            pricingType: PricingType.Free,
          },
    image: stringToMetadata(DEFAULTS.DEFAULT_IMAGE),
    metadata_version: request.metadataVersion.toString(),
  };
}

export async function registerAgentV1() {
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
      state: RegistrationState.RegistrationRequested,
      maxBatchSize: 1,
    });

    await Promise.allSettled(
      paymentSourcesWithWalletLocked.map(async (paymentSource) => {
        if (paymentSource.RegistryRequest.length === 0) return;

        logger.info(
          `Registering ${paymentSource.RegistryRequest.length} agents for payment source ${paymentSource.id}`,
        );

        const network = convertNetwork(paymentSource.network);

        const registryRequests = paymentSource.RegistryRequest;

        if (registryRequests.length === 0) return;

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
            validateRegistrationPricing(request);
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

            const limitedFilteredUtxos = sortUtxosByLovelaceDesc(utxos);

            const firstUtxo = limitedFilteredUtxos[0];
            const collateralUtxo = limitedFilteredUtxos[0];

            const assetName = generateAssetName(firstUtxo);
            const metadata = buildAgentMetadata(request);
            const evaluationTx = await generateRegisterAgentTransaction(
              blockchainProvider,
              network,
              script,
              address,
              policyId,
              assetName,
              firstUtxo,
              collateralUtxo,
              limitedFilteredUtxos,
              metadata,
            );
            const estimatedFee = (await blockchainProvider.evaluateTx(
              evaluationTx,
            )) as Array<{ budget: { mem: number; steps: number } }>;

            const unsignedTx = await generateRegisterAgentTransaction(
              blockchainProvider,
              network,
              script,
              address,
              policyId,
              assetName,
              firstUtxo,
              collateralUtxo,
              limitedFilteredUtxos,
              metadata,
              estimatedFee[0].budget,
            );

            const signedTx = await wallet.signTx(unsignedTx, true);

            await prisma.registryRequest.update({
              where: { id: request.id },
              data: {
                state: RegistrationState.RegistrationInitiated,
                CurrentTransaction: {
                  create: {
                    txHash: null,
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
                agentIdentifier: policyId + assetName,
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
          if (result.success === false || result.result !== true) {
            const error = result.error;
            logger.error(`Error registering agent ${request.id}`, {
              error: error,
            });
            await prisma.registryRequest.update({
              where: { id: request.id },
              data: {
                state: RegistrationState.RegistrationFailed,
                error: errorToString(error),
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

type AgentMetadata = {
  [key: string]:
    | string
    | string[]
    | AgentMetadata
    | AgentMetadata[]
    | undefined;
};

async function generateRegisterAgentTransaction(
  blockchainProvider: IFetcher,
  network: Network,
  script: {
    version: LanguageVersion;
    code: string;
  },
  walletAddress: string,
  policyId: string,
  assetName: string,
  firstUtxo: UTxO,
  collateralUtxo: UTxO,
  utxos: UTxO[],
  metadata: AgentMetadata,
  exUnits: {
    mem: number;
    steps: number;
  } = SERVICE_CONSTANTS.SMART_CONTRACT.defaultExUnits,
) {
  const txBuilder = new MeshTxBuilder({
    fetcher: blockchainProvider,
  });
  const deserializedAddress =
    txBuilder.serializer.deserializer.key.deserializeAddress(walletAddress);
  //setup minting data separately as the minting function does not work well with hex encoded strings without some magic
  txBuilder
    .txIn(firstUtxo.input.txHash, firstUtxo.input.outputIndex)
    .mintPlutusScript(script.version)
    .mint('1', policyId, assetName)
    .mintingScript(script.code)
    .mintRedeemerValue({ alternative: 0, fields: [] }, 'Mesh', exUnits)
    .metadataValue(SERVICE_CONSTANTS.METADATA.nftLabel, {
      [policyId]: {
        [assetName]: metadata,
      },
      version: '1',
    })
    .txIn(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
    .txInCollateral(
      collateralUtxo.input.txHash,
      collateralUtxo.input.outputIndex,
    )
    .setTotalCollateral(SERVICE_CONSTANTS.SMART_CONTRACT.collateralAmount)
    .txOut(walletAddress, [
      {
        unit: policyId + assetName,
        quantity: SERVICE_CONSTANTS.SMART_CONTRACT.mintQuantity,
      },
      {
        unit: SERVICE_CONSTANTS.CARDANO.NATIVE_TOKEN,
        quantity: SERVICE_CONSTANTS.SMART_CONTRACT.collateralAmount,
      },
    ]);
  for (const utxo of utxos) {
    txBuilder.txIn(utxo.input.txHash, utxo.input.outputIndex);
  }
  return await txBuilder
    .requiredSignerHash(deserializedAddress.pubKeyHash)
    .setNetwork(network)
    .metadataValue(SERVICE_CONSTANTS.METADATA.masumiLabel, {
      msg: ['Masumi', 'RegisterAgent'],
    })
    .changeAddress(walletAddress)
    .complete();
}
