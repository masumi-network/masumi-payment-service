import { MeshWallet, BlockfrostProvider, Network } from '@meshsdk/core';
import { logger } from '@/utils/logger';
import { getTransactionRouter } from './transaction-router.service';
import { TransactionSubmitResult, TransactionLayer, UtxoQueryResult } from './types';

/**
 * Common context for transaction submission
 */
interface BaseSubmitContext {
	paymentSourceId: string;
	network: Network;
	wallet: MeshWallet;
	forceLayer?: TransactionLayer;
}

/**
 * Context for purchase-related transactions (buyer side)
 */
interface PurchaseSubmitContext extends BaseSubmitContext {
	purchaseRequestId: string;
	/** Agent ID of the buyer (participant A) */
	buyerAgentId: string;
	/** Agent ID of the seller (participant B) */
	sellerAgentId: string;
}

/**
 * Context for payment-related transactions (seller side)
 */
interface PaymentSubmitContext extends BaseSubmitContext {
	paymentRequestId: string;
	/** Agent ID of the buyer (participant A) */
	buyerAgentId: string;
	/** Agent ID of the seller (participant B) */
	sellerAgentId: string;
}

// ============================================================
// LOCK FUNDS (Hire/Purchase)
// ============================================================

/**
 * Submit a LockFunds transaction (initial payment lock)
 *
 * Used by: cardano-payment-batcher.service.ts
 *
 * @param signedTx - Signed transaction CBOR
 * @param context - Purchase context
 * @returns Transaction result with layer info
 */
export async function submitLockFundsTransaction(
	signedTx: string,
	context: PurchaseSubmitContext,
): Promise<TransactionSubmitResult> {
	logger.info('[SubmitHelper] Submitting LockFunds transaction', {
		purchaseRequestId: context.purchaseRequestId,
	});

	const router = getTransactionRouter();

	return router.submitTransaction(
		signedTx,
		{
			transactionType: 'LockFunds',
			paymentSourceId: context.paymentSourceId,
			purchaseRequestId: context.purchaseRequestId,
			agentIdA: context.buyerAgentId,
			agentIdB: context.sellerAgentId,
			network: context.network,
			forceLayer: context.forceLayer,
		},
		context.wallet,
	);
}

// ============================================================
// SUBMIT RESULT
// ============================================================

/**
 * Submit a SubmitResult transaction (seller submits result hash)
 *
 * Used by: cardano-submit-result-handler.service.ts
 *
 * @param signedTx - Signed transaction CBOR
 * @param context - Payment context
 * @returns Transaction result with layer info
 */
export async function submitResultTransaction(
	signedTx: string,
	context: PaymentSubmitContext,
): Promise<TransactionSubmitResult> {
	logger.info('[SubmitHelper] Submitting SubmitResult transaction', {
		paymentRequestId: context.paymentRequestId,
	});

	const router = getTransactionRouter();

	return router.submitTransaction(
		signedTx,
		{
			transactionType: 'SubmitResult',
			paymentSourceId: context.paymentSourceId,
			paymentRequestId: context.paymentRequestId,
			agentIdA: context.buyerAgentId,
			agentIdB: context.sellerAgentId,
			network: context.network,
			forceLayer: context.forceLayer,
		},
		context.wallet,
	);
}

// ============================================================
// REQUEST REFUND
// ============================================================

/**
 * Submit a RequestRefund transaction (buyer requests refund)
 *
 * Used by: cardano-request-refund-handler.service.ts
 *
 * @param signedTx - Signed transaction CBOR
 * @param context - Purchase context
 * @returns Transaction result with layer info
 */
export async function submitRequestRefundTransaction(
	signedTx: string,
	context: PurchaseSubmitContext,
): Promise<TransactionSubmitResult> {
	logger.info('[SubmitHelper] Submitting RequestRefund transaction', {
		purchaseRequestId: context.purchaseRequestId,
	});

	const router = getTransactionRouter();

	return router.submitTransaction(
		signedTx,
		{
			transactionType: 'RequestRefund',
			paymentSourceId: context.paymentSourceId,
			purchaseRequestId: context.purchaseRequestId,
			agentIdA: context.buyerAgentId,
			agentIdB: context.sellerAgentId,
			network: context.network,
			forceLayer: context.forceLayer,
		},
		context.wallet,
	);
}

// ============================================================
// CANCEL REFUND
// ============================================================

/**
 * Submit a CancelRefund transaction (cancel refund request)
 *
 * Used by: cardano-cancel-refund-handler.service.ts
 *
 * @param signedTx - Signed transaction CBOR
 * @param context - Purchase context
 * @returns Transaction result with layer info
 */
export async function submitCancelRefundTransaction(
	signedTx: string,
	context: PurchaseSubmitContext,
): Promise<TransactionSubmitResult> {
	logger.info('[SubmitHelper] Submitting CancelRefund transaction', {
		purchaseRequestId: context.purchaseRequestId,
	});

	const router = getTransactionRouter();

	return router.submitTransaction(
		signedTx,
		{
			transactionType: 'CancelRefund',
			paymentSourceId: context.paymentSourceId,
			purchaseRequestId: context.purchaseRequestId,
			agentIdA: context.buyerAgentId,
			agentIdB: context.sellerAgentId,
			network: context.network,
			forceLayer: context.forceLayer,
		},
		context.wallet,
	);
}

// ============================================================
// AUTHORIZE REFUND
// ============================================================

/**
 * Submit an AuthorizeRefund transaction (admin/seller authorizes refund)
 *
 * Used by: cardano-authorize-refund-handler.service.ts
 *
 * @param signedTx - Signed transaction CBOR
 * @param context - Payment context
 * @returns Transaction result with layer info
 */
export async function submitAuthorizeRefundTransaction(
	signedTx: string,
	context: PaymentSubmitContext,
): Promise<TransactionSubmitResult> {
	logger.info('[SubmitHelper] Submitting AuthorizeRefund transaction', {
		paymentRequestId: context.paymentRequestId,
	});

	const router = getTransactionRouter();

	return router.submitTransaction(
		signedTx,
		{
			transactionType: 'AuthorizeRefund',
			paymentSourceId: context.paymentSourceId,
			paymentRequestId: context.paymentRequestId,
			agentIdA: context.buyerAgentId,
			agentIdB: context.sellerAgentId,
			network: context.network,
			forceLayer: context.forceLayer,
		},
		context.wallet,
	);
}

// ============================================================
// COLLECT PAYMENT
// ============================================================

/**
 * Submit a CollectPayment transaction (seller collects payment)
 *
 * Used by: cardano-collection-handler.service.ts
 *
 * @param signedTx - Signed transaction CBOR
 * @param context - Payment context
 * @returns Transaction result with layer info
 */
export async function submitCollectPaymentTransaction(
	signedTx: string,
	context: PaymentSubmitContext,
): Promise<TransactionSubmitResult> {
	logger.info('[SubmitHelper] Submitting CollectPayment transaction', {
		paymentRequestId: context.paymentRequestId,
	});

	const router = getTransactionRouter();

	return router.submitTransaction(
		signedTx,
		{
			transactionType: 'CollectPayment',
			paymentSourceId: context.paymentSourceId,
			paymentRequestId: context.paymentRequestId,
			agentIdA: context.buyerAgentId,
			agentIdB: context.sellerAgentId,
			network: context.network,
			forceLayer: context.forceLayer,
		},
		context.wallet,
	);
}

// ============================================================
// COLLECT REFUND
// ============================================================

/**
 * Submit a CollectRefund transaction (buyer collects refund)
 *
 * Used by: cardano-refund-handler.service.ts
 *
 * @param signedTx - Signed transaction CBOR
 * @param context - Purchase context
 * @returns Transaction result with layer info
 */
export async function submitCollectRefundTransaction(
	signedTx: string,
	context: PurchaseSubmitContext,
): Promise<TransactionSubmitResult> {
	logger.info('[SubmitHelper] Submitting CollectRefund transaction', {
		purchaseRequestId: context.purchaseRequestId,
	});

	const router = getTransactionRouter();

	return router.submitTransaction(
		signedTx,
		{
			transactionType: 'CollectRefund',
			paymentSourceId: context.paymentSourceId,
			purchaseRequestId: context.purchaseRequestId,
			agentIdA: context.buyerAgentId,
			agentIdB: context.sellerAgentId,
			network: context.network,
			forceLayer: context.forceLayer,
		},
		context.wallet,
	);
}

// ============================================================
// UTXO QUERIES
// ============================================================

/**
 * Fetch UTXOs for transaction building
 *
 * Routes to L1 (Blockfrost) or L2 (Hydra snapshot) based on head status
 */
export async function fetchUtxosForTransaction(
	address: string,
	context: {
		paymentSourceId: string;
		agentIdA?: string;
		agentIdB?: string;
		network: Network;
		forceLayer?: TransactionLayer;
	},
	blockfrostProvider: BlockfrostProvider,
): Promise<UtxoQueryResult> {
	const router = getTransactionRouter();

	return router.fetchUtxos(
		address,
		{
			transactionType: 'LockFunds', // Type doesn't matter for UTXO queries
			paymentSourceId: context.paymentSourceId,
			agentIdA: context.agentIdA,
			agentIdB: context.agentIdB,
			network: context.network,
			forceLayer: context.forceLayer,
		},
		blockfrostProvider,
	);
}

/**
 * Fetch UTXOs by transaction hash
 */
export async function fetchUtxosByTxHashForTransaction(
	txHash: string,
	context: {
		paymentSourceId: string;
		agentIdA?: string;
		agentIdB?: string;
		network: Network;
		forceLayer?: TransactionLayer;
	},
	blockfrostProvider: BlockfrostProvider,
): Promise<UtxoQueryResult> {
	const router = getTransactionRouter();

	return router.fetchUtxosByTxHash(
		txHash,
		{
			transactionType: 'LockFunds', // Type doesn't matter for UTXO queries
			paymentSourceId: context.paymentSourceId,
			agentIdA: context.agentIdA,
			agentIdB: context.agentIdB,
			network: context.network,
			forceLayer: context.forceLayer,
		},
		blockfrostProvider,
	);
}

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

/**
 * Check if L2 (Hydra) is available for a transaction between two agents.
 * Uses symmetric agent IDs (no buyer/seller distinction).
 */
export async function isHydraAvailable(context: {
	paymentSourceId: string;
	agentIdA: string;
	agentIdB: string;
}): Promise<boolean> {
	const router = getTransactionRouter();
	const layer = await router.determineLayer({
		transactionType: 'LockFunds',
		paymentSourceId: context.paymentSourceId,
		agentIdA: context.agentIdA,
		agentIdB: context.agentIdB,
		network: 'preprod', // Network doesn't affect Hydra availability check
	});

	return layer === 'L2';
}

/**
 * Get current router statistics
 */
export function getRouterStats(): { hydraEnabled: boolean; debugLogging: boolean } {
	const router = getTransactionRouter();
	return router.getStats();
}
