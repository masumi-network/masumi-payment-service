import { creditTokenRepository } from '@/repositories/creditTokens';
import { InsufficientFundsError } from '@/utils/errors/insufficient-funds-error';
import { logger } from '@/utils/logger';
import { Network, PricingType, PurchasingAction } from '@/generated/prisma/client';
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
	initialNextAction,
	collateralReturnLovelace,
	buyerWalletAddress,
	buyerWalletVkey,
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
	initialNextAction?: PurchasingAction;
	collateralReturnLovelace?: bigint;
	buyerWalletAddress?: string;
	buyerWalletVkey?: string;
}) {
	let remainingAttempts = 5;
	while (remainingAttempts > 0) {
		try {
			return await creditTokenRepository.handlePurchaseCreditInit({
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
				initialNextAction,
				collateralReturnLovelace,
				buyerWalletAddress,
				buyerWalletVkey,
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
