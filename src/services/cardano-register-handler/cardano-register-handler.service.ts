import {
  TransactionStatus,
  RegistrationState,
  PricingType,
} from '@prisma/client';
import { Sema } from 'async-sema';
import { prisma } from '@/utils/db';
import { BlockfrostProvider, Transaction } from '@meshsdk/core';
import { logger } from '@/utils/logger';
import { convertNetwork } from '@/utils/converter/network-convert';
import { generateWalletExtended } from '@/utils/generator/wallet-generator';
import { lockAndQueryRegistryRequests } from '@/utils/db/lock-and-query-registry-request';
import { DEFAULTS } from '@/utils/config';
import { getRegistryScriptFromNetworkHandlerV1 } from '@/utils/generator/contract-generator';
import { blake2b } from 'ethereum-cryptography/blake2b';
import { stringToMetadata } from '@/utils/converter/metadata-string-convert';
import { advancedRetryAll, delayErrorResolver } from 'advanced-retry';

const updateMutex = new Sema(1);

export async function registerAgentV1() {
  const acquiredMutex = await updateMutex.tryAcquire();
  //if we are already performing an update, we wait for it to finish and return
  if (!acquiredMutex) return await updateMutex.acquire();

  try {
    //Submit a result for invalid tokens
    const paymentSourcesWithWalletLocked = await lockAndQueryRegistryRequests({
      state: RegistrationState.RegistrationRequested,
    });

    await Promise.allSettled(
      paymentSourcesWithWalletLocked.map(async (paymentSource) => {
        if (paymentSource.RegistryRequest.length == 0) return;

        logger.info(
          `Registering ${paymentSource.RegistryRequest.length} agents for payment source ${paymentSource.id}`,
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
              configuration: {
                maxRetries: 5,
                backoffMultiplier: 5,
                initialDelayMs: 500,
                maxDelayMs: 7500,
              },
            }),
          ],
          operations: registryRequests.map((request) => async () => {
            if (request.Pricing.pricingType != PricingType.Fixed) {
              throw new Error('Other than fixed pricing is not supported yet');
            }
            if (
              request.Pricing.FixedPricing == null ||
              request.Pricing.FixedPricing.Amounts.length == 0
            ) {
              throw new Error('No fixed pricing found, this is likely a bug');
            }
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

            const firstUtxo = utxos[0];
            //utxos = utxos.filter((_, index) => index !== filteredUtxos);

            const txId = firstUtxo.input.txHash;
            const txIndex = firstUtxo.input.outputIndex;
            const serializedOutput =
              txId + txIndex.toString(16).padStart(8, '0');

            const serializedOutputUint8Array = new Uint8Array(
              Buffer.from(serializedOutput.toString(), 'hex'),
            );
            // Hash the serialized output using blake2b_256
            const blake2b256 = blake2b(serializedOutputUint8Array, 32);
            const assetName = Buffer.from(blake2b256).toString('hex');

            const redeemer = {
              data: { alternative: 0, fields: [] },
              tag: 'MINT',
            };

            const tx = new Transaction({
              initiator: wallet,
              fetcher: blockchainProvider,
            })
              .setMetadata(674, {
                msg: ['Masumi', 'RegisterAgent'],
              })
              .setTxInputs([
                //ensure our first utxo hash (serializedOutput) is used as first input
                firstUtxo,
                ...utxos.slice(1),
              ]);

            tx.isCollateralNeeded = true;

            //setup minting data separately as the minting function does not work well with hex encoded strings without some magic
            tx.txBuilder
              .mintPlutusScript(script.version)
              .mint('1', policyId, assetName)
              .mintingScript(script.code)
              .mintRedeemerValue(redeemer.data, 'Mesh');

            //setup the metadata
            tx.setMetadata(721, {
              [policyId]: {
                [assetName]: {
                  name: stringToMetadata(request.name),
                  description: stringToMetadata(request.description),
                  api_base_url: stringToMetadata(request.apiBaseUrl),
                  example_output: request.ExampleOutputs.map(
                    (exampleOutput) => ({
                      name: stringToMetadata(exampleOutput.name),
                      mime_type: stringToMetadata(exampleOutput.mimeType),
                      url: stringToMetadata(exampleOutput.url),
                    }),
                  ),
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
                  agentPricing: {
                    pricingType: request.Pricing.pricingType,
                    fixedPricing:
                      request.Pricing.FixedPricing?.Amounts.map((pricing) => ({
                        unit: stringToMetadata(pricing.unit),
                        amount: pricing.amount.toString(),
                      })) ?? [],
                  },
                  image: stringToMetadata(DEFAULTS.DEFAULT_IMAGE),
                  metadata_version: request.metadataVersion.toString(),
                },
              },
              version: '1',
            });
            //send the minted asset to the address where we want to receive payments
            tx.sendAssets(address, [
              { unit: policyId + assetName, quantity: '1' },
            ]);
            tx.sendLovelace(address, '5000000');
            //sign the transaction with our address
            tx.setChangeAddress(address).setRequiredSigners([address]);
            tx.setNetwork(network);

            //build the transaction
            const unsignedTx = await tx.build();
            const signedTx = await wallet.signTx(unsignedTx, true);

            await prisma.registryRequest.update({
              where: { id: request.id },
              data: {
                state: RegistrationState.RegistrationInitiated,
              },
            });
            //submit the transaction to the blockchain
            const newTxHash = await wallet.submitTx(signedTx);
            await prisma.registryRequest.update({
              where: { id: request.id },
              data: {
                agentIdentifier: policyId + assetName,
                CurrentTransaction: {
                  create: {
                    txHash: newTxHash,
                    status: TransactionStatus.Pending,
                    BlocksWallet: {
                      connect: {
                        id: request.SmartContractWallet!.id,
                      },
                    },
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
            logger.error(`Error registering agent ${request.id}`, {
              error: error,
            });
            await prisma.registryRequest.update({
              where: { id: request.id },
              data: {
                state: RegistrationState.RegistrationFailed,
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
    //library is strange as we can release from any non-acquired semaphore
    updateMutex.release();
  }
}

export const cardanoRegisterHandlerService = { registerAgentV1 };
