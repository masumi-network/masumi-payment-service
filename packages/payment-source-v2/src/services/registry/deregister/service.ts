import { PaymentSourceType, RegistrationState } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import type { BlockfrostProvider as MeshV2BlockfrostProvider, LanguageVersion, UTxO } from '@meshsdk/core';
import { convertNetwork } from '@/utils/converter/network-convert';
import { lockAndQueryRegistryRequests } from '@/utils/db/lock-and-query-registry-request';
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

// V2 registry deregister sizing. Burn legs all share one BurnAction redeemer,
// so per-item cost is dominated by tx-size (each burn pulls in the asset's
// UTxO and emits no continuation output). The cap matches the register side.
const REGISTRY_BATCH_SIZE = 7;

const mutex = new Mutex();

type LockedPaymentSource = Awaited<ReturnType<typeof lockAndQueryRegistryRequests>>[number];
type RegistryRequestRecord = LockedPaymentSource['RegistryRequest'][number];

type ValidatedDeregistrationItem = {
	request: RegistryRequestRecord;
	item: BatchRegistryBurnItem;
	deregistrationWalletId: string;
};

function validateDeregistrationRequest(request: { agentIdentifier: string | null }): void {
	if (!request.agentIdentifier) {
		throw new Error('Agent identifier is not set');
	}
}

async function markRequestFailed(request: RegistryRequestRecord, error: unknown): Promise<void> {
	const walletToUnlock = request.DeregistrationHotWallet ?? request.SmartContractWallet;
	logger.error(`Error deregistering V2 agent ${request.id}`, { error });
	await prisma.registryRequest.update({
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

/**
 * Per-request validation. Locates the asset's UTxO in the wallet and builds
 * the per-item burn payload. Throws on validation failure — caller maps the
 * throw to DeregistrationFailed.
 */
function validateAndBuildItem(request: RegistryRequestRecord, utxos: UTxO[]): ValidatedDeregistrationItem {
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
	validated: ValidatedDeregistrationItem,
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
	await prisma.registryRequest.update({
		where: { id: request.id },
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
	logger.debug(`Created V2 deregister transaction (single-item fallback):
              Tx ID: ${newTxHash}
              View on https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${newTxHash}
          `);
}

export async function deRegisterAgentV2() {
	let release: MutexInterface.Releaser | null;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch (e) {
		logger.info('Mutex timeout when locking', { error: e });
		return;
	}

	try {
		const paymentSourcesWithWalletLocked = await lockAndQueryRegistryRequests({
			state: RegistrationState.DeregistrationRequested,
			maxBatchSize: REGISTRY_BATCH_SIZE,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
		});

		await Promise.allSettled(
			paymentSourcesWithWalletLocked.map(async (paymentSource) => {
				if (paymentSource.RegistryRequest.length == 0) return;
				logger.info(
					`Deregistering ${paymentSource.RegistryRequest.length} V2 agents for payment source ${paymentSource.id}`,
				);
				const network = convertNetwork(paymentSource.network);
				const registryRequests = paymentSource.RegistryRequest;
				if (registryRequests.length == 0) return;

				const blockchainProvider = await createMeshProvider(paymentSource.PaymentSourceConfig.rpcProviderApiKey);
				const { script, policyId } = await getRegistryScriptFromNetworkHandlerV2(paymentSource);

				// All requests in this batch share the same locked hot wallet
				// (either SmartContractWallet for self-deregister, or the
				// DeregistrationHotWallet if set). One wallet session covers
				// the whole batch.
				const firstRequest = registryRequests[0];
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
					logger.error('Failed to load wallet session for V2 deregister batch', { error });
					await Promise.allSettled(registryRequests.map((request) => markRequestFailed(request, error)));
					return;
				}
				const { wallet, utxos, address } = walletSession;
				if (utxos.length === 0) {
					const error = new Error('No UTXOs found for the wallet');
					await Promise.allSettled(registryRequests.map((request) => markRequestFailed(request, error)));
					return;
				}

				// Per-request validation: each item needs its asset UTxO in
				// the wallet. Missing-asset failures become per-item DB
				// failures.
				const validated: ValidatedDeregistrationItem[] = [];
				for (const request of registryRequests) {
					try {
						validated.push(validateAndBuildItem(request, utxos));
					} catch (error) {
						await markRequestFailed(request, error);
					}
				}

				if (validated.length === 0) {
					logger.info('No V2 deregister requests passed validation this tick');
					await prisma.hotWallet.update({
						where: { id: deregistrationWallet.id, deletedAt: null },
						data: { lockedAt: null },
					});
					return;
				}

				// Pick collateral that is NOT the asset-holding UTxO of any
				// item — phase-1 Conway rejects collateral overlap and the
				// asset UTxOs are part of the spending set.
				const excludeRefs = validated.map((v) => v.item.assetUtxo.input);
				const collateralUtxo = pickBatchCollateral(utxos, excludeRefs);
				if (collateralUtxo == null) {
					const error = new Error('Collateral UTXO not found');
					// Without collateral we cannot submit ANY burn this tick.
					// Leave requests in their queued state so the next tick
					// can retry once the wallet has more UTxOs.
					logger.warn('V2 deregister batch could not find collateral UTxO; deferring to next tick', { error });
					await prisma.hotWallet.update({
						where: { id: deregistrationWallet.id, deletedAt: null },
						data: { lockedAt: null },
					});
					return;
				}

				// Filter the wallet UTxOs that flow into the tx (used for fee /
				// change) so the asset-holding UTxOs and the collateral don't
				// appear twice. The batch builder de-dupes internally, but a
				// clean filter keeps the tx body lean.
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

				// Tx-size guard via shrinkBatchToFit. We probe the
				// no-collateral-overlap invariant up front; the actual size
				// check happens after the build pass below.
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
					logger.error('V2 deregister batch could not satisfy collateral non-overlap invariant', {
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
						`V2 deregister batch shrunk from ${validated.length} to ${shrinkResult.fit.length} (reason=${shrinkResult.reason})`,
					);
				}

				const fit = shrinkResult.fit;
				const items = fit.map((v) => v.item);

				let unsignedTx: string;
				try {
					// `createMeshProvider` returns the V1 mesh `BlockfrostProvider`
					// (shared/provider-factory.ts is V1-pinned), but the V2 builder is
					// typed against the V2 mesh `BlockfrostProvider`. Their runtime
					// shapes are identical for the methods we touch (`evaluateTx`,
					// `fetchProtocolParameters`); the type mismatch is purely nominal
					// from TypeScript's private-property check. See
					// docs/adr/0005-meshsdk-version-pinning-v1-v2.md.
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
					assertTxSizeWithinLimit(unsignedTx, 'v2-registry-batch-deregister');
				} catch (batchError) {
					logger.warn('V2 deregister batch build failed; falling back to single-item processing', {
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
					logger.warn('V2 deregister batch sign failed; falling back to single-item processing', {
						error: signError,
					});
					await fallbackToSingleItems(fit, paymentSource, network, script, policyId);
					return;
				}

				try {
					await prisma.$transaction(
						fit.map((v) =>
							prisma.registryRequest.update({
								where: { id: v.request.id },
								data: {
									state: RegistrationState.DeregistrationInitiated,
									...createPendingTransaction(v.deregistrationWalletId),
								},
							}),
						),
					);
				} catch (dbError) {
					logger.error('V2 deregister batch DB pre-submit update failed', { error: dbError });
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
					logger.warn('V2 deregister batch submit failed; rolling back DB and retrying as single items', {
						error: submitError,
					});
					await Promise.allSettled(
						fit.map((v) =>
							prisma.registryRequest.update({
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
					logger.warn('V2 deregister batch projected balance evaluation failed (non-fatal)', {
						error: balanceError,
					});
				}

				try {
					await prisma.$transaction(
						fit.map((v) =>
							prisma.registryRequest.update({
								where: { id: v.request.id },
								data: updateCurrentTransactionHash(newTxHash),
							}),
						),
					);
				} catch (dbError) {
					logger.error('V2 deregister batch post-submit DB update failed; tx-sync will reconcile next tick', {
						error: dbError,
						txHash: newTxHash,
					});
				}

				logger.debug(`Created V2 deregister batch transaction:
              Tx ID: ${newTxHash}
              Items: ${fit.length}
              View on https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${newTxHash}
          `);
			}),
		);
	} catch (error) {
		logger.error('Error deregistering V2 agents', { error });
	} finally {
		release();
	}
}

async function fallbackToSingleItems(
	validated: ValidatedDeregistrationItem[],
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
