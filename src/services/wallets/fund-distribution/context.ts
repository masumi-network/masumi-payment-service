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
/** Distribution policy for one asset. Amounts are in that asset's own unit. */
export type FundAssetPolicy = {
	assetUnit: string;
	warningThreshold: bigint;
	criticalThreshold: bigint;
	topupAmount: bigint;
};

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
	lowBalanceRules: Map<string, { id: string; lastAlertedAt: Date | null }>;
	paymentSourceId: string;
	paymentSourceType: PaymentSourceType;
	network: Network;
	rpcProviderApiKey: string;
	encryptedMnemonic: string;
	config: {
		batchWindowMs: number;
		/** Per-asset policy, keyed by assetUnit. Empty means nothing to distribute. */
		assets: Map<string, FundAssetPolicy>;
	};
};

const FUND_WALLET_SELECT = {
	id: true,
	walletAddress: true,
	walletVkey: true,
	paymentSourceId: true,
	LowBalanceRules: {
		where: { enabled: true },
		select: { id: true, assetUnit: true, lastAlertedAt: true },
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
			AssetConfigs: {
				select: {
					assetUnit: true,
					warningThreshold: true,
					criticalThreshold: true,
					topupAmount: true,
				},
			},
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
			assets: new Map(wallet.FundDistributionConfig.AssetConfigs.map((asset) => [asset.assetUnit, asset])),
		},
	};
}

/**
 * Resolve the (at most one) enabled fund wallet serving a payment source.
 *
 * Scoping is per payment source by design: a HotWallet carries a required
 * paymentSourceId, and the source carries the network — so a fund wallet can
 * only ever pay addresses on its own chain. A V1 and a V2 source each get
 * their own fund wallet and their own float; distribution never crosses
 * sources. Note `HotWallet.walletVkey` is unique among active wallets, so the
 * same mnemonic cannot back two live fund wallets.
 */
export async function getFundWalletForPaymentSource(paymentSourceId: string): Promise<FundWalletContext | null> {
	const fundWallet = await prisma.hotWallet.findFirst({
		where: {
			paymentSourceId,
			type: HotWalletType.Funding,
			deletedAt: null,
			PaymentSource: { deletedAt: null },
			FundDistributionConfig: { enabled: true },
		},
		select: FUND_WALLET_SELECT,
	});

	return toContext(fundWallet);
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
