import { HotWalletType, Network, PaymentSourceType } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { recordBusinessEndpointError } from '@masumi/payment-core/metrics';
import { assertHotWalletInScope } from '@/utils/shared/wallet-scope';
import createHttpError from 'http-errors';

type ResolveScopedSellingWalletParams = {
	network: Network;
	sellingWalletVkey: string;
	walletScopeIds: string[] | null;
	metricPath: string;
	operation: string;
};

type ScopedSellingWallet = {
	id: string;
	paymentSourceId: string;
	walletVkey: string;
	walletAddress: string;
	PaymentSource: {
		paymentSourceType: PaymentSourceType;
		smartContractAddress: string;
		network: Network;
		PaymentSourceConfig: {
			rpcProviderApiKey: string;
		};
	};
};

type ResolveScopedRecipientWalletParams = {
	network: Network;
	recipientWalletAddress?: string;
	sellingWallet: {
		walletAddress: string;
		paymentSourceId: string;
	};
	walletScopeIds: string[] | null;
	metricPath: string;
	operation: string;
};

type ScopedRecipientWallet = {
	id: string;
	walletVkey: string;
	walletAddress: string;
};

export async function resolveScopedSellingWalletOrThrow({
	network,
	sellingWalletVkey,
	walletScopeIds,
	metricPath,
	operation,
}: ResolveScopedSellingWalletParams): Promise<ScopedSellingWallet> {
	// findFirst, not findUnique: walletVkey is unique only among ACTIVE wallets
	// (partial index, see prisma/schema.prisma), so it is no longer a Prisma
	// unique key. The deletedAt: null filter below preserves at-most-one
	// semantics for this lookup.
	const sellingWallet = await prisma.hotWallet.findFirst({
		where: {
			walletVkey: sellingWalletVkey,
			type: HotWalletType.Selling,
			deletedAt: null,
			PaymentSource: {
				deletedAt: null,
				network,
			},
		},
		include: {
			PaymentSource: {
				include: {
					PaymentSourceConfig: {
						select: { rpcProviderApiKey: true },
					},
				},
			},
		},
	});

	if (sellingWallet == null) {
		recordBusinessEndpointError(metricPath, 'POST', 404, 'Network and Address combination not supported', {
			network,
			operation,
			step: 'wallet_lookup',
			wallet_vkey: sellingWalletVkey,
		});
		throw createHttpError(404, 'Network and Address combination not supported');
	}

	assertHotWalletInScope(walletScopeIds, sellingWallet.id);
	return sellingWallet;
}

export async function resolveScopedRecipientWalletOrThrow({
	network,
	recipientWalletAddress,
	sellingWallet,
	walletScopeIds,
	metricPath,
	operation,
}: ResolveScopedRecipientWalletParams): Promise<ScopedRecipientWallet | null> {
	const normalizedRecipientWalletAddress = recipientWalletAddress?.trim();
	if (!normalizedRecipientWalletAddress || normalizedRecipientWalletAddress === sellingWallet.walletAddress) {
		return null;
	}

	const recipientWallet = await prisma.hotWallet.findFirst({
		where: {
			walletAddress: normalizedRecipientWalletAddress,
			paymentSourceId: sellingWallet.paymentSourceId,
			deletedAt: null,
		},
		select: {
			id: true,
			walletVkey: true,
			walletAddress: true,
		},
	});

	if (recipientWallet == null) {
		recordBusinessEndpointError(metricPath, 'POST', 404, 'Recipient wallet not found on the same payment source', {
			network,
			operation,
			step: 'recipient_wallet_lookup',
			recipient_wallet_address: normalizedRecipientWalletAddress,
		});
		throw createHttpError(404, 'Recipient wallet not found on the same payment source');
	}

	assertHotWalletInScope(walletScopeIds, recipientWallet.id);
	return recipientWallet;
}
