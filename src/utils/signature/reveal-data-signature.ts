import { prisma } from '@masumi/payment-core/db';
import { CONSTANTS } from '@masumi/payment-core/config';
import { checkSignature, resolvePaymentKeyHash } from '@meshsdk/core';
import stringify from 'canonical-json';
import { isCardanoAddress } from '@/utils/shared/cardano-address';
import { z } from '@masumi/payment-core/zod';
import { Network, OnChainState, PaymentSourceType } from '@/generated/prisma/client';
import { isDisclosureReadWalletInScope } from '@/services/dispute-disclosure/disclosure-read-wallet-scope';
import { resolveSellerHotWalletId } from '@/services/dispute-disclosure/lookup';
import type { DisputedRequestKind } from '@/services/dispute-disclosure/lookup';

export type RevealDataReadScope = {
	walletScopeIds: string[] | null;
	canAdmin?: boolean;
};
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

const v2SourceFilterIncludingDeleted = {
	paymentSourceType: PaymentSourceType.Web3CardanoV2,
};

const canonicalRevealMessage = (
	input: Pick<RevealDataSignatureInput, 'action' | 'validUntil' | 'blockchainIdentifier'>,
) =>
	stringify({
		action: input.action === 'RevealData' ? 'RevealData' : 'reveal_data',
		validUntil: input.validUntil,
		blockchainIdentifier: input.blockchainIdentifier,
	});

async function mapPurchaseToRevealContext(purchase: {
	blockchainIdentifier: string;
	inputHash: string;
	resultHash: string | null;
	smartContractWalletId: string | null;
	paymentSourceId: string;
	PaymentSource: { network: Network; AdminWallets: Array<{ walletAddress: string }> };
	SellerWallet: { walletVkey: string };
}): Promise<RevealDataPaymentContext> {
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

async function loadV2PurchaseForReveal(
	blockchainIdentifier: string,
	disputedOnly: boolean,
	includeDeletedSource = false,
) {
	return prisma.purchaseRequest.findFirst({
		where: {
			blockchainIdentifier,
			...(disputedOnly ? { onChainState: OnChainState.Disputed } : {}),
			PaymentSource: includeDeletedSource ? v2SourceFilterIncludingDeleted : disputedV2SourceFilter,
		},
		include: {
			PaymentSource: { include: { AdminWallets: true } },
			SellerWallet: true,
		},
	});
}

async function loadV2PaymentForReveal(
	blockchainIdentifier: string,
	disputedOnly: boolean,
	includeDeletedSource = false,
) {
	return prisma.paymentRequest.findFirst({
		where: {
			blockchainIdentifier,
			...(disputedOnly ? { onChainState: OnChainState.Disputed } : {}),
			PaymentSource: includeDeletedSource ? v2SourceFilterIncludingDeleted : disputedV2SourceFilter,
		},
		include: {
			PaymentSource: { include: { AdminWallets: true } },
		},
	});
}

async function loadV2PaymentAnyLifecycle(blockchainIdentifier: string) {
	return prisma.paymentRequest.findFirst({
		where: {
			blockchainIdentifier,
			PaymentSource: { paymentSourceType: PaymentSourceType.Web3CardanoV2 },
		},
		include: {
			PaymentSource: { include: { AdminWallets: true } },
		},
		orderBy: { updatedAt: 'desc' },
	});
}

async function loadV2PurchaseAnyLifecycle(blockchainIdentifier: string) {
	return prisma.purchaseRequest.findFirst({
		where: {
			blockchainIdentifier,
			PaymentSource: { paymentSourceType: PaymentSourceType.Web3CardanoV2 },
		},
		include: {
			PaymentSource: { include: { AdminWallets: true } },
			SellerWallet: true,
		},
		orderBy: { updatedAt: 'desc' },
	});
}

export function pickReadRevealContext(
	contexts: RevealDataPaymentContext[],
	readScope?: RevealDataReadScope,
): RevealDataPaymentContext | null {
	if (contexts.length === 0) {
		return null;
	}
	if (readScope == null || readScope.canAdmin === true || readScope.walletScopeIds === null) {
		return contexts.find((context) => context.requestKind === 'payment') ?? contexts[0];
	}
	const ordered = [
		...contexts.filter((context) => context.requestKind === 'purchase'),
		...contexts.filter((context) => context.requestKind === 'payment'),
	];
	for (const context of ordered) {
		if (
			isDisclosureReadWalletInScope(readScope.walletScopeIds, {
				kind: context.requestKind,
				smartContractWalletId: context.smartContractWalletId,
				sellerHotWalletId: context.sellerHotWalletId,
			})
		) {
			return context;
		}
	}
	return null;
}

function mapPaymentRevealContext(payment: {
	blockchainIdentifier: string;
	inputHash: string;
	resultHash: string | null;
	smartContractWalletId: string | null;
	PaymentSource: { network: Network; AdminWallets: Array<{ walletAddress: string }> };
}): RevealDataPaymentContext {
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

async function loadActiveDisputedRevealContexts(blockchainIdentifier: string): Promise<RevealDataPaymentContext[]> {
	const [disputedPayment, disputedPurchase] = await Promise.all([
		loadV2PaymentForReveal(blockchainIdentifier, true),
		loadV2PurchaseForReveal(blockchainIdentifier, true),
	]);
	const contexts: RevealDataPaymentContext[] = [];
	if (disputedPayment != null) {
		contexts.push(mapPaymentRevealContext(disputedPayment));
	}
	if (disputedPurchase != null) {
		contexts.push(await mapPurchaseToRevealContext(disputedPurchase));
	}
	return contexts;
}

async function loadStoredDisclosureRevealContexts(blockchainIdentifier: string): Promise<RevealDataPaymentContext[]> {
	const contexts: RevealDataPaymentContext[] = [];
	const paymentWithDisclosure = await loadV2PaymentForReveal(blockchainIdentifier, false, true);
	if (paymentWithDisclosure != null) {
		contexts.push(mapPaymentRevealContext(paymentWithDisclosure));
	}
	const purchaseWithDisclosure = await loadV2PurchaseForReveal(blockchainIdentifier, false, true);
	if (purchaseWithDisclosure != null) {
		contexts.push(await mapPurchaseToRevealContext(purchaseWithDisclosure));
	}
	if (contexts.length > 0) {
		return contexts;
	}
	const paymentAny = await loadV2PaymentAnyLifecycle(blockchainIdentifier);
	if (paymentAny != null) {
		contexts.push(mapPaymentRevealContext(paymentAny));
	}
	const purchaseAny = await loadV2PurchaseAnyLifecycle(blockchainIdentifier);
	if (purchaseAny != null) {
		contexts.push(await mapPurchaseToRevealContext(purchaseAny));
	}
	return contexts;
}

export async function loadDisputedPaymentContext(
	blockchainIdentifier: string,
	readScope?: RevealDataReadScope,
): Promise<RevealDataPaymentContext | null> {
	const activeContexts = await loadActiveDisputedRevealContexts(blockchainIdentifier);
	const activePick = pickReadRevealContext(activeContexts, readScope);
	if (activePick != null) {
		return activePick;
	}
	if (
		activeContexts.length > 0 &&
		readScope != null &&
		readScope.canAdmin !== true &&
		readScope.walletScopeIds != null
	) {
		return null;
	}

	const storedDisclosure = await prisma.disputeDisclosure.findUnique({
		where: { blockchainIdentifier },
		select: { id: true },
	});
	if (storedDisclosure == null) {
		return null;
	}

	return pickReadRevealContext(await loadStoredDisclosureRevealContexts(blockchainIdentifier), readScope);
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
