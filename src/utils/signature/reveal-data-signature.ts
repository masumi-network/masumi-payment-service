import { prisma } from '@masumi/payment-core/db';
import { CONSTANTS } from '@masumi/payment-core/config';
import { checkSignature, resolvePaymentKeyHash } from '@meshsdk/core';
import stringify from 'canonical-json';
import { isCardanoAddress } from '@/utils/shared/cardano-address';
import { z } from '@masumi/payment-core/zod';
import { Network, OnChainState, PaymentSourceType } from '@/generated/prisma/client';
import { resolveSellerHotWalletId } from '@/services/dispute-disclosure/lookup';
import type { DisputedRequestKind } from '@/services/dispute-disclosure/lookup';
export const revealDataActionSchema = z
	.enum(['RevealData', 'reveal_data'])
	.describe('CIP-8 payload action for disclosure authorization');

export const revealDataSignatureInputSchema = z.object({
	signature: z.string().max(7500).describe('Cryptographic signature from the admin wallet'),
	key: z.string().max(2500).describe('Public key used to create the signature'),
	walletAddress: z
		.string()
		.min(58)
		.max(250)
		.regex(/^(addr1|addr_test1)[0-9a-z]+$/, 'walletAddress must be a bech32 Cardano address')
		.refine(isCardanoAddress, 'walletAddress must be a valid Cardano address')
		.describe('Cardano address of the admin wallet signing the request'),
	validUntil: z
		.number()
		.min(0)
		.max(1000000000000000000)
		.describe('Unix timestamp (in milliseconds) until which this signature is valid'),
	blockchainIdentifier: z
		.string()
		.min(1)
		.max(2500)
		.describe('The blockchain identifier for which data may be disclosed'),
	action: revealDataActionSchema,
});

export type RevealDataSignatureInput = z.infer<typeof revealDataSignatureInputSchema>;

export type RevealDataPaymentContext = {
	requestKind: DisputedRequestKind;
	blockchainIdentifier: string;
	inputHash: string;
	resultHash: string | null;
	smartContractWalletId: string | null;
	sellerHotWalletId: string | null;
	network: Network;
	adminWalletAddresses: string[];
};

const disputedV2SourceFilter = {
	paymentSourceType: PaymentSourceType.Web3CardanoV2,
	deletedAt: null,
};

const canonicalRevealMessage = (
	input: Pick<RevealDataSignatureInput, 'action' | 'validUntil' | 'blockchainIdentifier'>,
) =>
	stringify({
		action: input.action === 'RevealData' ? 'RevealData' : 'reveal_data',
		validUntil: input.validUntil,
		blockchainIdentifier: input.blockchainIdentifier,
	});

export async function loadDisputedPaymentContext(
	blockchainIdentifier: string,
): Promise<RevealDataPaymentContext | null> {
	const purchase = await prisma.purchaseRequest.findFirst({
		where: {
			blockchainIdentifier,
			onChainState: OnChainState.Disputed,
			PaymentSource: disputedV2SourceFilter,
		},
		include: {
			PaymentSource: { include: { AdminWallets: true } },
			SellerWallet: true,
		},
	});
	if (purchase != null) {
		return {
			requestKind: 'purchase',
			blockchainIdentifier: purchase.blockchainIdentifier,
			inputHash: purchase.inputHash,
			resultHash: purchase.resultHash,
			smartContractWalletId: purchase.smartContractWalletId,
			sellerHotWalletId: await resolveSellerHotWalletId({
				paymentSourceId: purchase.paymentSourceId,
				sellerWalletVkey: purchase.SellerWallet.walletVkey,
			}),
			network: purchase.PaymentSource.network,
			adminWalletAddresses: purchase.PaymentSource.AdminWallets.map((wallet) => wallet.walletAddress),
		};
	}

	const payment = await prisma.paymentRequest.findFirst({
		where: {
			blockchainIdentifier,
			onChainState: OnChainState.Disputed,
			PaymentSource: disputedV2SourceFilter,
		},
		include: {
			PaymentSource: { include: { AdminWallets: true } },
		},
	});
	if (payment == null) {
		return null;
	}

	return {
		requestKind: 'payment',
		blockchainIdentifier: payment.blockchainIdentifier,
		inputHash: payment.inputHash,
		resultHash: payment.resultHash,
		smartContractWalletId: payment.smartContractWalletId,
		sellerHotWalletId: payment.smartContractWalletId,
		network: payment.PaymentSource.network,
		adminWalletAddresses: payment.PaymentSource.AdminWallets.map((wallet) => wallet.walletAddress),
	};
}

export async function verifyRevealDataSignature(
	input: RevealDataSignatureInput,
	context: RevealDataPaymentContext,
): Promise<boolean> {
	const isAdminWallet = context.adminWalletAddresses.some(
		(adminWallet) => resolvePaymentKeyHash(adminWallet) === resolvePaymentKeyHash(input.walletAddress),
	);
	if (!isAdminWallet) {
		return false;
	}

	if (Date.now() > input.validUntil) {
		return false;
	}
	if (Date.now() + CONSTANTS.REVEAL_DATA_VALIDITY_TIME < input.validUntil) {
		return false;
	}

	const message = canonicalRevealMessage(input);
	return checkSignature(
		message,
		{
			signature: input.signature,
			key: input.key,
		},
		input.walletAddress,
	);
}
