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

	const payment = await prisma.paymentRequest.findFirst({ where: disputedFilter });
	if (payment != null) {
		return {
			kind: 'payment',
			...payment,
			sellerHotWalletId: payment.smartContractWalletId,
		};
	}

	const purchase = await prisma.purchaseRequest.findFirst({
		where: disputedFilter,
		include: { SellerWallet: true },
	});
	if (purchase != null) {
		const sellingWallet = await prisma.hotWallet.findFirst({
			where: {
				paymentSourceId: purchase.paymentSourceId,
				type: HotWalletType.Selling,
				deletedAt: null,
				walletVkey: purchase.SellerWallet.walletVkey,
			},
			select: { id: true },
		});
		return {
			kind: 'purchase',
			...purchase,
			sellerHotWalletId: sellingWallet?.id ?? null,
		};
	}

	return null;
}
