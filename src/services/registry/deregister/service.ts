import { RegistrationState } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import { logger } from '@/utils/logger';
import { convertNetwork } from '@/utils/converter/network-convert';
import { lockAndQueryRegistryRequests } from '@/utils/db/lock-and-query-registry-request';
import { getRegistryScriptFromNetworkHandlerV1 } from '@/utils/generator/contract-generator';
import { SERVICE_CONSTANTS } from '@/utils/config';
import { advancedRetry, delayErrorResolver, RetryResult } from 'advanced-retry';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { interpretBlockchainError } from '@/utils/errors/blockchain-error-interpreter';
import { extractAssetName } from '@/utils/converter/agent-identifier';
import { sortAndLimitUtxos } from '@/utils/utxo';
import {
	createMeshProvider,
	createPendingTransaction,
	loadHotWalletSession,
	updateCurrentTransactionHash,
} from '@/services/shared';
import {
	findRegistryTokenUtxo,
	generateRegistryDeregisterTransactionAutomaticFees,
	resolveRegistryDeregistrationWallet,
} from '../shared';

const mutex = new Mutex();

function validateDeregistrationRequest(request: { agentIdentifier: string | null }): void {
	if (!request.agentIdentifier) {
		throw new Error('Agent identifier is not set');
	}
}

async function handlePotentialDeregistrationFailure(
	result: RetryResult<boolean>,
	registryRequest: {
		id: string;
		SmartContractWallet: { id: string };
		DeregistrationHotWallet: { id: string } | null;
	},
): Promise<void> {
	if (result.success !== true || result.result !== true) {
		const error = result.error;
		const walletToUnlock = registryRequest.DeregistrationHotWallet ?? registryRequest.SmartContractWallet;
		logger.error(`Error deregistering agent ${registryRequest.id}`, {
			error: error,
		});
		await prisma.registryRequest.update({
			where: { id: registryRequest.id },
			data: {
				state: RegistrationState.DeregistrationFailed,
				error: interpretBlockchainError(error),
			},
		});
		await prisma.hotWallet.update({
			where: { id: walletToUnlock.id, deletedAt: null },
			data: { lockedAt: null },
		});
	}
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
			maxBatchSize: 1,
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

				const blockchainProvider = createMeshProvider(paymentSource.PaymentSourceConfig.rpcProviderApiKey);

				//we can only deregister one agent at a time
				const deregistrationRequest = registryRequests[0];
				if (deregistrationRequest == null) {
					logger.warn('No agents to deregister');
					return;
				}
				const result = await advancedRetry({
					errorResolvers: [
						delayErrorResolver({
							configuration: SERVICE_CONSTANTS.RETRY,
						}),
					],
					operation: async () => {
						const request = deregistrationRequest;
						validateDeregistrationRequest(request);
						const deregistrationWallet = resolveRegistryDeregistrationWallet(request);
						const walletSession = await loadHotWalletSession({
							network: paymentSource.network,
							rpcProviderApiKey: paymentSource.PaymentSourceConfig.rpcProviderApiKey,
							encryptedMnemonic: deregistrationWallet.Secret.encryptedMnemonic,
							hotWalletId: deregistrationWallet.id,
						});
						const { wallet, utxos, address } = walletSession;

						if (utxos.length === 0) {
							throw new Error('No UTXOs found for the wallet');
						}
						const { script, policyId } = await getRegistryScriptFromNetworkHandlerV1(paymentSource);

						if (!request.agentIdentifier) {
							throw new Error('Agent identifier is required for deregistration');
						}

						const tokenUtxo = findRegistryTokenUtxo(utxos, request.agentIdentifier);

						const limitedFilteredUtxos = sortAndLimitUtxos(utxos, 8000000);
						const collateralUtxo = limitedFilteredUtxos[0];
						if (collateralUtxo == null) {
							throw new Error('Collateral UTXO not found');
						}

						const assetName = extractAssetName(request.agentIdentifier);

						const unsignedTx = await generateRegistryDeregisterTransactionAutomaticFees(
							blockchainProvider,
							network,
							script,
							address,
							policyId,
							assetName,
							tokenUtxo,
							collateralUtxo,
							limitedFilteredUtxos,
						);

						const signedTx = await wallet.signTx(unsignedTx);

						await prisma.registryRequest.update({
							where: { id: request.id },
							data: {
								state: RegistrationState.DeregistrationInitiated,
								...createPendingTransaction(deregistrationWallet.id),
							},
						});

						//submit the transaction to the blockchain
						const newTxHash = await wallet.submitTx(signedTx);
						await walletSession.evaluateProjectedBalance(unsignedTx, limitedFilteredUtxos);
						await prisma.registryRequest.update({
							where: { id: request.id },
							data: updateCurrentTransactionHash(newTxHash),
						});

						logger.debug(`Created withdrawal transaction:
                  Tx ID: ${newTxHash}
                  View (after a bit) on https://${
										network === 'preprod' ? 'preprod.' : ''
									}cardanoscan.io/transaction/${newTxHash}
              `);
						return true;
					},
				});
				await handlePotentialDeregistrationFailure(result, deregistrationRequest);
			}),
		);
	} catch (error) {
		logger.error('Error deregistering agent', { error: error });
	} finally {
		release();
	}
}
