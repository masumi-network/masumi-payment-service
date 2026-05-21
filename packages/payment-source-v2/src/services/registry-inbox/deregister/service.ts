import { PaymentSourceType, RegistrationState } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import type { BlockfrostProvider as MeshV2BlockfrostProvider, LanguageVersion, UTxO } from '@meshsdk/core';
import { convertNetwork } from '@/utils/converter/network-convert';
import { lockAndQueryInboxAgentRegistrationRequests } from '@/utils/db/lock-and-query-inbox-agent-registration-request';
import { getRegistryScriptFromNetworkHandlerV2 } from '@/utils/generator/contract-generator';
import { SERVICE_CONSTANTS } from '@masumi/payment-core/config';
import { advancedRetry, delayErrorResolver } from 'advanced-retry';
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
	getBurnRedeemerAlternative,
	resolveRegistryDeregistrationWallet,
} from '@/services/registry/shared';
import {
	assertNoCollateralOverlap,
	assertTxSizeWithinLimit,
	pickBatchCollateral,
	shrinkBatchToFit,
} from '../../../builders/batch-helpers';
import {
	type BatchRegistryBurnItem,
	generateRegistryBatchDeregisterTransactionAutomaticFees,
} from '../../../builders/batch-registry';

const REGISTRY_BATCH_SIZE = 7;

const mutex = new Mutex();

type LockedPaymentSource = Awaited<ReturnType<typeof lockAndQueryInboxAgentRegistrationRequests>>[number];
type InboxRequestRecord = LockedPaymentSource['InboxAgentRegistrationRequests'][number];

type ValidatedInboxDeregistrationItem = {
	request: InboxRequestRecord;
	item: BatchRegistryBurnItem;
	deregistrationWalletId: string;
};

function validateDeregistrationRequest(request: { agentIdentifier: string | null }): void {
	if (!request.agentIdentifier) {
		throw new Error('Agent identifier is not set');
	}
}

async function markRequestFailed(request: InboxRequestRecord, error: unknown): Promise<void> {
	const walletToUnlock = request.DeregistrationHotWallet ?? request.SmartContractWallet;
	logger.error(`Error deregistering V2 inbox agent ${request.id}`, { error });
	await prisma.inboxAgentRegistrationRequest.update({
		where: { id: request.id },
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

function validateAndBuildItem(request: InboxRequestRecord, utxos: UTxO[]): ValidatedInboxDeregistrationItem {
	validateDeregistrationRequest(request);
	if (!request.agentIdentifier) {
		throw new Error('Agent identifier is required for deregistration');
	}
	const assetUtxo = findRegistryTokenUtxo(utxos, request.agentIdentifier);
	const assetName = extractAssetName(request.agentIdentifier);
	const deregistrationWallet = resolveRegistryDeregistrationWallet(request);
	return {
		request,
		deregistrationWalletId: deregistrationWallet.id,
		item: { assetName, assetUtxo },
	};
}

async function processSingleDeregistration(
	validated: ValidatedInboxDeregistrationItem,
	paymentSource: LockedPaymentSource,
	network: 'mainnet' | 'preprod',
	script: { version: LanguageVersion; code: string },
	policyId: string,
): Promise<void> {
	const request = validated.request;
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
	const blockchainProvider = await createMeshProvider(paymentSource.PaymentSourceConfig.rpcProviderApiKey);
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
		getBurnRedeemerAlternative(PaymentSourceType.Web3CardanoV2),
		paymentSource.PaymentSourceConfig.rpcProviderApiKey,
	);
	const signedTx = await wallet.signTx(unsignedTx);

	await prisma.inboxAgentRegistrationRequest.update({
		where: { id: request.id },
		data: {
			state: RegistrationState.DeregistrationInitiated,
			...createPendingTransaction(deregistrationWallet.id),
		},
	});

	const newTxHash = await wallet.submitTx(signedTx);
	await walletSession.evaluateProjectedBalance(unsignedTx, limitedFilteredUtxos);
	await prisma.inboxAgentRegistrationRequest.update({
		where: { id: request.id },
		data: updateCurrentTransactionHash(newTxHash),
	});

	logger.debug(`Created V2 inbox deregistration transaction (single-item fallback):
              Tx ID: ${newTxHash}
              View on https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${newTxHash}
          `);
}

export async function deRegisterInboxAgentV2() {
	let release: MutexInterface.Releaser | null;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch (e) {
		logger.info('Mutex timeout when locking V2 inbox deregistrations', { error: e });
		return;
	}

	try {
		const paymentSourcesWithWalletLocked = await lockAndQueryInboxAgentRegistrationRequests({
			state: RegistrationState.DeregistrationRequested,
			maxBatchSize: REGISTRY_BATCH_SIZE,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
		});

		await Promise.allSettled(
			paymentSourcesWithWalletLocked.map(async (paymentSource) => {
				if (paymentSource.InboxAgentRegistrationRequests.length === 0) return;

				logger.info(
					`Deregistering ${paymentSource.InboxAgentRegistrationRequests.length} V2 inbox agents for payment source ${paymentSource.id}`,
				);
				const network = convertNetwork(paymentSource.network);
				const registrationRequests = paymentSource.InboxAgentRegistrationRequests;
				if (registrationRequests.length === 0) return;

				const blockchainProvider = await createMeshProvider(paymentSource.PaymentSourceConfig.rpcProviderApiKey);
				const { script, policyId } = await getRegistryScriptFromNetworkHandlerV2(paymentSource);

				const firstRequest = registrationRequests[0];
				const deregistrationWallet = resolveRegistryDeregistrationWallet(firstRequest);

				let walletSession;
				try {
					walletSession = await loadHotWalletSession({
						network: paymentSource.network,
						rpcProviderApiKey: paymentSource.PaymentSourceConfig.rpcProviderApiKey,
						encryptedMnemonic: deregistrationWallet.Secret.encryptedMnemonic,
						hotWalletId: deregistrationWallet.id,
					});
				} catch (error) {
					logger.error('Failed to load wallet session for V2 inbox deregister batch', { error });
					await Promise.allSettled(registrationRequests.map((request) => markRequestFailed(request, error)));
					return;
				}
				const { wallet, utxos, address } = walletSession;
				if (utxos.length === 0) {
					const error = new Error('No UTXOs found for the wallet');
					await Promise.allSettled(registrationRequests.map((request) => markRequestFailed(request, error)));
					return;
				}

				const validated: ValidatedInboxDeregistrationItem[] = [];
				for (const request of registrationRequests) {
					try {
						validated.push(validateAndBuildItem(request, utxos));
					} catch (error) {
						await markRequestFailed(request, error);
					}
				}

				if (validated.length === 0) {
					logger.info('No V2 inbox deregister requests passed validation this tick');
					await prisma.hotWallet.update({
						where: { id: deregistrationWallet.id, deletedAt: null },
						data: { lockedAt: null },
					});
					return;
				}

				const excludeRefs = validated.map((v) => v.item.assetUtxo.input);
				const collateralUtxo = pickBatchCollateral(utxos, excludeRefs);
				if (collateralUtxo == null) {
					const error = new Error('Collateral UTXO not found');
					logger.warn('V2 inbox deregister batch could not find collateral UTxO; deferring to next tick', {
						error,
					});
					await prisma.hotWallet.update({
						where: { id: deregistrationWallet.id, deletedAt: null },
						data: { lockedAt: null },
					});
					return;
				}

				const assetUtxoKeys = new Set(
					validated.map((v) => `${v.item.assetUtxo.input.txHash}#${v.item.assetUtxo.input.outputIndex}`),
				);
				const collateralUtxoKey = `${collateralUtxo.input.txHash}#${collateralUtxo.input.outputIndex}`;
				const walletUtxos = utxos.filter((utxo) => {
					const key = `${utxo.input.txHash}#${utxo.input.outputIndex}`;
					if (key === collateralUtxoKey) return false;
					if (assetUtxoKeys.has(key)) return false;
					return true;
				});

				const shrinkResult = shrinkBatchToFit(validated, (subset) => {
					try {
						assertNoCollateralOverlap(
							collateralUtxo,
							subset.map((v) => v.item.assetUtxo),
						);
						return { ok: true };
					} catch {
						return { ok: false, reason: 'collateral' };
					}
				});

				if (shrinkResult.fit.length === 0) {
					logger.error('V2 inbox deregister batch could not satisfy collateral non-overlap invariant', {
						reason: shrinkResult.reason,
					});
					await prisma.hotWallet.update({
						where: { id: deregistrationWallet.id, deletedAt: null },
						data: { lockedAt: null },
					});
					return;
				}
				if (shrinkResult.dropped.length > 0) {
					logger.warn(
						`V2 inbox deregister batch shrunk from ${validated.length} to ${shrinkResult.fit.length} (reason=${shrinkResult.reason})`,
					);
				}

				const fit = shrinkResult.fit;
				const items = fit.map((v) => v.item);

				let unsignedTx: string;
				try {
					// V1 mesh `BlockfrostProvider` vs V2 cast — see deregister/service.ts
					// and docs/adr/0005-meshsdk-version-pinning-v1-v2.md.
					unsignedTx = await generateRegistryBatchDeregisterTransactionAutomaticFees(
						blockchainProvider as unknown as MeshV2BlockfrostProvider,
						network,
						script,
						address,
						policyId,
						items,
						collateralUtxo,
						walletUtxos,
						paymentSource.PaymentSourceConfig.rpcProviderApiKey,
					);
					assertTxSizeWithinLimit(unsignedTx, 'v2-inbox-batch-deregister');
				} catch (batchError) {
					logger.warn('V2 inbox deregister batch build failed; falling back to single-item processing', {
						error: batchError,
						batchSize: fit.length,
					});
					await fallbackToSingleItems(fit, paymentSource, network, script, policyId);
					return;
				}

				let signedTx: string;
				try {
					signedTx = await wallet.signTx(unsignedTx);
				} catch (signError) {
					logger.warn('V2 inbox deregister batch sign failed; falling back to single-item processing', {
						error: signError,
					});
					await fallbackToSingleItems(fit, paymentSource, network, script, policyId);
					return;
				}

				try {
					await prisma.$transaction(
						fit.map((v) =>
							prisma.inboxAgentRegistrationRequest.update({
								where: { id: v.request.id },
								data: {
									state: RegistrationState.DeregistrationInitiated,
									...createPendingTransaction(v.deregistrationWalletId),
								},
							}),
						),
					);
				} catch (dbError) {
					logger.error('V2 inbox deregister batch DB pre-submit update failed', { error: dbError });
					await prisma.hotWallet.update({
						where: { id: deregistrationWallet.id, deletedAt: null },
						data: { lockedAt: null },
					});
					return;
				}

				let newTxHash: string;
				try {
					newTxHash = await wallet.submitTx(signedTx);
				} catch (submitError) {
					logger.warn('V2 inbox deregister batch submit failed; rolling back DB and retrying as single items', {
						error: submitError,
					});
					await Promise.allSettled(
						fit.map((v) =>
							prisma.inboxAgentRegistrationRequest.update({
								where: { id: v.request.id },
								data: {
									state: RegistrationState.DeregistrationRequested,
									CurrentTransaction: { disconnect: true },
								},
							}),
						),
					);
					await fallbackToSingleItems(fit, paymentSource, network, script, policyId);
					return;
				}

				try {
					await walletSession.evaluateProjectedBalance(unsignedTx, walletUtxos);
				} catch (balanceError) {
					logger.warn('V2 inbox deregister batch projected balance evaluation failed (non-fatal)', {
						error: balanceError,
					});
				}

				try {
					await prisma.$transaction(
						fit.map((v) =>
							prisma.inboxAgentRegistrationRequest.update({
								where: { id: v.request.id },
								data: updateCurrentTransactionHash(newTxHash),
							}),
						),
					);
				} catch (dbError) {
					logger.error('V2 inbox deregister batch post-submit DB update failed; tx-sync will reconcile next tick', {
						error: dbError,
						txHash: newTxHash,
					});
				}

				logger.debug(`Created V2 inbox deregistration batch transaction:
              Tx ID: ${newTxHash}
              Items: ${fit.length}
              View on https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${newTxHash}
          `);
			}),
		);
	} catch (error) {
		logger.error('Error deregistering V2 inbox agents', { error });
	} finally {
		release();
	}
}

async function fallbackToSingleItems(
	validated: ValidatedInboxDeregistrationItem[],
	paymentSource: LockedPaymentSource,
	network: 'mainnet' | 'preprod',
	script: { version: LanguageVersion; code: string },
	policyId: string,
): Promise<void> {
	const outcomes = await Promise.all(
		validated.map(async (v) => {
			try {
				await advancedRetry({
					errorResolvers: [delayErrorResolver({ configuration: SERVICE_CONSTANTS.RETRY })],
					operation: async () => {
						await processSingleDeregistration(v, paymentSource, network, script, policyId);
						return true;
					},
				});
				return { request: v.request, ok: true as const };
			} catch (error) {
				return { request: v.request, ok: false as const, error };
			}
		}),
	);
	for (const outcome of outcomes) {
		if (!outcome.ok) {
			await markRequestFailed(outcome.request, outcome.error);
		}
	}
}
