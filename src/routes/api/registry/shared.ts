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

export type ResolvedScopedRecipient = {
	hotWallet: ScopedRecipientWallet | null;
	externalAddress: string | null;
};

const BECH32_CARDANO_ADDRESS = /^(addr1|addr_test1)[0-9a-z]+$/;

function assertExternalRecipientMatchesNetwork(address: string, network: Network): void {
	const expectedPrefix = network === Network.Mainnet ? 'addr1' : 'addr_test';
	if (!address.startsWith(expectedPrefix)) {
		throw createHttpError(400, `Recipient wallet address does not match ${network}`);
	}
}

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
	metricPath: _metricPath,
	operation: _operation,
}: ResolveScopedRecipientWalletParams): Promise<ResolvedScopedRecipient> {
	const normalizedRecipientWalletAddress = recipientWalletAddress?.trim();
	if (!normalizedRecipientWalletAddress || normalizedRecipientWalletAddress === sellingWallet.walletAddress) {
		return { hotWallet: null, externalAddress: null };
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

	if (recipientWallet != null) {
		assertHotWalletInScope(walletScopeIds, recipientWallet.id);
		return { hotWallet: recipientWallet, externalAddress: null };
	}

	if (!BECH32_CARDANO_ADDRESS.test(normalizedRecipientWalletAddress)) {
		throw createHttpError(400, 'recipientWalletAddress must be a bech32 Cardano address');
	}
	assertExternalRecipientMatchesNetwork(normalizedRecipientWalletAddress, network);
	return { hotWallet: null, externalAddress: normalizedRecipientWalletAddress };
}
