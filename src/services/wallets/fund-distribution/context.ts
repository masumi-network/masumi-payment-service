import { HotWalletType, Network, PaymentSourceType, Prisma } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';

/**
 * Everything a distribution cycle needs about a fund wallet, resolved once so
 * the batch executor never re-queries mid-flow.
 *
 * `network` is the Prisma `Network` enum rather than a bare string: the value
 * is threaded into Blockfrost lookups and the tx builder, and a stringly-typed
 * network here previously forced `as` casts at every call site.
 */
export type FundWalletContext = {
	id: string;
	walletAddress: string;
	walletVkey: string;
	/**
	 * The fund wallet's own low-balance rules, keyed by assetUnit. Keyed rather
	 * than a single rule because the treasury can be short of one asset while
	 * flush with another, and the alert has to name which. A missing key means
	 * "no rule for that asset": the alert is skipped rather than emitted with a
	 * dangling empty ruleId.
	 */
	lowBalanceRules: Map<string, { id: string; thresholdAmount: bigint; lastAlertedAt: Date | null }>;
	paymentSourceId: string;
	paymentSourceType: PaymentSourceType;
	network: Network;
	rpcProviderApiKey: string;
	encryptedMnemonic: string;
	config: {
		batchWindowMs: number;
	};
};

const FUND_WALLET_SELECT = {
	id: true,
	createdAt: true,
	walletAddress: true,
	walletVkey: true,
	paymentSourceId: true,
	LowBalanceRules: {
		where: { enabled: true },
		select: { id: true, assetUnit: true, thresholdAmount: true, lastAlertedAt: true },
	},
	Secret: { select: { encryptedMnemonic: true } },
	PaymentSource: {
		select: {
			network: true,
			paymentSourceType: true,
			PaymentSourceConfig: { select: { rpcProviderApiKey: true } },
		},
	},
	FundDistributionConfig: {
		select: {
			enabled: true,
			batchWindowMs: true,
		},
	},
} satisfies Prisma.HotWalletSelect;

type FundWalletRow = Prisma.HotWalletGetPayload<{ select: typeof FUND_WALLET_SELECT }>;

function toContext(wallet: FundWalletRow | null): FundWalletContext | null {
	if (
		!wallet?.Secret ||
		!wallet.FundDistributionConfig?.enabled ||
		!wallet.PaymentSource.PaymentSourceConfig?.rpcProviderApiKey
	) {
		return null;
	}

	return {
		id: wallet.id,
		walletAddress: wallet.walletAddress,
		walletVkey: wallet.walletVkey,
		lowBalanceRules: new Map(wallet.LowBalanceRules.map((rule) => [rule.assetUnit, rule])),
		paymentSourceId: wallet.paymentSourceId,
		paymentSourceType: wallet.PaymentSource.paymentSourceType,
		network: wallet.PaymentSource.network,
		rpcProviderApiKey: wallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey,
		encryptedMnemonic: wallet.Secret.encryptedMnemonic,
		config: {
			batchWindowMs: wallet.FundDistributionConfig.batchWindowMs,
		},
	};
}

/**
 * All enabled fund wallets serving a payment source, oldest first.
 *
 * A source may have several fund wallets (redundancy / capacity): any of them
 * can fund any shortage. Order is deterministic by `createdAt` so the "source
 * policy" (the first wallet configuring a given asset) and the "first with
 * funds" dispatch choice are stable across cycles.
 */
export async function getFundWalletsForPaymentSource(paymentSourceId: string): Promise<FundWalletContext[]> {
	const fundWallets = await prisma.hotWallet.findMany({
		where: {
			paymentSourceId,
			type: HotWalletType.Funding,
			deletedAt: null,
			PaymentSource: { deletedAt: null },
			FundDistributionConfig: { enabled: true },
		},
		orderBy: { createdAt: 'asc' },
		select: FUND_WALLET_SELECT,
	});

	return fundWallets.map(toContext).filter((context): context is FundWalletContext => context != null);
}

/** Resolve a fund wallet by its own id. Returns null if disabled or deleted. */
export async function loadFundWalletContext(fundWalletId: string): Promise<FundWalletContext | null> {
	const wallet = await prisma.hotWallet.findFirst({
		where: {
			id: fundWalletId,
			type: HotWalletType.Funding,
			deletedAt: null,
			PaymentSource: { deletedAt: null },
		},
		select: FUND_WALLET_SELECT,
	});

	return toContext(wallet);
}
