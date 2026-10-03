import { runPurchaseCreditInitTransaction } from './credit-init-transaction';
import { InsufficientFundsError } from '@masumi/payment-core/insufficient-funds-error';
import { logger } from '@masumi/payment-core/logger';
import { Network, PricingType, TransactionLayer } from '@/generated/prisma/client';
import createHttpError from 'http-errors';

export async function handlePurchaseCreditInit({
	id,
	walletScopeIds,
	cost,
	metadata,
	network,
	blockchainIdentifier,
	contractAddress,
	sellerVkey,
	sellerAddress,
	payByTime,
	submitResultTime,
	externalDisputeUnlockTime,
	unlockTime,
	inputHash,
	pricingType,
	collateralReturnLovelace,
	buyerReturnAddress,
	sellerReturnAddress,
	agentName,
	forceLayer,
	paymentForceLayer,
}: {
	id: string;
	walletScopeIds: string[] | null;
	cost: Array<{ amount: bigint; unit: string }>;
	metadata: string | null | undefined;
	network: Network;
	blockchainIdentifier: string;
	contractAddress: string;
	sellerVkey: string;
	sellerAddress: string;
	payByTime: bigint;
	submitResultTime: bigint;
	externalDisputeUnlockTime: bigint;
	unlockTime: bigint;
	inputHash: string;
	pricingType: PricingType;
	collateralReturnLovelace?: bigint;
	buyerReturnAddress?: string | null;
	sellerReturnAddress?: string | null;
	agentName?: string | null;
	forceLayer?: TransactionLayer | null;
	paymentForceLayer?: TransactionLayer | null;
}) {
	let remainingAttempts = 5;
	while (remainingAttempts > 0) {
		try {
			return await runPurchaseCreditInitTransaction({
				id,
				walletScopeIds,
				cost,
				metadata,
				network,
				blockchainIdentifier,
				contractAddress,
				sellerVkey,
				sellerAddress,
				payByTime,
				submitResultTime,
				externalDisputeUnlockTime,
				unlockTime,
				inputHash,
				pricingType,
				collateralReturnLovelace,
				buyerReturnAddress,
				sellerReturnAddress,
				agentName,
				forceLayer,
				paymentForceLayer,
			});
		} catch (error) {
			if (error instanceof InsufficientFundsError) {
				throw createHttpError(400, 'Insufficient funds');
			}
			logger.warn(error);
			await new Promise((resolve) => setTimeout(resolve, Math.random() * 300));
			remainingAttempts--;
		}
	}
	throw createHttpError(500, 'Error handling payment credit initialization, after please try again later');
}
