import {
	Network,
	OnChainState,
	PurchaseErrorType,
	PurchasingAction,
	TransactionStatus,
} from '@/generated/prisma/client';
import { z } from '@/utils/zod-openapi';

export const queryPurchaseRequestSchemaInput = z.object({
	limit: z.coerce.number().min(1).max(100).default(10).describe('The number of purchases to return'),
	cursorId: z
		.string()
		.optional()
		.describe('Used to paginate through the purchases. If this is provided, cursorId is required'),
	network: z.nativeEnum(Network).describe('The network the purchases were made on'),
	filterSmartContractAddress: z
		.string()
		.optional()
		.nullable()
		.describe('The smart contract address of the payment source'),
	filterOnChainState: z.nativeEnum(OnChainState).optional().describe('Filter by on-chain state'),
	searchQuery: z
		.string()
		.optional()
		.describe('Search query to filter by ID, hash, state, network, wallet address, or amount'),
	includeHistory: z
		.string()
		.default('false')
		.optional()
		.transform((val) => val?.toLowerCase() == 'true')
		.describe('Whether to include the full transaction and action history of the purchases'),
});

export const queryPurchaseCountSchemaInput = z.object({
	network: z.nativeEnum(Network).describe('The network the purchases were made on'),
	filterSmartContractAddress: z
		.string()
		.optional()
		.nullable()
		.describe('The smart contract address of the payment source'),
});

export const queryPurchaseCountSchemaOutput = z.object({
	total: z.number().describe('Total number of purchases'),
});

export const purchaseResponseSchema = z
	.object({
		id: z.string().describe('Unique identifier for the purchase'),
		createdAt: z.date().describe('Timestamp when the purchase was created'),
		updatedAt: z.date().describe('Timestamp when the purchase was last updated'),
		blockchainIdentifier: z.string().describe('Unique blockchain identifier for the purchase'),
		agentIdentifier: z.string().nullable().describe('Identifier of the agent that is being purchased'),
		lastCheckedAt: z
			.date()
			.nullable()
			.describe('Timestamp when the purchase was last checked on-chain. Null if never checked'),
		payByTime: z
			.string()
			.nullable()
			.describe(
				'Unix timestamp (in milliseconds) by which the buyer must submit the payment transaction. Null if not set',
			),
		submitResultTime: z
			.string()
			.describe('Unix timestamp (in milliseconds) by which the seller must submit the result'),
		unlockTime: z
			.string()
			.describe('Unix timestamp (in milliseconds) after which funds can be unlocked if no disputes'),
		externalDisputeUnlockTime: z
			.string()
			.describe('Unix timestamp (in milliseconds) after which external dispute resolution can occur'),
		totalBuyerCardanoFees: z
			.number()
			.describe(
				'Total Cardano transaction fees paid by the buyer in ADA (sum of all confirmed transactions initiated by buyer)',
			),
		totalSellerCardanoFees: z
			.number()
			.describe(
				'Total Cardano transaction fees paid by the seller in ADA (sum of all confirmed transactions initiated by seller)',
			),
		nextActionOrOnChainStateOrResultLastChangedAt: z
			.date()
			.describe('Timestamp when the next action or on-chain state or result was last changed'),
		nextActionLastChangedAt: z.date().describe('Timestamp when the next action was last changed'),
		onChainStateOrResultLastChangedAt: z
			.date()
			.describe('Timestamp when the on-chain state or result was last changed'),
		requestedById: z.string().describe('ID of the API key that created this purchase'),
		onChainState: z
			.nativeEnum(OnChainState)
			.nullable()
			.describe('Current state of the purchase on the blockchain. Null if not yet on-chain'),
		collateralReturnLovelace: z
			.string()
			.nullable()
			.describe('Amount of collateral to return in lovelace. Null if no collateral'),
		cooldownTime: z.number().describe('Cooldown period in milliseconds for the buyer to dispute'),
		cooldownTimeOtherParty: z.number().describe('Cooldown period in milliseconds for the seller to dispute'),
		inputHash: z.string().describe('SHA256 hash of the input data for the purchase (hex string)'),
		resultHash: z.string().nullable().describe('SHA256 hash of the result submitted by the seller (hex string)'),
		NextAction: z
			.object({
				requestedAction: z.nativeEnum(PurchasingAction).describe('Next action required for this purchase'),
				errorType: z.nativeEnum(PurchaseErrorType).nullable().describe('Type of error that occurred, if any'),
				errorNote: z.string().nullable().describe('Additional details about the error, if any'),
			})
			.describe('Next action required for this purchase'),
		ActionHistory: z
			.array(
				z
					.object({
						id: z.string().describe('Unique identifier for the action'),
						createdAt: z.date().describe('Timestamp when the action was created'),
						updatedAt: z.date().describe('Timestamp when the action was last updated'),
						requestedAction: z.nativeEnum(PurchasingAction).describe('Next action required for this purchase'),
						errorType: z.nativeEnum(PurchaseErrorType).nullable().describe('Type of error that occurred, if any'),
						errorNote: z.string().nullable().describe('Additional details about the error, if any'),
					})
					.describe('Next action required for this purchase'),
			)
			.nullable()
			.describe('Historical list of all actions for this purchase. Null if includeHistory is false'),
		CurrentTransaction: z
			.object({
				id: z.string().describe('Unique identifier for the transaction'),
				createdAt: z.date().describe('Timestamp when the transaction was created'),
				updatedAt: z.date().describe('Timestamp when the transaction was last updated'),
				txHash: z.string().nullable().describe('Cardano transaction hash'),
				status: z.nativeEnum(TransactionStatus).describe('Current status of the transaction'),
				fees: z.string().nullable().describe('Fees of the transaction'),
				blockHeight: z.number().nullable().describe('Block height of the transaction'),
				blockTime: z.number().nullable().describe('Block time of the transaction'),
				previousOnChainState: z
					.nativeEnum(OnChainState)
					.nullable()
					.describe('Previous on-chain state before this transaction'),
				newOnChainState: z.nativeEnum(OnChainState).nullable().describe('New on-chain state of this transaction'),
				confirmations: z.number().nullable().describe('Number of block confirmations for this transaction'),
			})
			.nullable()
			.describe('Current active transaction for this purchase. Null if no transaction in progress'),
		TransactionHistory: z
			.array(
				z.object({
					id: z.string().describe('Unique identifier for the transaction'),
					createdAt: z.date().describe('Timestamp when the transaction was created'),
					updatedAt: z.date().describe('Timestamp when the transaction was last updated'),
					txHash: z.string().nullable().describe('Cardano transaction hash'),
					status: z.nativeEnum(TransactionStatus).describe('Current status of the transaction'),
					fees: z.string().nullable().describe('Fees of the transaction'),
					blockHeight: z.number().nullable().describe('Block height of the transaction'),
					blockTime: z.number().nullable().describe('Block time of the transaction'),
					previousOnChainState: z
						.nativeEnum(OnChainState)
						.nullable()
						.describe('Previous on-chain state before this transaction'),
					newOnChainState: z.nativeEnum(OnChainState).nullable().describe('New on-chain state of this transaction'),
					confirmations: z.number().nullable().describe('Number of block confirmations for this transaction'),
				}),
			)
			.nullable()
			.describe('Historical list of all transactions for this purchase'),
		PaidFunds: z.array(
			z.object({
				amount: z.string(),
				unit: z.string(),
			}),
		),
		WithdrawnForSeller: z.array(
			z.object({
				amount: z.string(),
				unit: z.string(),
			}),
		),
		WithdrawnForBuyer: z.array(
			z.object({
				amount: z.string(),
				unit: z.string(),
			}),
		),
		PaymentSource: z.object({
			id: z.string(),
			network: z.nativeEnum(Network),
			smartContractAddress: z.string(),
			policyId: z.string().nullable(),
		}),
		SellerWallet: z
			.object({
				id: z.string().describe('Unique identifier for the seller wallet'),
				walletVkey: z.string().describe('Payment key hash of the seller wallet'),
			})
			.nullable()
			.describe('Seller wallet information. Null if not set'),
		SmartContractWallet: z
			.object({
				id: z.string().describe('Unique identifier for the smart contract wallet'),
				walletVkey: z.string().describe('Payment key hash of the smart contract wallet'),
				walletAddress: z.string().describe('Cardano address of the smart contract wallet'),
			})
			.nullable()
			.describe('Smart contract wallet (seller wallet) managing this purchase. Null if not set'),
		metadata: z
			.string()
			.nullable()
			.describe('Optional metadata stored with the purchase for additional context. Null if not provided'),
	})
	.openapi('Purchase');

export const queryPurchaseRequestSchemaOutput = z.object({
	Purchases: z.array(purchaseResponseSchema),
});

export const createPurchaseInitSchemaInput = z.object({
	blockchainIdentifier: z.string().max(8000).describe('The identifier of the purchase. Is provided by the seller'),
	network: z.nativeEnum(Network).describe('The network the transaction will be made on'),
	inputHash: z
		.string()
		.max(250)
		.describe(
			'The hash of the input data of the purchase, should be sha256 hash of the input data, therefore needs to be in hex string format',
		),
	sellerVkey: z.string().max(250).describe('The verification key of the seller'),
	agentIdentifier: z.string().min(57).max(250).describe('The identifier of the agent that is being purchased'),
	Amounts: z
		.array(
			z.object({
				amount: z.string().max(25).describe('Amount of the asset in smallest unit (e.g., lovelace for ADA)'),
				unit: z.string().max(150).describe('Asset policy id + asset name concatenated. Empty string for ADA/lovelace'),
			}),
		)
		.max(7)
		.optional()
		.describe('The amounts to be paid for the purchase'),
	unlockTime: z.string().describe('The time after which the purchase will be unlocked. In unix time (number)'),
	externalDisputeUnlockTime: z
		.string()
		.describe('The time after which the purchase will be unlocked for external dispute. In unix time (number)'),
	submitResultTime: z.string().describe('The time by which the result has to be submitted. In unix time (number)'),
	payByTime: z.string().describe('The time after which the purchase has to be submitted to the smart contract'),
	metadata: z.string().optional().describe('Metadata to be stored with the purchase request'),
	identifierFromPurchaser: z.string().min(14).max(26).describe('The nonce of the purchaser. It must be in hex format'),
});

export const createPurchaseInitSchemaOutput = purchaseResponseSchema.omit({
	TransactionHistory: true,
	ActionHistory: true,
});
