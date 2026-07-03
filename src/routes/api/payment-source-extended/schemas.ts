import { Network, PaymentSourceType, RPCProvider } from '@/generated/prisma/client';
import { z } from '@masumi/payment-core/zod';

export const paymentSourceExtendedSchemaInput = z.object({
	take: z.coerce.number().min(1).max(100).default(10).describe('The number of payment sources to return'),
	cursorId: z.string().max(250).optional().describe('Used to paginate through the payment sources'),
	network: z
		.nativeEnum(Network)
		.optional()
		.describe('Restrict results to a single Cardano network (still bounded by the key network limit)'),
});

export const paymentSourceExtendedOutputSchema = z
	.object({
		id: z.string().describe('Unique identifier for the payment source'),
		createdAt: z.date().describe('Timestamp when the payment source was created'),
		updatedAt: z.date().describe('Timestamp when the payment source was last updated'),
		network: z.nativeEnum(Network).describe('The Cardano network'),
		paymentSourceType: z.nativeEnum(PaymentSourceType).describe('Payment source type for adapter dispatch'),
		requiredAdminSignatures: z
			.number()
			.int()
			.nullable()
			.describe('Required weighted admin signatures for Web3CardanoV2 sources. Null for Web3CardanoV1.'),
		policyId: z.string().nullable().describe('Policy ID for the agent registry NFTs. Null if not applicable'),
		smartContractAddress: z.string().describe('Address of the smart contract for this payment source'),
		contractSyncStatus: z
			.enum(['in_sync', 'outdated_contract', 'custom_address'])
			.describe(
				'Whether a Web3CardanoV2 source is on the current on-chain contract. ' +
					'"outdated_contract": registry policyId differs from the current default (retired contract — agents ' +
					'orphaned, payment address stale); "custom_address": current version but a non-default admin-wallet ' +
					'address; "in_sync": matches the current default (also for V1 and any non-V2 source).',
			),
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
		PurchasingWalletsCount: z
			.number()
			.int()
			.describe('Number of active purchasing wallets. Fetch the wallets themselves via GET /wallet/list.'),
		SellingWalletsCount: z
			.number()
			.int()
			.describe('Number of active selling wallets. Fetch the wallets themselves via GET /wallet/list.'),
		FeeReceiverNetworkWallet: z
			.object({
				walletAddress: z.string().describe('Cardano address that receives network fees'),
			})
			.nullable()
			.describe('Wallet that receives network fees from transactions'),
		feeRatePermille: z.number().min(0).max(1000).describe('Fee rate in permille (per thousand). Example: 50 = 5%'),
	})
	.openapi('PaymentSourceExtended');

export const paymentSourceExtendedSchemaOutput = z.object({
	ExtendedPaymentSources: z
		.array(paymentSourceExtendedOutputSchema)
		.describe('List of payment sources with extended details including RPC configuration'),
});

export const paymentSourceExtendedCreateSchemaInput = z
	.object({
		network: z.nativeEnum(Network).describe('The network the payment source will be used on'),
		paymentSourceType: z
			.nativeEnum(PaymentSourceType)
			.optional()
			.default(PaymentSourceType.Web3CardanoV1)
			.describe(
				'The payment source type to create. Defaults to Web3CardanoV1 for backward compatibility: ' +
					'pre-V2 automation that omits this field (and supplies feeRatePermille / FeeReceiverNetworkWallet / ' +
					'3 admin wallets) continues to create a V1 source unchanged. New V2 callers must set this explicitly ' +
					'(the admin UI does).',
			),
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
			.optional()
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
			.min(1)
			.max(50)
			.describe(
				'V2 admin wallet slots. Repeated addresses ARE permitted and intentional: each entry is an independent voting slot, ' +
					'so the same Cardano address can be added multiple times to give that key proportionally more weight in the M-of-N quorum. ' +
					'Example: [addrA, addrA, addrB] with requiredAdminSignatures=2 means addrA alone satisfies the quorum (2 weighted slots) ' +
					'while addrB alone does not. No distinct-address check is enforced server-side — duplicates are by design, not a bug. ' +
					'Auditing operators must reason about effective vote weight, not raw row count.',
			),
		requiredAdminSignatures: z.coerce
			.number()
			.int()
			.min(1)
			.max(50)
			.optional()
			.describe(
				'Required weighted admin signatures for Web3CardanoV2 dispute settlement. Minimum 1 (single-admin custody is allowed by design — ' +
					'operators choosing this trade fast settlement for centralized control). Weight is counted by AdminWallets row position, ' +
					'so duplicate addresses inflate effective weight; see AdminWallets docs.',
			),
		FeeReceiverNetworkWallet: z
			.object({
				walletAddress: z.string().max(250).describe('Cardano address that receives network fees'),
			})
			.optional()
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
	})
	.superRefine((input, ctx) => {
		if (input.paymentSourceType === PaymentSourceType.Web3CardanoV1) {
			if (input.AdminWallets.length !== 3) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['AdminWallets'],
					message: 'Web3CardanoV1 payment sources require exactly 3 admin wallets',
				});
			}
			if (input.feeRatePermille == null) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['feeRatePermille'],
					message: 'feeRatePermille is required for Web3CardanoV1 payment sources',
				});
			}
			if (input.FeeReceiverNetworkWallet == null) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['FeeReceiverNetworkWallet'],
					message: 'FeeReceiverNetworkWallet is required for Web3CardanoV1 payment sources',
				});
			}
		}

		if (
			input.paymentSourceType === PaymentSourceType.Web3CardanoV2 &&
			input.feeRatePermille != null &&
			input.feeRatePermille !== 0
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['feeRatePermille'],
				message: 'Web3CardanoV2 payment sources must use a zero fee rate',
			});
		}
		if (input.paymentSourceType === PaymentSourceType.Web3CardanoV2) {
			if (input.AdminWallets.length < 1) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['AdminWallets'],
					message: 'Web3CardanoV2 payment sources require at least 1 admin wallet slot',
				});
			}
			if (input.requiredAdminSignatures == null) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['requiredAdminSignatures'],
					message: 'requiredAdminSignatures is required for Web3CardanoV2 payment sources',
				});
			} else if (input.requiredAdminSignatures < 1) {
				// Lower bound is 1, not 2: single-admin custody is an intentional configuration
				// (fast settlement, centralized control). Operators choosing M>=2 must pick that
				// trade-off explicitly. Repeated AdminWallets addresses count as weighted slots
				// (see AdminWallets describe) — server does NOT enforce distinct addresses.
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['requiredAdminSignatures'],
					message: 'requiredAdminSignatures must be at least 1',
				});
			} else if (input.requiredAdminSignatures > input.AdminWallets.length) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['requiredAdminSignatures'],
					message: 'requiredAdminSignatures cannot exceed the weighted admin wallet count',
				});
			}
		}
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
