import {
	PaymentAction,
	PaymentErrorType,
	PaymentSourceType,
	Prisma,
	TransactionStatus,
} from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { deserializeDatum, UTxO } from '@meshsdk/core';
import type { BlockfrostProvider as MeshV2BlockfrostProvider, LanguageVersion } from '@meshsdk/core';
import type { BlockfrostProvider } from '@/services/shared';
import { logger } from '@masumi/payment-core/logger';
import { SmartContractState, smartContractStateEqualsOnChainState } from '@/utils/generator/contract-generator';
import { convertNetwork } from '@/utils/converter/network-convert';
import { DecodedV1ContractDatum, newCooldownTime } from '@/utils/converter/string-datum-convert';
import { lockAndQueryPayments } from '@/utils/db/lock-and-query-payments';
import { retryOnSerializationConflict } from '@/utils/db/retry';
import { interpretBlockchainError } from '@/utils/errors/blockchain-error-interpreter';
import { sortAndLimitUtxos } from '@/utils/utxo';
import { delayErrorResolver } from 'advanced-retry';
import { advancedRetry } from 'advanced-retry';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { generateMasumiSmartContractInteractionTransactionAutomaticFees } from '@/utils/generator/transaction-generator';
import {
	connectExistingTransaction,
	connectPreviousAction,
	createMeshProvider,
	createNextPaymentAction,
	createPendingTransaction,
	createTxWindow,
	loadHotWalletSession,
	updateCurrentTransactionHash,
} from '@/services/shared';
import { createDatumFromDecodedContractV2, getPaymentScriptFromPaymentSourceV2 } from '@masumi/payment-source-v2';
import { decodeV2ContractDatum } from '@/utils/converter/string-datum-convert';
import {
	assertNoCollateralOverlap,
	assertTxSizeWithinLimit,
	intersectTxWindows,
	pickBatchCollateral,
	shrinkBatchToFit,
	type TxWindowBounds,
} from '../../../builders/batch-helpers';
import {
	type BatchInteractionItem,
	generateMasumiSmartContractBatchInteractionTransactionAutomaticFees,
} from '../../../builders/batch-interaction';

// V2 submit-result sizing. Each leg evaluates the Aiken `SubmitResult` redeemer
// over the same script; per-input ex-units run ~mem 4M / steps 1.5B in practice,
// so 6 fits well under the protocol max-ex-units even with headroom. The cap
// also matches the V2 register batch size for operational consistency.
const SUBMIT_RESULT_BATCH_SIZE = 7;

type PaymentSourceWithRelations = Prisma.PaymentSourceGetPayload<{
	include: {
		PaymentRequests: {
			include: {
				NextAction: true;
				CurrentTransaction: true;
				RequestedFunds: true;
				BuyerWallet: true;
				SmartContractWallet: {
					include: {
						Secret: true;
					};
				};
			};
		};
		AdminWallets: true;
		FeeReceiverNetworkWallet: true;
		PaymentSourceConfig: true;
	};
}>;

type PaymentRequestWithRelations = PaymentSourceWithRelations['PaymentRequests'][number];

type MatchingUtxoResult = {
	utxo: UTxO;
	decodedContract: DecodedV1ContractDatum;
};

type ValidatedSubmitItem = {
	request: PaymentRequestWithRelations;
	smartContractUtxo: UTxO;
	decodedContract: DecodedV1ContractDatum;
	newInlineDatum: ReturnType<typeof createDatumFromDecodedContractV2>['value'];
	window: TxWindowBounds;
};

// Sentinel prefix used in thrown error messages from validateAndBuildItem
// to signal that the failure is a CHAIN-LOOKUP miss, not a DB-shape error.
// The catch site in processWalletBatch recognises this prefix and SKIPS
// the item — leaves it in its `*Requested` state for the next scheduler
// tick — instead of calling markRequestFailed.
//
// Chain-state authority belongs to the tx-sync service: it watches contract
// events and rewrites DB state when chain state changes. Marking a request
// as `WaitingForManualAction` from within an action service races tx-sync
// (the UTxO might have been spent by an external observer, or blockfrost
// might just be lagged), and once a request is parked in
// `WaitingForManualAction` the scheduler will never re-pick it up. Defer
// the call and let tx-sync drive any terminal transition.
const LOOKUP_DEFERRED_PREFIX = 'V2_BATCH_LOOKUP_DEFERRED:';

function isLookupDeferred(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith(LOOKUP_DEFERRED_PREFIX);
}

/**
 * Wrap `fetchUTxOs(txHash)` with progressive retries when the first call
 * returns an empty list. The most common cause is blockfrost not having
 * indexed a freshly-landed tx yet (5-30s+ lag after block confirmation on
 * preprod). The 3-step backoff (5s, 10s, 20s) covers the long tail of slow
 * indexing without burning the whole scheduler tick on a single item; if
 * STILL empty after the final attempt, we throw the transient sentinel so
 * the caller defers to the next tick instead of marking the request as
 * failed.
 */
async function fetchUTxOsWithDeferOnEmpty(blockchainProvider: BlockfrostProvider, txHash: string): Promise<UTxO[]> {
	const backoffMs = [5_000, 10_000, 20_000];
	const first = await blockchainProvider.fetchUTxOs(txHash);
	if (first.length > 0) return first;
	for (const wait of backoffMs) {
		await new Promise((resolve) => setTimeout(resolve, wait));
		const next = await blockchainProvider.fetchUTxOs(txHash);
		if (next.length > 0) return next;
	}
	const totalSeconds = backoffMs.reduce((sum, ms) => sum + ms, 0) / 1000;
	throw new Error(
		`${LOOKUP_DEFERRED_PREFIX} fetchUTxOs(${txHash}) returned empty after ${backoffMs.length + 1} attempts (${totalSeconds}s total wait) — chain state not visible to blockfrost yet, deferring to tx-sync / next tick`,
	);
}

const mutex = new Mutex();

/**
 * Determines the new contract state based on current state
 */
function determineNewContractState(currentState: SmartContractState): SmartContractState {
	if (currentState === SmartContractState.Disputed || currentState === SmartContractState.RefundRequested) {
		return SmartContractState.Disputed;
	}
	return SmartContractState.ResultSubmitted;
}

async function markRequestFailed(request: PaymentRequestWithRelations, error: unknown): Promise<void> {
	logger.error(`Error submitting V2 result ${request.id}`, { error });
	await prisma.paymentRequest.update({
		where: { id: request.id },
		data: {
			...connectPreviousAction(request.nextActionId),
			...createNextPaymentAction(PaymentAction.WaitingForManualAction, {
				errorType: PaymentErrorType.Unknown,
				errorNote: 'Submitting result failed: ' + interpretBlockchainError(error),
			}),
			SmartContractWallet: { update: { lockedAt: null } },
		},
	});
}

async function unlockHotWallet(walletId: string): Promise<void> {
	try {
		await prisma.hotWallet.update({
			where: { id: walletId, deletedAt: null },
			data: { lockedAt: null },
		});
	} catch (error) {
		logger.warn('Failed to unlock V2 submit-result hot wallet', { error, walletId });
	}
}

function findMatchingUtxoAndDecodeContract(
	utxoList: UTxO[],
	txHash: string,
	request: PaymentRequestWithRelations,
	paymentContract: PaymentSourceWithRelations,
): MatchingUtxoResult | undefined {
	for (const utxo of utxoList) {
		if (utxo.input.txHash !== txHash) {
			continue;
		}

		const utxoDatum = utxo.output.plutusData;
		if (!utxoDatum) {
			continue;
		}

		const decodedDatum: unknown = deserializeDatum(utxoDatum);
		const decodedContract = decodeV2ContractDatum(
			decodedDatum,
			convertNetwork(paymentContract.network),
			paymentContract.smartContractAddress,
		);
		if (decodedContract === null) {
			continue;
		}

		if (!smartContractStateEqualsOnChainState(decodedContract.state, request.onChainState)) {
			continue;
		}
		if (decodedContract.buyerVkey !== request.BuyerWallet!.walletVkey) {
			continue;
		}
		if (decodedContract.sellerVkey !== request.SmartContractWallet!.walletVkey) {
			continue;
		}
		if (decodedContract.buyerAddress !== request.BuyerWallet!.walletAddress) {
			continue;
		}
		if (decodedContract.sellerAddress !== request.SmartContractWallet!.walletAddress) {
			continue;
		}
		if (decodedContract.blockchainIdentifier !== request.blockchainIdentifier) {
			continue;
		}
		if (decodedContract.inputHash !== request.inputHash) {
			continue;
		}
		if (BigInt(decodedContract.resultTime) !== BigInt(request.submitResultTime)) {
			continue;
		}
		if (BigInt(decodedContract.unlockTime) !== BigInt(request.unlockTime)) {
			continue;
		}
		if (BigInt(decodedContract.externalDisputeUnlockTime) !== BigInt(request.externalDisputeUnlockTime)) {
			continue;
		}
		if (BigInt(decodedContract.collateralReturnLovelace) !== BigInt(request.collateralReturnLovelace!)) {
			continue;
		}
		if (BigInt(decodedContract.payByTime) !== BigInt(request.payByTime!)) {
			continue;
		}

		return { utxo, decodedContract };
	}

	return undefined;
}

/**
 * Per-request validation. Locates the matching script UTxO, decodes the on-chain
 * datum, builds the new continuation datum, and computes the per-item tx-window
 * bounds. Throws on validation failure — caller maps the throw to a per-request
 * failure update.
 */
async function validateAndBuildItem(
	request: PaymentRequestWithRelations,
	paymentContract: PaymentSourceWithRelations,
	blockchainProvider: BlockfrostProvider,
	network: 'mainnet' | 'preprod',
): Promise<ValidatedSubmitItem> {
	if (request.payByTime == null) {
		throw new Error('Pay by time is null, this is deprecated');
	}
	if (request.collateralReturnLovelace == null) {
		throw new Error('Collateral return lovelace is null, this is deprecated');
	}
	if (request.NextAction.resultHash == null) {
		throw new Error('Result hash is not set on NextAction');
	}
	const txHash = request.CurrentTransaction?.txHash;
	if (txHash == null) {
		throw new Error('No transaction hash found');
	}
	const utxoByHash = await fetchUTxOsWithDeferOnEmpty(blockchainProvider, txHash);
	const matchResult = findMatchingUtxoAndDecodeContract(utxoByHash, txHash, request, paymentContract);
	if (!matchResult) {
		throw new Error(`${LOOKUP_DEFERRED_PREFIX} UTXO not found`);
	}
	const { utxo, decodedContract } = matchResult;

	const datum = createDatumFromDecodedContractV2({
		decodedContract,
		buyerAddress: decodedContract.buyerAddress,
		sellerAddress: decodedContract.sellerAddress,
		blockchainIdentifier: request.blockchainIdentifier,
		resultHash: request.NextAction.resultHash,
		newCooldownTimeSeller: newCooldownTime(BigInt(paymentContract.cooldownTime)),
		newCooldownTimeBuyer: BigInt(0),
		state: determineNewContractState(decodedContract.state),
	});

	const { invalidBefore, invalidAfter } = createTxWindow(network, {
		constrainAfterMs: Number(decodedContract.resultTime),
		constrainBeforeMs: Number(decodedContract.sellerCooldownTime),
	});

	return {
		request,
		smartContractUtxo: utxo,
		decodedContract,
		newInlineDatum: datum.value,
		window: { invalidBefore, invalidAfter },
	};
}

async function processSinglePaymentRequest(
	request: PaymentRequestWithRelations,
	paymentContract: PaymentSourceWithRelations,
	blockchainProvider: BlockfrostProvider,
	network: 'mainnet' | 'preprod',
): Promise<boolean> {
	if (request.payByTime == null) {
		throw new Error('Pay by time is null, this is deprecated');
	}
	if (request.collateralReturnLovelace == null) {
		throw new Error('Collateral return lovelace is null, this is deprecated');
	}
	const walletSession = await loadHotWalletSession({
		network: paymentContract.network,
		rpcProviderApiKey: paymentContract.PaymentSourceConfig.rpcProviderApiKey,
		encryptedMnemonic: request.SmartContractWallet!.Secret.encryptedMnemonic,
		hotWalletId: request.SmartContractWallet!.id,
	});
	const { wallet, utxos, address } = walletSession;

	if (utxos.length === 0) {
		throw new Error('No UTXOs found in the wallet. Wallet is empty.');
	}

	const { script, smartContractAddress } = await getPaymentScriptFromPaymentSourceV2(paymentContract);
	const txHash = request.CurrentTransaction?.txHash;
	if (txHash == null) {
		throw new Error('No transaction hash found');
	}
	const utxoByHash = await fetchUTxOsWithDeferOnEmpty(blockchainProvider, txHash);

	const matchResult = findMatchingUtxoAndDecodeContract(utxoByHash, txHash, request, paymentContract);

	if (!matchResult) {
		throw new Error(`${LOOKUP_DEFERRED_PREFIX} UTXO not found`);
	}

	const { utxo, decodedContract } = matchResult;

	const datum = createDatumFromDecodedContractV2({
		decodedContract,
		buyerAddress: decodedContract.buyerAddress,
		sellerAddress: decodedContract.sellerAddress,
		blockchainIdentifier: request.blockchainIdentifier,
		resultHash: request.NextAction.resultHash,
		newCooldownTimeSeller: newCooldownTime(BigInt(paymentContract.cooldownTime)),
		newCooldownTimeBuyer: BigInt(0),
		state: determineNewContractState(decodedContract.state),
	});

	const { invalidBefore, invalidAfter } = createTxWindow(network, {
		constrainAfterMs: Number(decodedContract.resultTime),
		constrainBeforeMs: Number(decodedContract.sellerCooldownTime),
	});

	const limitedUtxos = sortAndLimitUtxos(utxos, 8000000);

	const unsignedTx = await generateMasumiSmartContractInteractionTransactionAutomaticFees(
		'SubmitResult',
		blockchainProvider,
		network,
		script,
		address,
		utxo,
		limitedUtxos[0],
		limitedUtxos,
		datum.value,
		invalidBefore,
		invalidAfter,
		paymentContract.PaymentSourceConfig.rpcProviderApiKey,
	);

	const signedTx = await wallet.signTx(unsignedTx);

	await prisma.paymentRequest.update({
		where: { id: request.id },
		data: {
			...connectPreviousAction(request.nextActionId),
			...createNextPaymentAction(PaymentAction.SubmitResultInitiated),
			...createPendingTransaction(request.SmartContractWallet!.id),
			TransactionHistory: {
				connect: {
					id: request.CurrentTransaction!.id,
				},
			},
		},
	});
	try {
		const newTxHash = await wallet.submitTx(signedTx);
		await walletSession.evaluateProjectedBalance(unsignedTx, limitedUtxos);
		await prisma.paymentRequest.update({
			where: { id: request.id },
			data: updateCurrentTransactionHash(newTxHash),
		});

		logger.debug(`Created submit result transaction:
                  Tx ID: ${newTxHash}
                  View (after a bit) on https://${
										network === 'preprod' ? 'preprod.' : ''
									}cardanoscan.io/transaction/${newTxHash}
                  Smart Contract Address: ${smartContractAddress}
              `);

		return true;
	} catch (error) {
		logger.error(`Error submitting result`, { error: error });
		await prisma.paymentRequest.update({
			where: { id: request.id },
			data: {
				...connectPreviousAction(request.nextActionId),
				...createNextPaymentAction(PaymentAction.SubmitResultRequested, {
					errorType: null,
					errorNote: null,
					resultHash: request.NextAction.resultHash,
				}),
				SmartContractWallet: {
					update: {
						lockedAt: null,
					},
				},
			},
		});
		return false;
	}
}

async function fallbackToSingleItems(
	requests: PaymentRequestWithRelations[],
	paymentContract: PaymentSourceWithRelations,
	blockchainProvider: BlockfrostProvider,
	network: 'mainnet' | 'preprod',
): Promise<void> {
	// Process AT MOST ONE item, not all N. Submitting the first item
	// creates a PendingTransaction that locks the hot wallet, so any
	// subsequent item in this tick would just race the wallet lock and
	// fail. The remaining items stay in their queued state — next
	// scheduler tick (after tx-sync clears the lock) re-picks them up
	// and batches them again. The fallback exists purely so a single
	// bad item (invalid datum, expired window, etc.) does not block the
	// rest forever; it is NOT a parallel retry path. In the happy path
	// the batch builder above handles everything in one tx and this
	// function never runs.
	if (requests.length === 0) return;
	const request = requests[0];
	try {
		await advancedRetry({
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
			operation: async () => {
				const ok = await processSinglePaymentRequest(request, paymentContract, blockchainProvider, network);
				if (!ok) throw new Error('processSingle returned false');
				return ok;
			},
		});
	} catch (error) {
		if (isLookupDeferred(error)) {
			// Same defer-to-tx-sync semantics as the batch validation pass:
			// chain lookup miss is NOT a per-item failure; leave the request
			// queued and let tx-sync drive any terminal transition.
			logger.info(
				`Deferring V2 single-item fallback (chain lookup not ready); request ${request.id} stays queued for tx-sync to reconcile`,
				{ error: error instanceof Error ? error.message : error },
			);
		} else {
			await markRequestFailed(request, error);
		}
	}
	// requests[1..] are intentionally left untouched — they remain in
	// their `*Requested` state and the next tick (after the wallet
	// unlocks) will batch them again. Do NOT call markRequestFailed on
	// them here: a batch build failure caused by a transient issue
	// (network blip, blockfrost lag, cost-model sync race) is not a
	// per-item failure and the items deserve another chance.
}

async function processWalletBatch(
	requests: PaymentRequestWithRelations[],
	paymentContract: PaymentSourceWithRelations,
	blockchainProvider: BlockfrostProvider,
	network: 'mainnet' | 'preprod',
	script: { version: LanguageVersion; code: string },
	smartContractAddress: string,
): Promise<void> {
	const firstRequest = requests[0];
	const wallet = firstRequest.SmartContractWallet!;

	let walletSession;
	try {
		walletSession = await loadHotWalletSession({
			network: paymentContract.network,
			rpcProviderApiKey: paymentContract.PaymentSourceConfig.rpcProviderApiKey,
			encryptedMnemonic: wallet.Secret.encryptedMnemonic,
			hotWalletId: wallet.id,
		});
	} catch (error) {
		logger.warn(
			'V2 submit-result batch could not load wallet session; leaving items in pool for next tick [batch-fallback]',
			{
				error: error instanceof Error ? { message: error.message, stack: error.stack, name: error.name } : error,
				walletId: wallet.id,
				batchSize: requests.length,
			},
		);
		// Wallet-load failure is NOT a per-item failure: every request
		// in this batch was waiting on the same wallet. Marking them all
		// as `WaitingForManualAction` would terminate good requests for
		// a transient infra issue. Unlock the hot wallet and leave the
		// requests in their queued state — next tick (after the wallet
		// session loads cleanly) re-batches them.
		await unlockHotWallet(wallet.id);
		return;
	}
	const { wallet: meshWallet, utxos, address } = walletSession;
	if (utxos.length === 0) {
		logger.warn('V2 batch hot wallet returned no UTxOs; leaving items in pool for next tick [batch-fallback]', {
			walletId: wallet.id,
			batchSize: requests.length,
		});
		// Empty wallet is a transient operational issue (faucet ran out,
		// pending state still settling). NOT a per-item failure — leave
		// items queued for the next tick after the wallet has UTxOs.
		await unlockHotWallet(wallet.id);
		return;
	}

	// Per-request validation. Failures here become per-request DB failures and
	// are excluded from the batch.
	const validated: ValidatedSubmitItem[] = [];
	for (const request of requests) {
		try {
			validated.push(await validateAndBuildItem(request, paymentContract, blockchainProvider, network));
		} catch (error) {
			if (isLookupDeferred(error)) {
				// Chain-lookup miss (blockfrost not caught up, or the UTxO
				// has already been consumed by something tx-sync has not
				// observed yet). Leave the request queued — tx-sync owns
				// the chain-state truth and will drive any terminal
				// transition. Logged at info because it is expected during
				// indexer lag.
				logger.info(
					`Deferring V2 batch item this tick (chain lookup not ready); request ${request.id} stays queued for tx-sync to reconcile`,
					{ error: error instanceof Error ? error.message : error },
				);
			} else {
				await markRequestFailed(request, error);
			}
		}
	}
	if (validated.length === 0) {
		logger.info(
			'No V2 submit-result items in this tick reached the batch builder (every item was either deferred for tx-sync to reconcile or marked failed); leaving wallet unlocked',
			{ walletId: wallet.id },
		);
		await unlockHotWallet(wallet.id);
		return;
	}

	// Pick collateral that is NOT in the spending set.
	const excludeRefs = validated.map((v) => v.smartContractUtxo.input);
	const collateralUtxo = pickBatchCollateral(utxos, excludeRefs);
	if (collateralUtxo == null) {
		logger.warn('V2 submit-result batch could not find collateral UTxO; falling back to single-item [batch-fallback]', {
			walletId: wallet.id,
		});
		await fallbackToSingleItems(
			validated.map((v) => v.request),
			paymentContract,
			blockchainProvider,
			network,
		);
		return;
	}

	const spendingUtxoKeys = new Set(
		validated.map((v) => `${v.smartContractUtxo.input.txHash}#${v.smartContractUtxo.input.outputIndex}`),
	);
	const collateralKey = `${collateralUtxo.input.txHash}#${collateralUtxo.input.outputIndex}`;
	const walletUtxos = utxos.filter((utxo) => {
		const key = `${utxo.input.txHash}#${utxo.input.outputIndex}`;
		if (key === collateralKey) return false;
		if (spendingUtxoKeys.has(key)) return false;
		return true;
	});
	const limitedFilteredUtxos = sortAndLimitUtxos(walletUtxos, 8000000);

	// Constraints applied progressively: validity-window intersection then
	// no-collateral-overlap. tx-size is checked after the build pass.
	const shrinkResult = shrinkBatchToFit(validated, (subset) => {
		const window = intersectTxWindows(subset.map((v) => v.window));
		if (window == null) {
			return { ok: false, reason: 'window' };
		}
		try {
			assertNoCollateralOverlap(
				collateralUtxo,
				subset.map((v) => ({ input: v.smartContractUtxo.input })),
			);
		} catch {
			return { ok: false, reason: 'collateral' };
		}
		return { ok: true };
	});

	if (shrinkResult.fit.length === 0) {
		logger.warn(
			'V2 submit-result batch could not satisfy batch invariants; falling back to single-item [batch-fallback]',
			{
				reason: shrinkResult.reason,
				walletId: wallet.id,
			},
		);
		await fallbackToSingleItems(
			validated.map((v) => v.request),
			paymentContract,
			blockchainProvider,
			network,
		);
		return;
	}
	if (shrinkResult.dropped.length > 0) {
		logger.warn(
			`V2 submit-result batch shrunk from ${validated.length} to ${shrinkResult.fit.length} (reason=${shrinkResult.reason})`,
		);
	}

	const fit = shrinkResult.fit;
	const droppedRequests = shrinkResult.dropped.map((v) => v.request);

	// Composed window from the surviving subset.
	const composed = intersectTxWindows(fit.map((v) => v.window));
	if (composed == null) {
		// shrinkBatchToFit invariant says this can't happen for fit.length > 0,
		// but be defensive.
		logger.error('V2 submit-result composed window is null after shrink — falling back', { walletId: wallet.id });
		await fallbackToSingleItems(
			validated.map((v) => v.request),
			paymentContract,
			blockchainProvider,
			network,
		);
		return;
	}

	const items: BatchInteractionItem[] = fit.map((v) => ({
		type: 'SubmitResult',
		smartContractUtxo: v.smartContractUtxo,
		newInlineDatum: v.newInlineDatum,
	}));

	let unsignedTx: string;
	try {
		// See note on cross-mesh-version type alias in
		// packages/payment-source-v2/src/services/registry/deregister/service.ts.
		unsignedTx = await generateMasumiSmartContractBatchInteractionTransactionAutomaticFees(
			blockchainProvider as unknown as MeshV2BlockfrostProvider,
			network,
			script,
			address,
			collateralUtxo,
			limitedFilteredUtxos,
			items,
			composed.invalidBefore,
			composed.invalidAfter,
			paymentContract.PaymentSourceConfig.rpcProviderApiKey,
		);
		assertTxSizeWithinLimit(unsignedTx, 'v2-submit-result-batch');
	} catch (batchError) {
		logger.warn('V2 submit-result batch build failed; falling back to single-item [batch-fallback]', {
			error:
				batchError instanceof Error
					? { message: batchError.message, stack: batchError.stack, name: batchError.name }
					: batchError,
			batchSize: fit.length,
			walletId: wallet.id,
		});
		await fallbackToSingleItems(
			validated.map((v) => v.request),
			paymentContract,
			blockchainProvider,
			network,
		);
		return;
	}

	let signedTx: string;
	try {
		signedTx = await meshWallet.signTx(unsignedTx);
	} catch (signError) {
		logger.warn('V2 submit-result batch sign failed; falling back to single-item [batch-fallback]', {
			error:
				signError instanceof Error
					? { message: signError.message, stack: signError.stack, name: signError.name }
					: signError,
			walletId: wallet.id,
		});
		await fallbackToSingleItems(
			validated.map((v) => v.request),
			paymentContract,
			blockchainProvider,
			network,
		);
		return;
	}

	// V2 batch shared-Transaction pre-submit:
	// 1. Create ONE Transaction row carrying BlocksWallet → wallet.
	// 2. Connect every fit item's CurrentTransaction to that shared Tx.
	// This replaces the N-orphan pattern (one createPendingTransaction per
	// item) — HotWallet.pendingTransactionId points to the single shared Tx,
	// so tx-sync's BlocksWallet-driven wallet unlock fires exactly once per
	// batch regardless of which entry it processes first.
	let sharedTxId: string;
	try {
		sharedTxId = await retryOnSerializationConflict(
			() =>
				prisma.$transaction(
					async (tx) => {
						const sharedTx = await tx.transaction.create({
							data: {
								status: TransactionStatus.Pending,
								BlocksWallet: { connect: { id: wallet.id } },
							},
						});
						for (const v of fit) {
							await tx.paymentRequest.update({
								where: { id: v.request.id },
								data: {
									...connectPreviousAction(v.request.nextActionId),
									...createNextPaymentAction(PaymentAction.SubmitResultInitiated),
									...connectExistingTransaction(sharedTx.id),
									TransactionHistory: { connect: { id: v.request.CurrentTransaction!.id } },
								},
							});
						}
						return sharedTx.id;
					},
					{ timeout: 30_000 },
				),
			{ label: 'submit-result-batch-tx' },
		);
	} catch (dbError) {
		logger.error('V2 submit-result batch DB pre-submit update failed', { error: dbError });
		await unlockHotWallet(wallet.id);
		return;
	}

	let newTxHash: string;
	try {
		newTxHash = await meshWallet.submitTx(signedTx);
	} catch (submitError) {
		logger.warn('V2 submit-result batch submit failed; rolling back DB and retrying as single items', {
			error:
				submitError instanceof Error
					? { message: submitError.message, stack: submitError.stack, name: submitError.name }
					: submitError,
		});
		await retryOnSerializationConflict(
			() =>
				prisma.$transaction(
					async (tx) => {
						for (const v of fit) {
							await tx.paymentRequest.update({
								where: { id: v.request.id },
								data: {
									...connectPreviousAction(v.request.nextActionId),
									...createNextPaymentAction(PaymentAction.SubmitResultRequested, {
										errorType: null,
										errorNote: null,
										resultHash: v.request.NextAction.resultHash,
									}),
									CurrentTransaction: { connect: { id: v.request.CurrentTransaction!.id } },
									TransactionHistory: { disconnect: { id: v.request.CurrentTransaction!.id } },
								},
							});
						}
					},
					{ timeout: 30_000 },
				),
			{ label: 'submit-result-batch-tx' },
		);
		await fallbackToSingleItems(
			validated.map((v) => v.request),
			paymentContract,
			blockchainProvider,
			network,
		);
		return;
	}

	try {
		await walletSession.evaluateProjectedBalance(unsignedTx, limitedFilteredUtxos);
	} catch (balanceError) {
		logger.warn('V2 submit-result batch projected balance evaluation failed (non-fatal)', {
			error:
				balanceError instanceof Error
					? { message: balanceError.message, stack: balanceError.stack, name: balanceError.name }
					: balanceError,
		});
	}

	// Post-submit: a SINGLE Transaction row carries the txHash for the whole
	// batch (because pre-submit created one shared Tx referenced by every
	// participating PaymentRequest). One update suffices.
	try {
		await retryOnSerializationConflict(
			() =>
				prisma.$transaction(
					async (tx) => {
						await tx.transaction.update({
							where: { id: sharedTxId },
							data: { txHash: newTxHash },
						});
					},
					{ timeout: 30_000 },
				),
			{ label: 'submit-result-batch-tx' },
		);
	} catch (dbError) {
		logger.error('V2 submit-result batch post-submit DB update failed; tx-sync will reconcile next tick', {
			error:
				dbError instanceof Error ? { message: dbError.message, stack: dbError.stack, name: dbError.name } : dbError,
			txHash: newTxHash,
		});
	}

	logger.debug(`Created V2 submit-result batch transaction:
              Tx ID: ${newTxHash}
              Items: ${fit.length}
              View on https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${newTxHash}
              Smart Contract Address: ${smartContractAddress}
          `);

	if (droppedRequests.length > 0) {
		// Items that were peeled off should be retried via single-item next
		// tick. Mark as failed-and-retryable so the scheduler can pick them up.
		await Promise.allSettled(
			droppedRequests.map((request) =>
				prisma.paymentRequest.update({
					where: { id: request.id },
					data: {
						...connectPreviousAction(request.nextActionId),
						...createNextPaymentAction(PaymentAction.SubmitResultRequested, {
							errorType: null,
							errorNote: null,
							resultHash: request.NextAction.resultHash,
						}),
					},
				}),
			),
		);
	}
}

function groupRequestsByWallet(requests: PaymentRequestWithRelations[]): Map<string, PaymentRequestWithRelations[]> {
	const byWallet = new Map<string, PaymentRequestWithRelations[]>();
	for (const request of requests) {
		if (request.SmartContractWallet == null) continue;
		const list = byWallet.get(request.SmartContractWallet.id) ?? [];
		list.push(request);
		byWallet.set(request.SmartContractWallet.id, list);
	}
	return byWallet;
}

export async function submitResultV2() {
	let release: MutexInterface.Releaser | null;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch (e) {
		logger.info('Mutex timeout when locking', { error: e });
		return;
	}

	try {
		const paymentContractsWithWalletLocked = await lockAndQueryPayments({
			paymentStatus: PaymentAction.SubmitResultRequested,
			// Aiken SubmitResult requires `must_end_before(submit_result_time)`.
			// The default tx-window's invalidAfter is ~now + 2.5min + slot buffer.
			// Filter to at least 5 minutes of slack so submissions don't race
			// the ledger boundary.
			submitResultTime: {
				gt: Date.now() + 1000 * 60 * 5,
			},
			requestedResultHash: { not: null },
			maxBatchSize: SUBMIT_RESULT_BATCH_SIZE,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
		});

		await Promise.allSettled(
			paymentContractsWithWalletLocked.map(async (paymentContract) => {
				if (paymentContract.PaymentRequests.length == 0) return;

				logger.info(
					`Submitting ${paymentContract.PaymentRequests.length} V2 results for payment source ${paymentContract.id}`,
				);

				const network = convertNetwork(paymentContract.network);
				const blockchainProvider = await createMeshProvider(paymentContract.PaymentSourceConfig.rpcProviderApiKey);
				const { script, smartContractAddress } = await getPaymentScriptFromPaymentSourceV2(paymentContract);

				const grouped = groupRequestsByWallet(paymentContract.PaymentRequests);
				await Promise.allSettled(
					Array.from(grouped.values()).map(async (walletRequests) => {
						if (walletRequests.length === 0) return;
						await processWalletBatch(
							walletRequests,
							paymentContract,
							blockchainProvider,
							network,
							script,
							smartContractAddress,
						);
					}),
				);
			}),
		);
	} catch (error) {
		logger.error('Error submitting V2 result', { error });
	} finally {
		release();
	}
}
