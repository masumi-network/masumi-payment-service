import { Network, RPCProvider } from '@/generated/prisma/client';
import { z } from '@/utils/zod-openapi';
import { lowBalanceSummarySchema } from '@/routes/api/wallet/low-balance.schemas';

export const paymentSourceExtendedSchemaInput = z.object({
	take: z.coerce.number().min(1).max(100).default(10).describe('The number of payment sources to return'),
	cursorId: z.string().max(250).optional().describe('Used to paginate through the payment sources'),
});

export const paymentSourceExtendedOutputSchema = z
	.object({
		id: z.string().describe('Unique identifier for the payment source'),
		createdAt: z.date().describe('Timestamp when the payment source was created'),
		updatedAt: z.date().describe('Timestamp when the payment source was last updated'),
		network: z.nativeEnum(Network).describe('The Cardano network'),
		policyId: z.string().nullable().describe('Policy ID for the agent registry NFTs. Null if not applicable'),
		smartContractAddress: z.string().describe('Address of the smart contract for this payment source'),
		PaymentSourceConfig: z
			.object({
				rpcProviderApiKey: z.string().describe('The RPC provider API key (e.g., Blockfrost project ID)'),
				rpcProvider: z.nativeEnum(RPCProvider).describe('The RPC provider type (e.g., Blockfrost)'),
			})
			.describe('RPC provider configuration for blockchain interactions'),
		lastIdentifierChecked: z
			.string()
			.nullable()
			.describe('Last agent identifier checked during registry sync. Null if not synced yet'),
		syncInProgress: z.boolean().describe('Whether a registry sync is currently in progress'),
		lastCheckedAt: z.date().nullable().describe('Timestamp when the registry was last synced. Null if never synced'),
		AdminWallets: z
			.array(
				z.object({
					walletAddress: z.string().describe('Cardano address of the admin wallet'),
					order: z.number().describe('Order/index of this admin wallet (0-2)'),
				}),
			)
			.describe('List of admin wallets for dispute resolution (exactly 3 required)'),
		PurchasingWallets: z
			.array(
				z.object({
					id: z.string().describe('Unique identifier for the purchasing wallet'),
					walletVkey: z.string().describe('Payment key hash of the purchasing wallet'),
					walletAddress: z.string().describe('Cardano address of the purchasing wallet'),
					collectionAddress: z
						.string()
						.nullable()
						.describe('Optional collection address for this wallet. Null if not set'),
					note: z.string().nullable().describe('Optional note about this wallet. Null if not set'),
					LowBalanceSummary: lowBalanceSummarySchema.describe('Aggregated low-balance status for the wallet'),
				}),
			)
			.describe('List of wallets used for purchasing (buyer side)'),
		SellingWallets: z
			.array(
				z.object({
					id: z.string().describe('Unique identifier for the selling wallet'),
					walletVkey: z.string().describe('Payment key hash of the selling wallet'),
					walletAddress: z.string().describe('Cardano address of the selling wallet'),
					collectionAddress: z
						.string()
						.nullable()
						.describe('Optional collection address for this wallet. Null if not set'),
					note: z.string().nullable().describe('Optional note about this wallet. Null if not set'),
					LowBalanceSummary: lowBalanceSummarySchema.describe('Aggregated low-balance status for the wallet'),
				}),
			)
			.describe('List of wallets used for selling (seller side)'),
		FeeReceiverNetworkWallet: z
			.object({
				walletAddress: z.string().describe('Cardano address that receives network fees'),
			})
			.describe('Wallet that receives network fees from transactions'),
		feeRatePermille: z.number().min(0).max(1000).describe('Fee rate in permille (per thousand). Example: 50 = 5%'),
	})
	.openapi('PaymentSourceExtended');

export const paymentSourceExtendedSchemaOutput = z.object({
	ExtendedPaymentSources: z
		.array(paymentSourceExtendedOutputSchema)
		.describe('List of payment sources with extended details including RPC configuration'),
});

export const paymentSourceExtendedCreateSchemaInput = z.object({
	network: z.nativeEnum(Network).describe('The network the payment source will be used on'),
	PaymentSourceConfig: z.object({
		rpcProviderApiKey: z
			.string()
			.max(250)
			.describe('The rpc provider (blockfrost) api key to be used for the payment source'),
		rpcProvider: z.nativeEnum(RPCProvider).describe('The rpc provider to be used for the payment source'),
	}),
	feeRatePermille: z.coerce
		.number()
		.min(0)
		.max(1000)
		.describe('The fee in permille to be used for the payment source. The default contract uses 50 (5%)'),
	cooldownTime: z.coerce
		.number()
		.min(0)
		.optional()
		.describe(
			'The cooldown time in milliseconds to be used for the payment source. The default contract uses 1000 * 60 * 7 (7 minutes)',
		),
	AdminWallets: z
		.array(
			z.object({
				walletAddress: z.string().max(250).describe('Cardano address of the admin wallet'),
			}),
		)
		.min(3)
		.max(3)
		.describe('The wallet addresses of the admin wallets (exactly 3)'),
	FeeReceiverNetworkWallet: z
		.object({
			walletAddress: z.string().max(250).describe('Cardano address that receives network fees'),
		})
		.describe('The wallet address of the network fee receiver wallet'),
	PurchasingWallets: z
		.array(
			z.object({
				walletMnemonic: z
					.string()
					.max(1500)
					.describe('24-word mnemonic phrase for the purchasing wallet. IMPORTANT: Backup this securely'),
				collectionAddress: z.string().max(250).nullable().describe('The collection address of the purchasing wallet'),
				note: z.string().max(250).describe('Note about this purchasing wallet'),
			}),
		)
		.min(1)
		.max(50)
		.describe('The mnemonic of the purchasing wallets to be added. Please backup the mnemonic of the wallets.'),
	SellingWallets: z
		.array(
			z.object({
				walletMnemonic: z.string().max(1500).describe('24-word mnemonic phrase for the selling wallet'),
				collectionAddress: z.string().max(250).nullable().describe('The collection address of the selling wallet'),
				note: z.string().max(250).describe('Note about this selling wallet'),
			}),
		)
		.min(1)
		.max(50)
		.describe('The mnemonic of the selling wallets to be added. Please backup the mnemonic of the wallets.'),
});

export const paymentSourceExtendedCreateSchemaOutput = paymentSourceExtendedOutputSchema;

export const paymentSourceExtendedUpdateSchemaInput = z.object({
	id: z.string().max(250).describe('The id of the payment source to be updated'),
	PaymentSourceConfig: z
		.object({
			rpcProviderApiKey: z
				.string()
				.max(250)
				.describe('The rpc provider (blockfrost) api key to be used for the payment source'),
			rpcProvider: z.nativeEnum(RPCProvider).describe('The rpc provider to be used for the payment contract'),
		})
		.optional(),
	AddPurchasingWallets: z
		.array(
			z.object({
				walletMnemonic: z
					.string()
					.max(1500)
					.describe('24-word mnemonic phrase for the purchasing wallet. IMPORTANT: Backup this securely'),
				note: z.string().max(250).describe('Note about this purchasing wallet'),
				collectionAddress: z.string().max(250).nullable().describe('The collection address of the purchasing wallet'),
			}),
		)
		.min(1)
		.max(10)
		.optional()
		.describe('The mnemonic of the purchasing wallets to be added'),
	AddSellingWallets: z
		.array(
			z.object({
				walletMnemonic: z.string().max(1500).describe('24-word mnemonic phrase for the selling wallet'),
				note: z.string().max(250).describe('Note about this selling wallet'),
				collectionAddress: z.string().max(250).nullable().describe('The collection address of the selling wallet'),
			}),
		)
		.min(1)
		.max(10)
		.optional()
		.describe('The mnemonic of the selling wallets to be added'),
	RemovePurchasingWallets: z
		.array(
			z.object({
				id: z.string().describe('ID of the purchasing wallet to remove'),
			}),
		)
		.max(10)
		.optional()
		.describe(
			'The ids of the purchasing wallets to be removed. Please backup the mnemonic of the old wallet before removing it.',
		),
	RemoveSellingWallets: z
		.array(
			z.object({
				id: z.string().describe('ID of the selling wallet to remove'),
			}),
		)
		.max(10)
		.optional()
		.describe(
			'The ids of the selling wallets to be removed. Please backup the mnemonic of the old wallet before removing it.',
		),
	lastIdentifierChecked: z
		.string()
		.max(250)
		.nullable()
		.optional()
		.describe('The latest identifier of the payment source. Usually should not be changed'),
});

export const paymentSourceExtendedUpdateSchemaOutput = paymentSourceExtendedOutputSchema;

export const paymentSourceExtendedDeleteSchemaInput = z.object({
	id: z.string().describe('The id of the payment source to be deleted'),
});

export const paymentSourceExtendedDeleteSchemaOutput = paymentSourceExtendedOutputSchema;
