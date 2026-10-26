import { PaymentSourceType, RegistrationState } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import type { LanguageVersion } from '@meshsdk/core';
import { describeAmbiguousRegistrySubmit } from '../submit-failure';
import { lockAndQueryRegistryRequests } from '@/utils/db/lock-and-query-registry-request';
import { retryOnSerializationConflict } from '@masumi/payment-core/db-retry';
import { SERVICE_CONSTANTS } from '@masumi/payment-core/config';
import { advancedRetry, delayErrorResolver } from 'advanced-retry';
import { interpretBlockchainError } from '@masumi/payment-core/blockchain-error-interpreter';
import { extractAssetName } from '@/utils/converter/agent-identifier';
import { pickCollateralUtxo, sortAndLimitUtxos } from '@/utils/utxo';
import { createMeshProvider, createPendingTransaction, loadHotWalletSession } from '@/services/shared';
import {
	findRegistryTokenUtxo,
	generateRegistryDeregisterTransactionAutomaticFees,
	getBurnRedeemerAlternative,
	resolveRegistryDeregistrationWallet,
} from '@/services/registry/shared';
import { WALLET_SPLITTER_LOVELACE } from '../../../builders/batch-helpers';
import type { BatchRegistryBurnItem } from '../../../builders/batch-registry';
import { ensureCollateralReady } from '../../wallet-collateral/ensure-collateral-ready';
import {
	MAX_COLLATERAL_PREP_FAILURES,
	recordRegistryPrepFailure,
	resetRegistryPrepFailureCount,
} from '../../wallet-collateral/prep-failure-guard';

export type LockedPaymentSource = Awaited<ReturnType<typeof lockAndQueryRegistryRequests>>[number];
export type RegistryRequestRecord = LockedPaymentSource['RegistryRequest'][number];

export type ValidatedDeregistrationItem = {
	request: RegistryRequestRecord;
	item: BatchRegistryBurnItem;
	deregistrationWalletId: string;
};

/**
 * Terminate a deregister attempt: stamp the failure reason on the request and
 * release the wallet lock so a fresh attempt (or a manual operator action) can
 * proceed.
 *
 * The two writes are intentionally NOT wrapped in a `prisma.$transaction`:
 *
 *  - "Partial failure" here means the first update (request → DeregistrationFailed)
 *    succeeds but the second update (hotWallet.lockedAt = null) throws — e.g.
 *    a Prisma connection drop or a serialization conflict on the wallet row.
 *    The DB ends up with the request marked failed while the wallet stays
 *    locked. Wrapping in a `$transaction` would roll BOTH back on partial
 *    failure, leaving the request in its original `DeregistrationRequested`
 *    state and inviting the worker to retry indefinitely against an error it
 *    just classified as terminal.
 *
 *  - The current shape prefers the "request failure stamped, wallet maybe
 *    still locked" outcome because the wallet is recoverable by the
 *    `wallet-timeouts` service: it sweeps wallets whose `lockedAt < threshold`
 *    AND have no in-flight `PendingTransaction`, and clears the lock. The
 *    operational consequence of partial failure is therefore a delayed
 *    unlock (one wallet-timeouts tick), not stuck state.
 *
 * If both writes succeed (the happy path), the wallet unlocks immediately and
 * the worker picks up the next request on the next scheduler tick.
 */
export async function markRequestFailed(
	request: RegistryRequestRecord,
	error: unknown,
	options: { unlockWallet?: boolean } = {},
): Promise<void> {
	const unlockWallet = options.unlockWallet ?? true;
	logger.error(`Error deregistering V2 agent ${request.id}`, { error });
	await prisma.registryRequest.update({
		where: { id: request.id },
		data: {
			state: RegistrationState.DeregistrationFailed,
			error: interpretBlockchainError(error),
		},
	});
	// Skip the wallet unlock in the per-item validation loop: the shared wallet
	// lock must survive while the batch keeps building the remaining validated
	// items (the terminal paths — all-failed unlock, submit success, batch-bail —
	// free it). Releasing it mid-batch lets a concurrent service grab the wallet
	// and submit a conflicting tx from the same UTxO set.
	if (!unlockWallet) {
		return;
	}
	const walletToUnlock = request.DeregistrationHotWallet ?? request.SmartContractWallet;
	try {
		await prisma.hotWallet.update({
			where: { id: walletToUnlock.id, deletedAt: null },
			data: { lockedAt: null },
		});
	} catch (unlockError) {
		// Intentionally NOT a $transaction with the request update above — see the
		// function-level JSDoc for the full rationale. The operational consequence
		// of this partial failure is that the hot wallet remains locked until the
		// `wallet-timeouts` sweeper next clears stale locks (default ~30 min).
		// Logged at WARN so it shows up in operator dashboards without paging.
		logger.warn(
			'V2 deregister markRequestFailed: request failure stamped but hot wallet unlock failed; wallet may remain locked for up to 30min until wallet-timeouts sweeps',
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

/**
 * Release the hot wallet lock without changing any request state. Used by
 * wallet-level batch-bail paths where every request was waiting on the same
 * wallet — items stay queued for the next scheduler tick instead of being
 * terminated en masse.
 */
export async function unlockHotWallet(hotWalletId: string): Promise<void> {
	try {
		await prisma.hotWallet.update({
			where: { id: hotWalletId, deletedAt: null },
			data: { lockedAt: null },
		});
	} catch (error) {
		logger.warn('Failed to release hot wallet lock after V2 deregister batch bail-out', {
			hotWalletId,
			error,
		});
	}
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
	const collateralCheck = await ensureCollateralReady({
		walletDbId: deregistrationWallet.id,
		walletAddress: address,
		meshWallet: wallet,
		utxos,
		blockchainProvider,
		network,
		serviceLabel: 'registry-deregister-single',
	});
	if (collateralCheck.status === 'failed' && collateralCheck.reason === 'insufficient_funds') {
		// Wallet cannot fund the collateral prep tx for this attempt. Fail with a
		// clear reason (instead of silently deferring forever, which looks like
		// "stuck, nothing happens") so the request lands in *Failed, is visible,
		// and can be retried once the wallet is funded (deregister resets in
		// place via the deregister route; register recreates). markRequestFailed
		// unlocks the wallet on this single-item terminal path.
		const failureMessage = `Wallet balance too low to fund the collateral preparation transaction: ${collateralCheck.details}. Top up the wallet with ADA and retry.`;
		await markRequestFailed(request, new Error(failureMessage));
		return;
	}
	if (collateralCheck.status === 'failed') {
		// reason === 'prep_tx_failed' (transient; wallet already unlocked). Bound
		// the retries so a deterministically-failing prep surfaces as
		// DeregistrationFailed instead of looping forever.
		const reachedLimit = await recordRegistryPrepFailure(request.id);
		if (reachedLimit) {
			await markRequestFailed(
				request,
				new Error(
					`Collateral preparation failed repeatedly (>= ${MAX_COLLATERAL_PREP_FAILURES} attempts): ${collateralCheck.details}. Check the wallet's UTxO set and retry.`,
				),
			);
		}
		return;
	}
	if (collateralCheck.status !== 'ready') {
		// status === 'deferred': a collateral prep tx is in flight; keep the
		// request queued so the next scheduler tick re-picks it up once the prep
		// tx confirms. Clear the outer lockAndQuery `lockedAt` so a confirmed prep
		// (PendingTransaction cleared) is not blocked until wallet-lock timeout.
		const deregistrationWallet = resolveRegistryDeregistrationWallet(request);
		await unlockHotWallet(deregistrationWallet.id);
		return;
	}
	// Collateral ready — clear any transient prep-failure count.
	await resetRegistryPrepFailureCount(request.id);
	if (!request.agentIdentifier) {
		throw new Error('Agent identifier is required for deregistration');
	}
	const tokenUtxo = findRegistryTokenUtxo(utxos, request.agentIdentifier);
	const limitedFilteredUtxos = sortAndLimitUtxos(utxos, 8000000);
	// Rank within the same pool the builder spends from, so the collateral
	// keeps its existing relationship to the inputs while still preferring a
	// pure-ADA, smallest-qualifying, deterministically-ordered UTxO. Falls
	// back to the previous behaviour when nothing clears the 5 ADA floor.
	const collateralUtxo = pickCollateralUtxo(limitedFilteredUtxos) ?? limitedFilteredUtxos[0];
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
		// V2 single-item splitter — see authorize-refund/service.ts.
		WALLET_SPLITTER_LOVELACE,
	);
	const signedTx = await wallet.signTx(unsignedTx);

	// Submit FIRST, then write DB. See register/service.ts single-item
	// path for full rationale. On submit failure there is no orphan
	// Transaction row to clean up, so the catch below only has to stamp the
	// failure and free the wallet.
	let newTxHash: string;
	try {
		newTxHash = await wallet.submitTx(signedTx);
	} catch (error) {
		logger.error('Error submitting V2 deregister single-item tx', { error, requestId: request.id });
		const ambiguous = describeAmbiguousRegistrySubmit(signedTx, error);
		if (ambiguous) {
			logger.warn('Error submitting V2 deregister single-item tx was AMBIGUOUS; the transaction may be on chain', {
				error,
				requestId: request.id,
				intendedTxHash: ambiguous.intendedTxHash,
			});
			await markRequestFailed(request, ambiguous.failure);
			return;
		}
		// Terminal, not a silent re-queue. See the matching comment in
		// `update/service.ts`: reverting to DeregistrationRequested retried a
		// deterministic rejection every tick with `error` left NULL. The batch half
		// of this file already fails the whole set on a submit rejection, and a
		// DeregistrationFailed row records the reason and can be retried in place
		// via the deregister route.
		await markRequestFailed(request, error);
		return;
	}

	await walletSession.evaluateProjectedBalance(unsignedTx, limitedFilteredUtxos);

	await retryOnSerializationConflict(
		() =>
			prisma.registryRequest.update({
				where: { id: request.id },
				data: {
					state: RegistrationState.DeregistrationInitiated,
					...createPendingTransaction(deregistrationWallet.id, newTxHash),
				},
			}),
		{ label: 'v2-deregister-single-post-submit' },
	);
	logger.debug(`Created V2 deregister transaction (single-item fallback):
              Tx ID: ${newTxHash}
              View on https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${newTxHash}
          `);
}

export async function fallbackToSingleItems(
	validated: ValidatedDeregistrationItem[],
	paymentSource: LockedPaymentSource,
	network: 'mainnet' | 'preprod',
	script: { version: LanguageVersion; code: string },
	policyId: string,
): Promise<void> {
	// Process AT MOST ONE item, not all N. Submitting the first item
	// creates a PendingTransaction that locks the hot wallet, so any
	// subsequent item in this tick would just race the wallet lock and
	// fail. The remaining items stay in their queued state — next
	// scheduler tick (after tx-sync clears the lock) re-picks them up
	// and batches them again. The fallback exists purely so a single
	// bad item (invalid datum, asset UTxO missing, etc.) does not block
	// the rest forever; it is NOT a parallel retry path. In the happy
	// path the batch builder above handles everything in one tx and
	// this function never runs.
	if (validated.length === 0) return;
	const v = validated[0];
	try {
		await advancedRetry({
			errorResolvers: [delayErrorResolver({ configuration: SERVICE_CONSTANTS.RETRY })],
			operation: async () => {
				await processSingleDeregistration(v, paymentSource, network, script, policyId);
				return true;
			},
		});
	} catch (error) {
		await markRequestFailed(v.request, error);
	}
	// validated[1..] intentionally left untouched — they remain in
	// their `*Requested` state and the next tick (after the wallet
	// unlocks) will batch them again. Do NOT mark them failed: a batch
	// build failure caused by a transient issue (network blip,
	// cost-model sync race) is not a per-item failure and the items
	// deserve another chance.
}
