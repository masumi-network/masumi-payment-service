import { RegistrationState } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import { BlockfrostProvider, IFetcher, LanguageVersion, MeshTxBuilder, Network, UTxO } from '@meshsdk/core';
import { logger } from '@/utils/logger';
import { convertNetwork } from '@/utils/converter/network-convert';
import {
	lockAndQueryA2ARegistryRequests,
	lockAndQueryRegistryRequests,
} from '@/utils/db/lock-and-query-registry-request';
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

function findTokenUtxo(utxos: UTxO[], agentIdentifier: string): UTxO {
	const tokenUtxo = utxos.find(
		(utxo) => utxo.output.amount.length > 1 && utxo.output.amount.some((asset) => asset.unit == agentIdentifier),
	);
	if (!tokenUtxo) {
		throw new Error('No token UTXO found');
	}
	return tokenUtxo;
}

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
		const [standardSources, a2aSources] = await Promise.all([
			lockAndQueryRegistryRequests({ state: RegistrationState.DeregistrationRequested, maxBatchSize: 1 }),
			lockAndQueryA2ARegistryRequests({ state: RegistrationState.DeregistrationRequested, maxBatchSize: 1 }),
		]);

		await Promise.allSettled([
			...standardSources.map(async (paymentSource) => {
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
					errorResolvers: [delayErrorResolver({ configuration: SERVICE_CONSTANTS.RETRY })],
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
							where: { id: deregistrationRequest.id },
							data: {
								state: RegistrationState.DeregistrationInitiated,
								...createPendingTransaction(deregistrationWallet.id),
							},
						});
						const newTxHash = await wallet.submitTx(signedTx);
						await walletSession.evaluateProjectedBalance(unsignedTx, limitedFilteredUtxos);
						await prisma.registryRequest.update({
							where: { id: request.id },
							data: updateCurrentTransactionHash(newTxHash),
						});
						logger.debug(`Deregistration tx: ${newTxHash}`);
						return true;
					},
				});
				await handlePotentialDeregistrationFailure(result, deregistrationRequest, false);
			}),
			...a2aSources.map(async (paymentSource) => {
				if (paymentSource.A2ARegistryRequest.length == 0) return;
				logger.info(
					`Deregistering ${paymentSource.A2ARegistryRequest.length} A2A agents for payment source ${paymentSource.id}`,
				);
				const network = convertNetwork(paymentSource.network);
				const blockchainProvider = new BlockfrostProvider(paymentSource.PaymentSourceConfig.rpcProviderApiKey);
				const deregistrationRequest = paymentSource.A2ARegistryRequest[0];
				if (deregistrationRequest == null) {
					logger.warn('No A2A agents to deregister');
					return;
				}

				const result = await advancedRetry({
					errorResolvers: [delayErrorResolver({ configuration: SERVICE_CONSTANTS.RETRY })],
					operation: async () => {
						validateDeregistrationRequest(deregistrationRequest);
						const walletSession = await loadHotWalletSession({
							network: paymentSource.network,
							rpcProviderApiKey: paymentSource.PaymentSourceConfig.rpcProviderApiKey,
							encryptedMnemonic: deregistrationRequest.SmartContractWallet.Secret.encryptedMnemonic,
							hotWalletId: deregistrationRequest.SmartContractWallet.id,
						});
						const { wallet, utxos, address } = walletSession;
						if (utxos.length === 0) throw new Error('No UTXOs found for the wallet');
						const { script, policyId } = await getRegistryScriptFromNetworkHandlerV1(paymentSource);
						if (!deregistrationRequest.agentIdentifier)
							throw new Error('Agent identifier is required for deregistration');
						const tokenUtxo = findTokenUtxo(utxos, deregistrationRequest.agentIdentifier);
						const limitedFilteredUtxos = sortAndLimitUtxos(utxos, 8000000);
						const collateralUtxo = limitedFilteredUtxos[0];
						if (collateralUtxo == null) throw new Error('Collateral UTXO not found');
						const assetName = extractAssetName(deregistrationRequest.agentIdentifier);
						const unsignedTx = await generateDeregisterAgentTransactionAutomaticFees(
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
						await prisma.a2ARegistryRequest.update({
							where: { id: deregistrationRequest.id },
							data: {
								state: RegistrationState.DeregistrationInitiated,
								...createPendingTransaction(deregistrationRequest.SmartContractWallet.id),
							},
						});
						const newTxHash = await wallet.submitTx(signedTx);
						await walletSession.evaluateProjectedBalance(unsignedTx, limitedFilteredUtxos);
						await prisma.a2ARegistryRequest.update({
							where: { id: deregistrationRequest.id },
							data: updateCurrentTransactionHash(newTxHash),
						});
						logger.debug(`A2A deregistration tx: ${newTxHash}`);
						return true;
					},
				});
				await handlePotentialDeregistrationFailure(result, deregistrationRequest, true);
			}),
		]);
	} catch (error) {
		logger.error('Error deregistering agent', { error: error });
	} finally {
		release();
	}
}

async function generateDeregisterAgentTransactionAutomaticFees(
	blockchainProvider: BlockfrostProvider,
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
) {
	const evaluationTx = await generateDeregisterAgentTransaction(
		blockchainProvider,
		network,
		script,
		walletAddress,
		policyId,
		assetName,
		assetUtxo,
		collateralUtxo,
		utxos,
	);
	const estimatedFee = (await blockchainProvider.evaluateTx(evaluationTx)) as Array<{
		budget: { mem: number; steps: number };
	}>;
	if (estimatedFee.length === 0) {
		throw new Error('Transaction evaluation returned no budget estimates');
	}
	return await generateDeregisterAgentTransaction(
		blockchainProvider,
		network,
		script,
		walletAddress,
		policyId,
		assetName,
		assetUtxo,
		collateralUtxo,
		utxos,
		estimatedFee[0].budget,
	);
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
	const deserializedAddress = txBuilder.serializer.deserializer.key.deserializeAddress(walletAddress);
	txBuilder
		.txIn(assetUtxo.input.txHash, assetUtxo.input.outputIndex)
		.mintPlutusScript(script.version)
		.mint('-1', policyId, assetName)
		.mintingScript(script.code)
		.mintRedeemerValue({ alternative: 1, fields: [] }, 'Mesh', exUnits)
		.txIn(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
		.txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
		.setTotalCollateral('3000000');
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
