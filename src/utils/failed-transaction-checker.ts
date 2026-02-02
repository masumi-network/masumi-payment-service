import { prisma } from './db';
import { logger } from './logger';

export async function checkFailedTransactions(): Promise<void> {
	try {
		await checkFailedPayments();
		await checkFailedPurchases();

		// Periodic cleanup of expired cache entries
		cleanupExpiredCacheEntries();
	} catch (error) {
		logger.error('Error checking failed transactions', {
			component: 'transaction_monitoring',
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

async function checkFailedPayments(): Promise<void> {
	// Find payments where the CURRENT NextAction has an error
	const failedPayments = await prisma.paymentRequest.findMany({
		where: {
			NextAction: {
				errorType: { not: null },
			},
		},
		include: {
			NextAction: true,
			PaymentSource: true,
			SmartContractWallet: { select: { id: true, walletAddress: true } },
		},
		take: 100, // Limit batch size
	});

	for (const payment of failedPayments) {
		const action = payment.NextAction;
		const cacheKey = `payment:${payment.id}:${action.updatedAt.getTime()}`;

		if (isAlreadyAlerted(cacheKey)) continue;

		logger.warn('PAYMENT FAILED', {
			alert_type: 'payment_failed',
			component: 'transaction_monitoring',
			payment_id: payment.id,
			blockchain_identifier: payment.blockchainIdentifier,
			error_type: action.errorType,
			error_note: action.errorNote || 'No details provided',
			requested_action: action.requestedAction,
			network: payment.PaymentSource.network,
			payment_source_id: payment.PaymentSource.id,
			smart_contract_wallet_id: payment.SmartContractWallet?.id || 'N/A',
			on_chain_state: payment.onChainState || 'N/A',
			created_at: payment.createdAt.toISOString(),
			error_occurred_at: action.updatedAt.toISOString(),
		});

		markAsAlerted(cacheKey);
	}
}

async function checkFailedPurchases(): Promise<void> {
	// Find purchases where the CURRENT NextAction has an error
	const failedPurchases = await prisma.purchaseRequest.findMany({
		where: {
			NextAction: {
				errorType: { not: null },
			},
		},
		include: {
			NextAction: true,
			PaymentSource: true,
			SmartContractWallet: { select: { id: true, walletAddress: true } },
			SellerWallet: { select: { walletAddress: true } },
		},
		take: 100, // Limit batch size
	});

	for (const purchase of failedPurchases) {
		const action = purchase.NextAction;

		// Create cache key based on purchase ID + action updatedAt
		const cacheKey = `purchase:${purchase.id}:${action.updatedAt.getTime()}`;

		if (isAlreadyAlerted(cacheKey)) continue;

		// Emit OTel log for Signoz alerting
		logger.warn('PURCHASE FAILED', {
			alert_type: 'purchase_failed',
			component: 'transaction_monitoring',
			purchase_id: purchase.id,
			blockchain_identifier: purchase.blockchainIdentifier,
			error_type: action.errorType,
			error_note: action.errorNote || 'No details provided',
			requested_action: action.requestedAction,
			network: purchase.PaymentSource.network,
			payment_source_id: purchase.PaymentSource.id,
			smart_contract_wallet_id: purchase.SmartContractWallet?.id || 'N/A',
			seller_wallet_address: purchase.SellerWallet.walletAddress,
			on_chain_state: purchase.onChainState || 'N/A',
			created_at: purchase.createdAt.toISOString(),
			error_occurred_at: action.updatedAt.toISOString(),
		});

		markAsAlerted(cacheKey);
	}
}

const alertedCache = new Map<string, number>();
const ALERT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_SIZE = 10000;

function isAlreadyAlerted(cacheKey: string): boolean {
	const alertedAt = alertedCache.get(cacheKey);
	if (!alertedAt) return false;

	if (Date.now() - alertedAt > ALERT_CACHE_TTL_MS) {
		alertedCache.delete(cacheKey);
		return false;
	}

	return true;
}

function markAsAlerted(cacheKey: string): void {
	alertedCache.set(cacheKey, Date.now());
}

function cleanupExpiredCacheEntries(): void {
	const now = Date.now();
	let expiredCount = 0;

	for (const [key, alertedAt] of alertedCache.entries()) {
		if (now - alertedAt > ALERT_CACHE_TTL_MS) {
			alertedCache.delete(key);
			expiredCount++;
		}
	}

	if (alertedCache.size > MAX_CACHE_SIZE) {
		const entries = Array.from(alertedCache.entries()).sort((a, b) => a[1] - b[1]);

		const toRemove = entries.slice(0, Math.floor(entries.length / 2));
		for (const [key] of toRemove) {
			alertedCache.delete(key);
		}

		logger.debug('Alert cache cleanup - removed oldest entries', {
			component: 'transaction_monitoring',
			removed: toRemove.length,
			remaining: alertedCache.size,
		});
	}

	if (expiredCount > 0) {
		logger.debug('Alert cache cleanup - expired entries removed', {
			component: 'transaction_monitoring',
			expired_removed: expiredCount,
			remaining: alertedCache.size,
		});
	}
}
