import { prisma } from '@masumi/payment-core/db';
import { Network, OnChainState, PaymentSourceType } from '@/generated/prisma/client';

export type DisputedRequestKind = 'payment' | 'purchase';

export type DisputedRequestRow = {
	kind: DisputedRequestKind;
	blockchainIdentifier: string;
	inputHash: string;
	resultHash: string | null;
	smartContractWalletId: string | null;
	requestedById: string;
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
		return { kind: 'payment', ...payment };
	}

	const purchase = await prisma.purchaseRequest.findFirst({ where: disputedFilter });
	if (purchase != null) {
		return { kind: 'purchase', ...purchase };
	}

	return null;
}
