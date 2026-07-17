import { createId } from '@paralleldrive/cuid2';
import { FundDistributionStatus, HotWalletType, TransactionStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { CONSTANTS } from '@masumi/payment-core/config';
import { logger } from '@masumi/payment-core/logger';
import { interpretBlockchainError } from '@masumi/payment-core/blockchain-error-interpreter';
import { retryOnSerializationConflict } from '@masumi/payment-core/db-retry';
import { isDefinitiveNodeRejection } from '@masumi/payment-core/submit-error-classifier';
import { fetchAddressBalanceMap } from '@/services/shared/address-balance';
import { webhookEventsService } from '@/services/webhooks';
import { buildAndSignFundDistributionTx } from './transaction-builder';
import type { FundWalletContext } from './context';

export type FundDistributionBatchRequest = {
	id: string;
	targetWalletId: string;
	targetAddress: string;
	amount: bigint;
};

type ClaimErrorCode = 'WALLET_UNAVAILABLE' | 'REQUESTS_ALREADY_CLAIMED' | 'BATCH_OWNERSHIP_LOST';

function claimError(code: ClaimErrorCode): Error & { code: ClaimErrorCode } {
	return Object.assign(new Error(code), { code });
}

/**
 * Tell operators the treasury itself cannot afford any top-up.
 *
 * The alert is keyed to the fund wallet's own low-balance rule so consumers
 * get a resolvable ruleId; without a rule, only the log line above fires. The
 * `lastAlertedAt` claim throttles the alert: the distribution cycle runs every
 * 30s and the pending requests stay Pending while the treasury is empty, so an
 * unthrottled alert re-fired per cycle. The guarded updateMany is also the
 * cross-replica claim — whichever worker advances `lastAlertedAt` sends.
 */
async function alertFundWalletUnderfunded(fundWallet: FundWalletContext, fundWalletBalance: bigint): Promise<void> {
	const rule = fundWallet.lowBalanceRule;
	if (rule == null) return;

	const cooldownStart = new Date(Date.now() - CONSTANTS.FUND_DISTRIBUTION_UNDERFUNDED_ALERT_COOLDOWN_MS);
	if (rule.lastAlertedAt != null && rule.lastAlertedAt > cooldownStart) return;

	const claimed = await prisma.hotWalletLowBalanceRule.updateMany({
		where: {
			id: rule.id,
			OR: [{ lastAlertedAt: null }, { lastAlertedAt: { lte: cooldownStart } }],
		},
		data: { lastAlertedAt: new Date() },
	});
	if (claimed.count !== 1) return;

	await webhookEventsService.triggerWalletLowBalance({
		ruleId: rule.id,
		walletId: fundWallet.id,
		walletAddress: fundWallet.walletAddress,
		walletVkey: fundWallet.walletVkey,
		walletType: HotWalletType.Funding,
		paymentSourceId: fundWallet.paymentSourceId,
		paymentSourceType: fundWallet.paymentSourceType,
		network: fundWallet.network,
		assetUnit: 'lovelace',
		thresholdAmount: '0',
		currentAmount: fundWalletBalance.toString(),
		checkedAt: new Date().toISOString(),
	});
}

/**
 * Executes one distribution batch for a single fund wallet: affordability
 * check, wallet lock, build/sign, pre-submit hash recording, broadcast, and
 * outcome classification.
 *
 * The submit sequence deliberately mirrors the V2 batch-payments double-lock
 * guarantee (see
 * `packages/payment-source-v2/src/services/purchases/batch-payments/service.ts`):
 * record the deterministic hash BEFORE broadcast so an ambiguous outcome is
 * resolvable against the chain instead of blindly retried. Money safety beats
 * ergonomic recovery — a re-send here spends the treasury twice.
 */
export async function processRequestsForFundWallet(
	fundWallet: FundWalletContext,
	requests: FundDistributionBatchRequest[],
): Promise<void> {
	if (requests.length === 0) return;

	// Read the balance straight from the address. Deliberately does NOT go via
	// `generateWalletExtended` — that decrypts the treasury mnemonic, and a
	// read-only affordability check has no business holding key material.
	let fundWalletBalance: bigint;
	try {
		const balanceMap = await fetchAddressBalanceMap({
			network: fundWallet.network,
			rpcProviderApiKey: fundWallet.rpcProviderApiKey,
			address: fundWallet.walletAddress,
		});
		fundWalletBalance = balanceMap.get('lovelace') ?? 0n;
	} catch (error) {
		logger.error('Failed to fetch fund wallet balance', {
			component: 'fund_distribution',
			fund_wallet_id: fundWallet.id,
			error: interpretBlockchainError(error),
		});
		return;
	}

	// Determine which requests we can actually fulfill given balance constraints
	const feeBuffer = CONSTANTS.MIN_TX_FEE_BUFFER_LOVELACE;
	let remainingBalance = fundWalletBalance - feeBuffer;

	if (remainingBalance <= 0n) {
		logger.warn('Fund wallet has insufficient balance for any distributions', {
			component: 'fund_distribution',
			fund_wallet_id: fundWallet.id,
			balance: fundWalletBalance.toString(),
		});
		await alertFundWalletUnderfunded(fundWallet, fundWalletBalance);
		return;
	}

	const affordableRequests: FundDistributionBatchRequest[] = [];
	for (const req of requests) {
		if (affordableRequests.length >= CONSTANTS.FUND_DISTRIBUTION_MAX_OUTPUTS_PER_TX) break;
		if (req.amount <= remainingBalance) {
			remainingBalance -= req.amount;
			affordableRequests.push(req);
		}
	}

	if (affordableRequests.length === 0) {
		logger.warn('Fund wallet cannot afford any pending distributions', {
			component: 'fund_distribution',
			fund_wallet_id: fundWallet.id,
			balance: fundWalletBalance.toString(),
			first_request_amount: requests[0]?.amount.toString(),
		});
		await alertFundWalletUnderfunded(fundWallet, fundWalletBalance);
		return;
	}

	const batchId = createId();
	const outputs = affordableRequests.map((req) => ({ address: req.targetAddress, lovelace: req.amount }));
	const batchRequestIds = affordableRequests.map((r) => r.id);

	// Atomically check the wallet is still unlocked, create the Transaction record, lock the
	// wallet, and link this batch's requests to the Transaction. All four steps run in a single
	// DB transaction to eliminate the TOCTOU race and to guarantee that no request is ever
	// in-flight without a resolvable link back to the Transaction reconciliation will act on.
	let transaction: { id: string };
	try {
		transaction = await retryOnSerializationConflict(
			() =>
				prisma.$transaction(
					async (tx) => {
						const newTx = await tx.transaction.create({
							data: {
								txHash: null,
								status: TransactionStatus.Pending,
							},
						});

						// The predicate is the lock acquisition. Two replicas may both read
						// the wallet as free, but only one can change this row from free to
						// owned by its transaction.
						const walletClaim = await tx.hotWallet.updateMany({
							where: {
								id: fundWallet.id,
								deletedAt: null,
								lockedAt: null,
								pendingTransactionId: null,
								FundDistributionConfig: { enabled: true },
								PaymentSource: { deletedAt: null },
							},
							data: {
								lockedAt: new Date(),
								pendingTransactionId: newTx.id,
							},
						});
						if (walletClaim.count !== 1) throw claimError('WALLET_UNAVAILABLE');

						const requestClaim = await tx.fundDistributionRequest.updateMany({
							where: {
								id: { in: batchRequestIds },
								fundWalletId: fundWallet.id,
								status: FundDistributionStatus.Pending,
								transactionId: null,
								TargetWallet: { deletedAt: null, PaymentSource: { deletedAt: null } },
							},
							data: { transactionId: newTx.id, batchId },
						});
						if (requestClaim.count !== batchRequestIds.length) {
							throw claimError('REQUESTS_ALREADY_CLAIMED');
						}

						return newTx;
					},
					{ isolationLevel: 'Serializable' },
				),
			{ label: 'fund-distribution-claim' },
		);
	} catch (error) {
		const code = error instanceof Error ? (error as { code?: string }).code : undefined;
		if (code === 'WALLET_UNAVAILABLE') {
			logger.info('Fund wallet is locked, skipping distribution cycle', {
				component: 'fund_distribution',
				fund_wallet_id: fundWallet.id,
			});
			return;
		}
		if (code === 'REQUESTS_ALREADY_CLAIMED') {
			logger.info('Fund distribution requests were claimed by another worker', {
				component: 'fund_distribution',
				fund_wallet_id: fundWallet.id,
				request_ids: batchRequestIds,
			});
			return;
		}
		throw error;
	}

	const requestIds = affordableRequests.map((r) => r.id);

	const batchPayload = {
		batchId,
		fundWalletId: fundWallet.id,
		fundWalletAddress: fundWallet.walletAddress,
		network: fundWallet.network,
		distributions: affordableRequests.map((req) => ({
			requestId: req.id,
			targetWalletId: req.targetWalletId,
			targetWalletAddress: req.targetAddress,
			amount: req.amount.toString(),
		})),
	};

	// Revert = unlock the wallet, drop the orphaned Transaction row, fail the
	// requests. ONLY safe when the tx body provably never reached the chain.
	const revertNeverBroadcast = async (errorMsg: string) => {
		const failedCount = await retryOnSerializationConflict(
			() =>
				prisma.$transaction(
					async (tx) => {
						// Only release this batch's lock. If a timeout/recovery path has
						// already given the wallet to a newer transaction, leave it alone.
						await tx.hotWallet.updateMany({
							where: { id: fundWallet.id, pendingTransactionId: transaction.id },
							data: { lockedAt: null, pendingTransactionId: null },
						});

						const failed = await tx.fundDistributionRequest.updateMany({
							where: {
								id: { in: requestIds },
								fundWalletId: fundWallet.id,
								status: FundDistributionStatus.Pending,
								transactionId: transaction.id,
							},
							data: {
								status: FundDistributionStatus.Failed,
								error: errorMsg,
								batchId,
								transactionId: null,
							},
						});

						if (failed.count !== requestIds.length) return failed.count;

						await tx.transaction.deleteMany({
							where: { id: transaction.id, status: TransactionStatus.Pending },
						});
						await webhookEventsService.queueFundDistributionFailed(
							tx,
							{
								...batchPayload,
								txHash: null,
								error: errorMsg,
							},
							fundWallet.paymentSourceId,
						);
						return failed.count;
					},
					{ isolationLevel: 'Serializable' },
				),
			{ label: 'fund-distribution-revert-never-broadcast' },
		);

		if (failedCount !== requestIds.length) {
			logger.warn('Fund distribution pre-broadcast rollback lost ownership of some requests', {
				component: 'fund_distribution',
				fund_wallet_id: fundWallet.id,
				batch_id: batchId,
				expected_request_count: requestIds.length,
				failed_request_count: failedCount,
			});
			return;
		}
	};

	// Build and sign WITHOUT broadcasting, so the deterministic hash can be
	// persisted first. build/sign throwing means nothing was ever sent.
	let signed;
	try {
		signed = await buildAndSignFundDistributionTx({
			encryptedMnemonic: fundWallet.encryptedMnemonic,
			network: fundWallet.network,
			rpcProviderApiKey: fundWallet.rpcProviderApiKey,
			outputs,
		});
	} catch (error) {
		const errorMsg = interpretBlockchainError(error);
		logger.error('Fund distribution build/sign failed pre-broadcast; reverting', {
			component: 'fund_distribution',
			fund_wallet_id: fundWallet.id,
			batch_id: batchId,
			error: errorMsg,
		});
		await revertNeverBroadcast(errorMsg);
		return;
	}

	// Persist intendedTxHash + invalidHereafterSlot BEFORE broadcast. Without
	// them an ambiguous submit is unrecoverable: wallet-timeouts would take the
	// "no intendedTxHash -> genuine orphan" blind-disconnect branch, free the
	// wallet while these requests are still Pending, and the next cycle would
	// re-send a tx that may already be on chain — paying the float twice.
	try {
		await retryOnSerializationConflict(
			() =>
				prisma.$transaction(
					async (tx) => {
						// Renew and fence the lease. If timeout recovery, source deletion,
						// or configuration disablement won while build/sign was awaiting
						// network I/O, discard the signed body instead of reviving a stale
						// worker that may race a replacement batch.
						const walletLease = await tx.hotWallet.updateMany({
							where: {
								id: fundWallet.id,
								deletedAt: null,
								pendingTransactionId: transaction.id,
								FundDistributionConfig: { enabled: true },
								PaymentSource: { deletedAt: null },
							},
							data: { lockedAt: new Date() },
						});
						if (walletLease.count !== 1) throw claimError('BATCH_OWNERSHIP_LOST');

						const ownedRequests = await tx.fundDistributionRequest.count({
							where: {
								id: { in: requestIds },
								fundWalletId: fundWallet.id,
								status: FundDistributionStatus.Pending,
								transactionId: transaction.id,
								TargetWallet: { deletedAt: null, PaymentSource: { deletedAt: null } },
							},
						});
						if (ownedRequests !== requestIds.length) throw claimError('BATCH_OWNERSHIP_LOST');

						const recorded = await tx.transaction.updateMany({
							where: {
								id: transaction.id,
								status: TransactionStatus.Pending,
								txHash: null,
								intendedTxHash: null,
							},
							data: {
								intendedTxHash: signed.intendedTxHash,
								invalidHereafterSlot: BigInt(signed.invalidHereafterSlot),
								lastCheckedAt: new Date(),
							},
						});
						if (recorded.count !== 1) throw claimError('BATCH_OWNERSHIP_LOST');
					},
					{ isolationLevel: 'Serializable' },
				),
			{ label: 'fund-distribution-record-intended' },
		);
	} catch (error) {
		const errorMsg = interpretBlockchainError(error);
		logger.error('Fund distribution could not record intendedTxHash; aborting submit', {
			component: 'fund_distribution',
			fund_wallet_id: fundWallet.id,
			batch_id: batchId,
			intended_tx_hash: signed.intendedTxHash,
			error: errorMsg,
		});
		// Not broadcast yet, so reverting is still safe.
		await revertNeverBroadcast(errorMsg);
		return;
	}

	let txHash: string;
	try {
		txHash = await signed.submit();
	} catch (error) {
		const errorMsg = interpretBlockchainError(error);

		if (isDefinitiveNodeRejection(error)) {
			// The node demonstrably refused the body; it cannot land. Revert.
			logger.warn('Fund distribution submit definitively rejected by node', {
				component: 'fund_distribution',
				fund_wallet_id: fundWallet.id,
				batch_id: batchId,
				intended_tx_hash: signed.intendedTxHash,
				error: errorMsg,
			});
			await revertNeverBroadcast(errorMsg);
			return;
		}

		// Ambiguous (5xx, timeout, ECONNRESET): the tx may well be on chain.
		// Leave the wallet locked and the Transaction Pending with
		// intendedTxHash set — funding-reconciliation resolves it by querying
		// the chain, promoting on a hit or reverting only once
		// invalidHereafterSlot has provably passed. Requests stay Pending so
		// they are re-sent only after that revert.
		logger.warn('Fund distribution submit AMBIGUOUS; leaving Pending for reconciliation', {
			component: 'fund_distribution',
			fund_wallet_id: fundWallet.id,
			batch_id: batchId,
			intended_tx_hash: signed.intendedTxHash,
			error: errorMsg,
		});
		return;
	}

	if (txHash !== signed.intendedTxHash) {
		// The node reported a hash we did not compute. Trust neither; let
		// reconciliation settle it against the chain rather than recording a
		// hash that may not correspond to the body we signed.
		logger.error('Fund distribution node txHash diverged from intendedTxHash; deferring to reconciliation', {
			component: 'fund_distribution',
			fund_wallet_id: fundWallet.id,
			batch_id: batchId,
			intended_tx_hash: signed.intendedTxHash,
			returned_tx_hash: txHash,
		});
		return;
	}

	// Record the broadcast and advance only the rows this batch owns. Keeping
	// both writes atomic prevents reconciliation from observing txHash while the
	// request rows are still unsubmitted.
	const submittedCount = await retryOnSerializationConflict(
		() =>
			prisma.$transaction(
				async (tx) => {
					const recorded = await tx.transaction.updateMany({
						where: { id: transaction.id, status: TransactionStatus.Pending },
						data: { txHash },
					});
					if (recorded.count !== 1) return 0;

					const submitted = await tx.fundDistributionRequest.updateMany({
						where: {
							id: { in: requestIds },
							fundWalletId: fundWallet.id,
							status: FundDistributionStatus.Pending,
							transactionId: transaction.id,
						},
						data: { status: FundDistributionStatus.Submitted, txHash, batchId },
					});
					if (submitted.count !== requestIds.length) throw claimError('BATCH_OWNERSHIP_LOST');
					await webhookEventsService.queueFundDistributionSent(
						tx,
						{ ...batchPayload, txHash },
						fundWallet.paymentSourceId,
					);
					return submitted.count;
				},
				{ isolationLevel: 'Serializable' },
			),
		{ label: 'fund-distribution-record-submission' },
	);

	if (submittedCount !== requestIds.length) {
		logger.error('Fund distribution broadcast recorded without owning every request', {
			component: 'fund_distribution',
			fund_wallet_id: fundWallet.id,
			batch_id: batchId,
			tx_hash: txHash,
			expected_request_count: requestIds.length,
			submitted_request_count: submittedCount,
		});
		return;
	}

	logger.info('Fund distribution transaction submitted', {
		component: 'fund_distribution',
		fund_wallet_id: fundWallet.id,
		tx_hash: txHash,
		batch_id: batchId,
		recipient_count: affordableRequests.length,
	});
}
