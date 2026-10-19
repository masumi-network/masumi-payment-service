import { prisma } from '@masumi/payment-core/db';
import { HotWalletType, Network, OnChainState, PaymentSourceType } from '@/generated/prisma/client';

export type DisputedRequestKind = 'payment' | 'purchase';

export type DisputedRequestRow = {
	kind: DisputedRequestKind;
	blockchainIdentifier: string;
	inputHash: string;
	resultHash: string | null;
	smartContractWalletId: string | null;
	requestedById: string;
	/** Selling hot wallet for purchase disputes; null for payment disputes. */
	sellerHotWalletId: string | null;
};

export async function findDisputedV2Request(params: {
	blockchainIdentifier: string;
	network: Network;
}): Promise<DisputedRequestRow | null> {
	const sourceFilter = {
		network: params.network,
		paymentSourceType: PaymentSourceType.Web3CardanoV2,
		deletedAt: null,
	};
	const disputedFilter = {
		blockchainIdentifier: params.blockchainIdentifier,
		onChainState: OnChainState.Disputed,
		PaymentSource: sourceFilter,
	} as const;

	const purchase = await prisma.purchaseRequest.findFirst({
		where: disputedFilter,
		include: { SellerWallet: true },
	});
	if (purchase != null) {
		return {
			kind: 'purchase',
			...purchase,
			sellerHotWalletId: await resolveSellerHotWalletId({
				paymentSourceId: purchase.paymentSourceId,
				sellerWalletVkey: purchase.SellerWallet.walletVkey,
			}),
		};
	}

	const payment = await prisma.paymentRequest.findFirst({ where: disputedFilter });
	if (payment != null) {
		return {
			kind: 'payment',
			...payment,
			sellerHotWalletId: payment.smartContractWalletId,
		};
	}

	return null;
}

export async function resolveSellerHotWalletId(params: {
	paymentSourceId: string;
	sellerWalletVkey: string;
}): Promise<string | null> {
	const sellingWallet = await prisma.hotWallet.findFirst({
		where: {
			paymentSourceId: params.paymentSourceId,
			type: HotWalletType.Selling,
			deletedAt: null,
			walletVkey: params.sellerWalletVkey,
		},
		select: { id: true },
	});
	return sellingWallet?.id ?? null;
}
