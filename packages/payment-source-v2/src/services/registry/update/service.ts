import { PaymentSourceType, RegistrationState, TransactionStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import type { LanguageVersion, UTxO } from '@meshsdk/core';
import { convertNetwork } from '@/utils/converter/network-convert';
import { lockAndQueryRegistryRequests } from '@/utils/db/lock-and-query-registry-request';
import { retryOnSerializationConflict } from '@/utils/db/retry';
import { SERVICE_CONSTANTS } from '@masumi/payment-core/config';
import { getRegistryScriptFromNetworkHandlerV2 } from '@/utils/generator/contract-generator';
import { advancedRetry, delayErrorResolver } from 'advanced-retry';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { interpretBlockchainError } from '@/utils/errors/blockchain-error-interpreter';
import { extractAssetName, extractPolicyId } from '@/utils/converter/agent-identifier';
import { sortUtxosByLovelaceDesc } from '@/utils/utxo';
import {
	connectExistingTransaction,
	createMeshProvider,
	createPendingTransaction,
	loadHotWalletSession,
} from '@/services/shared';
import {
	bumpRegistryAssetNameVersionV2,
	findRegistryTokenUtxo,
	resolveRegistryDeregistrationWallet,
	resolveRegistryFundingLovelace,
} from '@/services/registry/shared';
import {
	assertTxSizeWithinLimit,
	capRegistryMintFundingLovelace,
	isRegistryTxInputSelectionError,
	pickBatchCollateral,
} from '../../../builders/batch-helpers';
import {
	type BatchRegistryUpdateItem,
	generateRegistryBatchUpdateTransactionAutomaticFees,
} from '../../../builders/batch-registry';
import { ensureCollateralReady } from '../../wallet-collateral/ensure-collateral-ready';
import {
	MAX_COLLATERAL_PREP_FAILURES,
	recordRegistryPrepFailure,
	resetRegistryPrepFailureCount,
} from '../../wallet-collateral/prep-failure-guard';
import { unlockHotWalletIfNoPendingTransaction } from '../../wallet-lock-helpers';
import { asV2Provider } from '../../provider-cast';
import { buildAgentMetadata, validateRegistrationPricing } from '../register/service';
import type { RegistryMetadataPaymentSource } from '@/types/payment-source';

// One UpdateAction tx can atomically burn+remint several assets (see
// smart-contracts/registry-v2/validators/mint.ak). When more than one
// UpdateRequested row shares a holder wallet this tick, processBatchUpdate builds
// a single tx; a lone request takes the proven single-item path.
//
// ENABLED for preprod testing of the batch UpdateAction path. The multi-asset
// burn+mint builder + submit-first service flow have passed code audit but must
// still be exercised on a real node — bounded at 5 (tx-size cap; CIP-25 metadata
// dominates). A lone UpdateRequested still takes the proven single-item path;
// only 2+ same-wallet requests trigger the batch. Verify a live batch update on
// preprod before relying on it in production; drop back to 1 to disable.
const REGISTRY_BATCH_SIZE = 5;

const mutex = new Mutex();

type LockedPaymentSource = Awaited<ReturnType<typeof lockAndQueryRegistryRequests>>[number];
type RegistryRequestRecord = LockedPaymentSource['RegistryRequest'][number];

type ValidatedUpdateItem = {
	request: RegistryRequestRecord;
	newAgentIdentifier: string;
	item: BatchRegistryUpdateItem;
};

async function markRequestFailed(
	request: RegistryRequestRecord,
	error: unknown,
	options: { unlockWallet?: boolean } = {},
): Promise<void> {
	// unlockWallet=true (default) frees the holder wallet — correct for the
	// single-item terminal path and for a whole-batch terminal failure. Pass
	// false for a per-item validation failure inside a batch so the shared wallet
	// lock survives while the remaining validated items keep building.
	const unlockWallet = options.unlockWallet ?? true;
	const walletToUnlock = request.DeregistrationHotWallet ?? request.SmartContractWallet;
	logger.error(`Error updating V2 agent ${request.id}`, { error });
	await prisma.registryRequest.update({
		where: { id: request.id },
		data: {
			state: RegistrationState.UpdateFailed,
			error: interpretBlockchainError(error),
		},
	});
	if (!unlockWallet) {
		return;
	}
	try {
		await prisma.hotWallet.update({
			where: { id: walletToUnlock.id, deletedAt: null },
			data: { lockedAt: null },
		});
	} catch (unlockError) {
		logger.warn(
			'V2 update markRequestFailed: request failure stamped but hot wallet unlock failed; wallet may remain locked for up to 30min until wallet-timeouts sweeps',
			{
				requestId: request.id,
				hotWalletId: walletToUnlock.id,
				error:
					unlockError instanceof Error
						? { message: unlockError.message, stack: unlockError.stack, name: unlockError.name }
						: unlockError,
			},
		);
	}
}

// Validate one UpdateRequested row and turn it into a batch mint/burn item.
// Throws on any per-item problem (bad pricing, policy mismatch, asset no longer
// held by the wallet) so callers can fail just that item and keep the batch.
function buildUpdateItem(
	request: RegistryRequestRecord,
	utxos: UTxO[],
	address: string,
	policyId: string,
	paymentSourceMetadata: RegistryMetadataPaymentSource,
): ValidatedUpdateItem {
	if (!request.agentIdentifier) {
		throw new Error('Agent identifier is required for update');
	}
	validateRegistrationPricing(request);

	const oldAssetName = extractAssetName(request.agentIdentifier);
	const oldPolicyId = extractPolicyId(request.agentIdentifier);
	if (oldPolicyId !== policyId) {
		throw new Error('agentIdentifier policy does not match payment source script');
	}
	const newAssetName = bumpRegistryAssetNameVersionV2(oldAssetName);
	const newAgentIdentifier = policyId + newAssetName;

	// Holder-holds-asset guard (see single-item processUpdate): the asset UTxO
	// must be in the signing wallet or there is nothing to burn+remint.
	const tokenUtxo = findRegistryTokenUtxo(utxos, request.agentIdentifier);
	const metadata = buildAgentMetadata(request, paymentSourceMetadata);
	// Default the version-bumped NFT recipient to the CURRENT HOLDER (the signing
	// wallet), not SmartContractWallet — see the single-item comment.
	const recipientWalletAddress = request.RecipientWallet?.walletAddress ?? address;
	const fundingLovelace = resolveRegistryFundingLovelace(request);

	return {
		request,
		newAgentIdentifier,
		item: {
			oldAssetName,
			newAssetName,
			assetUtxo: tokenUtxo,
			recipientWalletAddress,
			fundingLovelace,
			metadata,
		},
	};
}

async function processUpdate(
	request: RegistryRequestRecord,
	paymentSource: LockedPaymentSource,
	network: 'mainnet' | 'preprod',
	script: { version: LanguageVersion; code: string },
	policyId: string,
): Promise<void> {
	if (!request.agentIdentifier) {
		throw new Error('Agent identifier is required for update');
	}
	validateRegistrationPricing(request);

	const oldPolicyId = extractPolicyId(request.agentIdentifier);
	if (oldPolicyId !== policyId) {
		throw new Error('agentIdentifier policy does not match payment source script');
	}

	const holderWallet = resolveRegistryDeregistrationWallet(request);
	try {
		const walletSession = await loadHotWalletSession({
			network: paymentSource.network,
			rpcProviderApiKey: paymentSource.PaymentSourceConfig.rpcProviderApiKey,
			encryptedMnemonic: holderWallet.Secret.encryptedMnemonic,
			hotWalletId: holderWallet.id,
		});
		const { wallet, utxos, address } = walletSession;
		if (utxos.length === 0) {
			throw new Error('No UTXOs found for the wallet');
		}
		const blockchainProvider = await createMeshProvider(paymentSource.PaymentSourceConfig.rpcProviderApiKey);
		const paymentSourceMetadata: RegistryMetadataPaymentSource = {
			network: paymentSource.network,
			paymentSourceType: paymentSource.paymentSourceType,
			smartContractAddress: paymentSource.smartContractAddress,
		};
		const validated = buildUpdateItem(request, utxos, address, policyId, paymentSourceMetadata);
		const { newAgentIdentifier } = validated;
		const assetInput = validated.item.assetUtxo.input;
		// Holder wallets often consolidate to a single [NFT + ADA] UTxO after
		// registration. Run UTxO prep BEFORE picking collateral — otherwise
		// pickBatchCollateral returns null and we never reach ensureCollateralReady.
		const initialCollateralCheck = await ensureCollateralReady({
			walletDbId: holderWallet.id,
			walletAddress: address,
			meshWallet: wallet,
			utxos,
			blockchainProvider,
			network,
			serviceLabel: 'registry-update',
			excludeSpendingInputsForFeeCheck: [assetInput],
		});
		if (initialCollateralCheck.status === 'failed' && initialCollateralCheck.reason === 'insufficient_funds') {
			const failureMessage = `Wallet balance too low to fund the collateral preparation transaction: ${initialCollateralCheck.details}. Top up the holder wallet with ADA and retry the update.`;
			await markRequestFailed(request, new Error(failureMessage));
			return;
		}
		if (initialCollateralCheck.status === 'failed') {
			const reachedLimit = await recordRegistryPrepFailure(request.id);
			if (reachedLimit) {
				await markRequestFailed(
					request,
					new Error(
						`Collateral preparation failed repeatedly (>= ${MAX_COLLATERAL_PREP_FAILURES} attempts): ${initialCollateralCheck.details}. Check the holder wallet's UTxO set and retry.`,
					),
				);
			}
			return;
		}
		if (initialCollateralCheck.status !== 'ready') {
			logger.info('V2 update deferred while holder wallet UTxO prep is in flight', {
				requestId: request.id,
				holderWalletId: holderWallet.id,
				prepTxHash: initialCollateralCheck.status === 'deferred' ? initialCollateralCheck.prepTxHash : undefined,
			});
			return;
		}
		// Collateral must not overlap the asset UTxO being burned (Conway forbids
		// collateral ∩ inputs).
		const collateralUtxo = pickBatchCollateral(utxos, [assetInput]);
		if (collateralUtxo == null) {
			await markRequestFailed(
				request,
				new Error(
					'Holder wallet has no separate UTxO with ≥5 ADA for collateral after UTxO preparation. Top up the holder wallet with ADA (recommend ≥15 ADA) and retry the update.',
				),
			);
			return;
		}
		const collateralCheck = await ensureCollateralReady({
			walletDbId: holderWallet.id,
			walletAddress: address,
			meshWallet: wallet,
			utxos,
			blockchainProvider,
			network,
			serviceLabel: 'registry-update',
			excludeSpendingInputsForFeeCheck: [assetInput, collateralUtxo.input],
		});
		if (collateralCheck.status === 'failed' && collateralCheck.reason === 'insufficient_funds') {
			// Collateral could not be prepared for this attempt. Fail the request
			// (instead of silently re-deferring in UpdateRequested forever, which
			// looks like "stuck, nothing happens") so the operator sees a clear
			// reason and can fix it and retry — the update endpoint accepts
			// UpdateFailed and re-queues it as UpdateRequested.
			const failureMessage = `Wallet balance too low to fund the collateral preparation transaction: ${collateralCheck.details}. Top up the holder wallet with ADA and retry the update.`;
			await markRequestFailed(request, new Error(failureMessage));
			return;
		}
		if (collateralCheck.status === 'failed') {
			// reason === 'prep_tx_failed' (insufficient_funds handled above): transient
			// prep error. Bound retries so a deterministically-failing prep eventually
			// surfaces as UpdateFailed; otherwise leave the row queued for the next tick.
			const reachedLimit = await recordRegistryPrepFailure(request.id);
			if (reachedLimit) {
				await markRequestFailed(
					request,
					new Error(
						`Collateral preparation failed repeatedly (>= ${MAX_COLLATERAL_PREP_FAILURES} attempts): ${collateralCheck.details}. Check the holder wallet's UTxO set and retry.`,
					),
				);
			}
			return;
		}
		if (collateralCheck.status !== 'ready') {
			// status === 'deferred': a collateral or fee-UTxO prep tx is in flight;
			// keep the row queued so the next scheduler tick re-picks it once the
			// prep tx confirms (mirrors register/deregister single-item).
			logger.info('V2 update deferred while holder wallet UTxO prep is in flight', {
				requestId: request.id,
				holderWalletId: holderWallet.id,
				prepTxHash: collateralCheck.status === 'deferred' ? collateralCheck.prepTxHash : undefined,
			});
			return;
		}
		// Collateral ready — clear any transient prep-failure count so it never
		// slow-accumulates into a false UpdateFailed across many update cycles.
		await resetRegistryPrepFailureCount(request.id);

		validated.item.fundingLovelace = capRegistryMintFundingLovelace(
			utxos,
			collateralUtxo,
			[validated.item.assetUtxo],
			validated.item.fundingLovelace,
		);

		const spendableUtxos = sortUtxosByLovelaceDesc(utxos);

		let unsignedTx: string;
		try {
			unsignedTx = await generateRegistryBatchUpdateTransactionAutomaticFees(
				asV2Provider(blockchainProvider),
				network,
				script,
				address,
				policyId,
				[validated.item],
				collateralUtxo,
				spendableUtxos,
				paymentSource.PaymentSourceConfig.rpcProviderApiKey,
			);
		} catch (buildError) {
			if (isRegistryTxInputSelectionError(buildError)) {
				const message = buildError instanceof Error ? buildError.message : String(buildError);
				await markRequestFailed(
					request,
					new Error(
						`Holder wallet has no UTxO available to pay registry update fees after reserving the NFT input and collateral. ` +
							`Top up the holder wallet with ADA (recommend ≥15 ADA) and retry the update. Original error: ${message}`,
					),
				);
				return;
			}
			throw buildError;
		}
		const signedTx = await wallet.signTx(unsignedTx, true);

		// Submit FIRST, then write DB. Same rationale as
		// register/deregister single-item: on submit failure there is no
		// orphan Transaction row to clean up, and we revert state back to
		// UpdateRequested so the next tick can retry.
		let newTxHash: string;
		try {
			newTxHash = await wallet.submitTx(signedTx);
		} catch (error) {
			logger.error('Error submitting V2 update tx', { error, requestId: request.id });
			await prisma.registryRequest.update({
				where: { id: request.id },
				data: {
					state: RegistrationState.UpdateRequested,
					DeregistrationHotWallet: {
						update: { lockedAt: null },
					},
				},
			});
			return;
		}

		await walletSession.evaluateProjectedBalance(unsignedTx, spendableUtxos);

		// Atomic flip: new asset identifier replaces the old, state advances to
		// UpdateInitiated, shared Tx row is attached. tx-sync then verifies the
		// new asset on chain.
		await retryOnSerializationConflict(
			() =>
				prisma.registryRequest.update({
					where: { id: request.id },
					data: {
						state: RegistrationState.UpdateInitiated,
						agentIdentifier: newAgentIdentifier,
						...createPendingTransaction(holderWallet.id, newTxHash),
					},
				}),
			{ label: 'v2-update-post-submit' },
		);
		logger.debug(`Created V2 update transaction:
              Tx ID: ${newTxHash}
              View on https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${newTxHash}
          `);
	} finally {
		// lockAndQueryRegistryRequests sets lockedAt before we run. Release it
		// whenever this tick did not attach a PendingTransaction (deferred prep,
		// transient prep failure, or throw before post-submit). No-ops when a
		// pending tx is in flight — tx-sync owns that unlock path.
		await unlockHotWalletIfNoPendingTransaction(holderWallet.id, 'registry-update-finally');
	}
}

// Batch several same-wallet UpdateRequested rows into ONE UpdateAction tx that
// burns every old asset and mints its version-bumped replacement. Mirrors the
// register batch flow: per-item validation failures are stamped (keeping the
// shared lock), a shared Transaction is created and every request flipped to
// UpdateInitiated BEFORE submit, and a submit rejection rolls the whole batch
// back to UpdateFailed (reverting the optimistic agentIdentifier flip). A
// build/sign failure fails the batch (each row is retriable via the update
// route). No partial success: the on-chain UpdateAction is atomic.
async function processBatchUpdate(
	requests: RegistryRequestRecord[],
	paymentSource: LockedPaymentSource,
	network: 'mainnet' | 'preprod',
	script: { version: LanguageVersion; code: string },
	policyId: string,
): Promise<void> {
	const holderWallet = resolveRegistryDeregistrationWallet(requests[0]);
	const rpcApiKey = paymentSource.PaymentSourceConfig.rpcProviderApiKey;
	const walletSession = await loadHotWalletSession({
		network: paymentSource.network,
		rpcProviderApiKey: rpcApiKey,
		encryptedMnemonic: holderWallet.Secret.encryptedMnemonic,
		hotWalletId: holderWallet.id,
	});
	const { wallet, utxos, address } = walletSession;
	if (utxos.length === 0) {
		// Transient: leave the whole batch queued (all shared this wallet).
		await unlockHotWalletIfNoPendingTransaction(holderWallet.id, 'registry-update-batch');
		return;
	}
	const blockchainProvider = await createMeshProvider(rpcApiKey);

	const paymentSourceMetadata: RegistryMetadataPaymentSource = {
		network: paymentSource.network,
		paymentSourceType: paymentSource.paymentSourceType,
		smartContractAddress: paymentSource.smartContractAddress,
	};

	const validated: ValidatedUpdateItem[] = [];
	for (const request of requests) {
		try {
			validated.push(buildUpdateItem(request, utxos, address, policyId, paymentSourceMetadata));
		} catch (validationError) {
			// Mid-batch: keep the shared wallet lock so the remaining items can build.
			await markRequestFailed(request, validationError, { unlockWallet: false });
		}
	}
	if (validated.length === 0) {
		await unlockHotWalletIfNoPendingTransaction(holderWallet.id, 'registry-update-batch');
		return;
	}

	const assetInputs = validated.map((v) => v.item.assetUtxo.input);
	const initialCollateralCheck = await ensureCollateralReady({
		walletDbId: holderWallet.id,
		walletAddress: address,
		meshWallet: wallet,
		utxos,
		blockchainProvider,
		network,
		serviceLabel: 'registry-update-batch',
		excludeSpendingInputsForFeeCheck: assetInputs,
	});
	if (initialCollateralCheck.status === 'failed' && initialCollateralCheck.reason === 'insufficient_funds') {
		const failureMessage = `Wallet balance too low to fund the collateral preparation transaction: ${initialCollateralCheck.details}. Top up the holder wallet with ADA and retry the update.`;
		await Promise.allSettled(requests.map((request) => markRequestFailed(request, new Error(failureMessage))));
		return;
	}
	if (initialCollateralCheck.status === 'failed') {
		await Promise.allSettled(
			requests.map(async (request) => {
				const reachedLimit = await recordRegistryPrepFailure(request.id);
				if (reachedLimit) {
					await markRequestFailed(
						request,
						new Error(
							`Collateral preparation failed repeatedly (>= ${MAX_COLLATERAL_PREP_FAILURES} attempts): ${initialCollateralCheck.details}. Check the holder wallet's UTxO set and retry.`,
						),
					);
				}
			}),
		);
		return;
	}
	if (initialCollateralCheck.status !== 'ready') {
		logger.info('V2 update batch deferred while holder wallet UTxO prep is in flight', {
			requestIds: validated.map((v) => v.request.id),
			holderWalletId: holderWallet.id,
			prepTxHash: initialCollateralCheck.status === 'deferred' ? initialCollateralCheck.prepTxHash : undefined,
		});
		return;
	}

	const collateralUtxo = pickBatchCollateral(utxos, assetInputs);
	if (collateralUtxo == null) {
		const failureMessage =
			'Holder wallet has no separate UTxO with ≥5 ADA for collateral after UTxO preparation. Top up the holder wallet with ADA (recommend ≥15 ADA) and retry the update.';
		await Promise.allSettled(validated.map((v) => markRequestFailed(v.request, new Error(failureMessage))));
		return;
	}

	const collateralCheck = await ensureCollateralReady({
		walletDbId: holderWallet.id,
		walletAddress: address,
		meshWallet: wallet,
		utxos,
		blockchainProvider,
		network,
		serviceLabel: 'registry-update-batch',
		excludeSpendingInputsForFeeCheck: [...assetInputs, collateralUtxo.input],
	});
	if (collateralCheck.status === 'failed' && collateralCheck.reason === 'insufficient_funds') {
		// Shared-wallet funding problem — fail every item with a clear reason so
		// they surface as UpdateFailed (retriable) instead of silently deferring.
		const failureMessage = `Wallet balance too low to fund the collateral preparation transaction: ${collateralCheck.details}. Top up the holder wallet with ADA and retry the update.`;
		await Promise.allSettled(requests.map((request) => markRequestFailed(request, new Error(failureMessage))));
		return;
	}
	if (collateralCheck.status === 'failed') {
		// reason === 'prep_tx_failed' (transient; wallet already unlocked). Bound
		// per-request retries so a deterministically-failing prep surfaces as
		// UpdateFailed instead of looping forever; the whole batch shares this
		// wallet, so every item saw the same failure this tick.
		await Promise.allSettled(
			requests.map(async (request) => {
				const reachedLimit = await recordRegistryPrepFailure(request.id);
				if (reachedLimit) {
					await markRequestFailed(
						request,
						new Error(
							`Collateral preparation failed repeatedly (>= ${MAX_COLLATERAL_PREP_FAILURES} attempts): ${collateralCheck.details}. Check the holder wallet's UTxO set and retry.`,
						),
					);
				}
			}),
		);
		return;
	}
	if (collateralCheck.status !== 'ready') {
		// deferred: a collateral or fee-UTxO prep tx is in flight; the whole batch stays queued.
		logger.info('V2 update batch deferred while holder wallet UTxO prep is in flight', {
			requestIds: validated.map((v) => v.request.id),
			holderWalletId: holderWallet.id,
			prepTxHash: collateralCheck.status === 'deferred' ? collateralCheck.prepTxHash : undefined,
		});
		return;
	}
	// Collateral ready — clear any transient prep-failure count on every item.
	await Promise.allSettled(requests.map((request) => resetRegistryPrepFailureCount(request.id)));

	for (const entry of validated) {
		entry.item.fundingLovelace = capRegistryMintFundingLovelace(
			utxos,
			collateralUtxo,
			validated.map((v) => v.item.assetUtxo),
			entry.item.fundingLovelace,
		);
	}

	const items = validated.map((v) => v.item);
	const spendableUtxos = sortUtxosByLovelaceDesc(utxos);

	let unsignedTx: string;
	try {
		unsignedTx = await generateRegistryBatchUpdateTransactionAutomaticFees(
			asV2Provider(blockchainProvider),
			network,
			script,
			address,
			policyId,
			items,
			collateralUtxo,
			spendableUtxos,
			rpcApiKey,
		);
		assertTxSizeWithinLimit(unsignedTx, 'v2-registry-batch-update');
	} catch (buildError) {
		if (isRegistryTxInputSelectionError(buildError)) {
			const message = buildError instanceof Error ? buildError.message : String(buildError);
			const failure = new Error(
				`Holder wallet has no UTxO available to pay registry update fees after reserving NFT inputs and collateral. ` +
					`Top up the holder wallet with ADA (recommend ≥15 ADA) and retry the update. Original error: ${message}`,
			);
			await Promise.allSettled(validated.map((v) => markRequestFailed(v.request, failure)));
			return;
		}
		logger.error('V2 update batch build failed; marking batch failed [batch-fallback]', {
			error: buildError instanceof Error ? { message: buildError.message, name: buildError.name } : buildError,
			batchSize: validated.length,
		});
		await Promise.allSettled(validated.map((v) => markRequestFailed(v.request, buildError)));
		return;
	}

	let signedTx: string;
	try {
		signedTx = await wallet.signTx(unsignedTx, true);
	} catch (signError) {
		logger.error('V2 update batch sign failed; marking batch failed [batch-fallback]', {
			error: signError instanceof Error ? { message: signError.message, name: signError.name } : signError,
			batchSize: validated.length,
		});
		await Promise.allSettled(validated.map((v) => markRequestFailed(v.request, signError)));
		return;
	}

	// Submit FIRST, then write DB — mirrors the single-item ordering and avoids a
	// pre-submit "flip identifier before submit" window where a DB commit that then
	// throws client-side would strand rows at the bumped (never-minted) identifier.
	let newTxHash: string;
	try {
		newTxHash = await wallet.submitTx(signedTx);
	} catch (submitError) {
		logger.error('V2 update batch submit failed; marking batch failed [batch-fallback]', {
			error: submitError instanceof Error ? { message: submitError.message, name: submitError.name } : submitError,
			batchSize: validated.length,
		});
		// Nothing was flipped and the tx never landed — fail every item. Their
		// agentIdentifier is still the OLD on-chain value, so each row stays
		// retriable via the update route.
		await Promise.allSettled(validated.map((v) => markRequestFailed(v.request, submitError)));
		return;
	}

	// Post-submit: ONE shared Transaction carrying the txHash + holder wallet, and
	// every item flipped to UpdateInitiated with its NEW identifier, connected to
	// that shared Tx. txHash is written atomically with the flip so tx-sync can
	// track it. If THIS write throws, the tx is already on chain: the rows stay
	// UpdateRequested and the wallet locked (no PendingTransaction), so the
	// stale-lock reaper frees the wallet and the next tick re-picks and self-
	// corrects (the old assets are burned on chain, so validation fails to
	// UpdateFailed rather than re-minting).
	try {
		await retryOnSerializationConflict(
			() =>
				prisma.$transaction(
					async (tx) => {
						const sharedTx = await tx.transaction.create({
							data: {
								txHash: newTxHash,
								status: TransactionStatus.Pending,
								lastCheckedAt: new Date(),
								BlocksWallet: { connect: { id: holderWallet.id } },
							},
						});
						for (const v of validated) {
							await tx.registryRequest.update({
								where: { id: v.request.id },
								data: {
									state: RegistrationState.UpdateInitiated,
									agentIdentifier: v.newAgentIdentifier,
									...connectExistingTransaction(sharedTx.id),
								},
							});
						}
					},
					{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
				),
			{ label: 'v2-update-batch-post-submit' },
		);
	} catch (dbError) {
		logger.error(
			'V2 update batch submitted but post-submit DB write failed; wallet-timeouts + next-tick re-pick will reconcile',
			{ error: dbError, txHash: newTxHash, requestIds: validated.map((v) => v.request.id) },
		);
		return;
	}

	logger.debug(`Created V2 batch update transaction for ${validated.length} agents:
              Tx ID: ${newTxHash}
              View on https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${newTxHash}
          `);
}

export async function updateAgentV2() {
	let release: MutexInterface.Releaser | null;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch (e) {
		logger.info('Mutex timeout when locking', { error: e });
		return;
	}

	try {
		const paymentSourcesWithWalletLocked = await lockAndQueryRegistryRequests({
			state: RegistrationState.UpdateRequested,
			maxBatchSize: REGISTRY_BATCH_SIZE,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
		});

		await Promise.allSettled(
			paymentSourcesWithWalletLocked.map(async (paymentSource) => {
				const requests = paymentSource.RegistryRequest;
				if (requests.length === 0) return;
				// Holder wallet shared by this tick's requests (lockAndQueryRegistryRequests
				// locks one wallet per source). lockedAt is already set; the catch below
				// releases it on any unexpected pre-submit throw (script derivation,
				// wallet-session load, provider/cost-model sync) so the wallet is not
				// wedged until the stale-lock reaper sweeps it ~WALLET_LOCK_TIMEOUT_INTERVAL
				// later — matching the register/deregister batch guard.
				const lockedWalletId = resolveRegistryDeregistrationWallet(requests[0]).id;
				try {
					logger.info(`Updating ${requests.length} V2 agent registrations for payment source ${paymentSource.id}`);
					const network = convertNetwork(paymentSource.network);
					const { script, policyId } = await getRegistryScriptFromNetworkHandlerV2(paymentSource);

					// A lone request uses the proven single-item path (also cheaper — no
					// shared-Tx bookkeeping). Multiple same-wallet requests batch into one
					// atomic UpdateAction tx.
					if (requests.length === 1) {
						const request = requests[0];
						try {
							const retryResult = await advancedRetry({
								errorResolvers: [delayErrorResolver({ configuration: SERVICE_CONSTANTS.RETRY })],
								throwOnUnrecoveredError: true,
								operation: async () => {
									await processUpdate(request, paymentSource, network, script, policyId);
									return true;
								},
							});
							if (retryResult.success === false) {
								await markRequestFailed(request, retryResult.error);
							}
						} catch (error) {
							await markRequestFailed(request, error);
						}
						return;
					}

					await processBatchUpdate(requests, paymentSource, network, script, policyId);
				} catch (unexpectedError) {
					logger.error('V2 update tick threw unexpectedly; releasing wallet lock [batch-fallback]', {
						paymentSourceId: paymentSource.id,
						hotWalletId: lockedWalletId,
						error:
							unexpectedError instanceof Error
								? { message: unexpectedError.message, stack: unexpectedError.stack, name: unexpectedError.name }
								: unexpectedError,
					});
					// Guarded: clears lockedAt only when no pending tx is attached, so a
					// wallet that already broadcast a tx is left for tx-sync.
					await unlockHotWalletIfNoPendingTransaction(lockedWalletId, 'registry-update');
				}
			}),
		);
	} catch (error) {
		logger.error('Error updating V2 agent registrations', { error });
	} finally {
		release?.();
	}
}
