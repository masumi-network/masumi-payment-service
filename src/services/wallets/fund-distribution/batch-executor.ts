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
		await webhookEventsService.triggerWalletLowBalance({
			ruleId: fundWallet.lowBalanceRuleId,
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
		return;
	}

	const affordableRequests = requests.filter((req) => {
		if (req.amount <= remainingBalance) {
			remainingBalance -= req.amount;
			return true;
		}
		return false;
	});

	if (affordableRequests.length === 0) {
		logger.warn('Fund wallet cannot afford any pending distributions', {
			component: 'fund_distribution',
			fund_wallet_id: fundWallet.id,
			balance: fundWalletBalance.toString(),
			first_request_amount: requests[0]?.amount.toString(),
		});
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
		transaction = await prisma.$transaction(async (tx) => {
			const currentWallet = await tx.hotWallet.findUnique({
				where: { id: fundWallet.id },
				select: { lockedAt: true, pendingTransactionId: true },
			});

			if (currentWallet == null) {
				throw Object.assign(new Error('WALLET_NOT_FOUND'), { code: 'WALLET_NOT_FOUND' });
			}
			if (currentWallet.lockedAt != null || currentWallet.pendingTransactionId != null) {
				throw Object.assign(new Error('WALLET_LOCKED'), { code: 'WALLET_LOCKED' });
			}

			const newTx = await tx.transaction.create({
				data: {
					txHash: null,
					status: TransactionStatus.Pending,
				},
			});

			await tx.hotWallet.update({
				where: { id: fundWallet.id, deletedAt: null },
				data: {
					lockedAt: new Date(),
					pendingTransactionId: newTx.id,
				},
			});

			await tx.fundDistributionRequest.updateMany({
				where: { id: { in: batchRequestIds } },
				data: { transactionId: newTx.id, batchId },
			});

			return newTx;
		});
	} catch (error) {
		if (error instanceof Error && (error as { code?: string }).code === 'WALLET_LOCKED') {
			logger.info('Fund wallet is locked, skipping distribution cycle', {
				component: 'fund_distribution',
				fund_wallet_id: fundWallet.id,
			});
			return;
		}
		if (error instanceof Error && (error as { code?: string }).code === 'WALLET_NOT_FOUND') {
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
		await prisma.$transaction([
			prisma.hotWallet.update({
				where: { id: fundWallet.id, deletedAt: null },
				data: { lockedAt: null, pendingTransactionId: null },
			}),
			prisma.transaction.delete({ where: { id: transaction.id } }),
		]);
		await prisma.fundDistributionRequest.updateMany({
			where: { id: { in: requestIds } },
			data: { status: FundDistributionStatus.Failed, error: errorMsg, batchId },
		});
		// Tell operators the top-up did not happen. These wallets are still low
		// and no funds moved, so this is the actionable signal.
		await webhookEventsService.triggerFundDistributionFailed({
			...batchPayload,
			txHash: null,
			error: errorMsg,
		});
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
				prisma.transaction.update({
					where: { id: transaction.id },
					data: {
						intendedTxHash: signed.intendedTxHash,
						invalidHereafterSlot: BigInt(signed.invalidHereafterSlot),
						lastCheckedAt: new Date(),
					},
				}),
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

	// Update transaction with hash
	await prisma.transaction.update({
		where: { id: transaction.id },
		data: { txHash },
	});

	// Mark requests as submitted
	await prisma.fundDistributionRequest.updateMany({
		where: { id: { in: requestIds } },
		data: { status: FundDistributionStatus.Submitted, txHash, batchId },
	});

	logger.info('Fund distribution transaction submitted', {
		component: 'fund_distribution',
		fund_wallet_id: fundWallet.id,
		tx_hash: txHash,
		batch_id: batchId,
		recipient_count: affordableRequests.length,
	});

	// Submission only. The confirm phase emits CONFIRMED or FAILED once the
	// chain has spoken — an operator who saw only this event would never learn
	// whether the top-up actually landed.
	await webhookEventsService.triggerFundDistributionSent({ ...batchPayload, txHash });
}
