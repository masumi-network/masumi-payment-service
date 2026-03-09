import { ez } from 'express-zod-api';
import { Network, OnChainState, PaymentAction, PaymentErrorType, TransactionStatus } from '@/generated/prisma/client';
import { z } from '@/utils/zod-openapi';

const paymentTimeSchema = ez.dateIn();

export const queryPaymentsSchemaInput = z.object({
	limit: z.coerce.number().min(1).max(100).default(10).describe('The number of payments to return'),
	cursorId: z
		.string()
		.optional()
		.describe('Used to paginate through the payments. If this is provided, cursorId is required'),
	network: z.nativeEnum(Network).describe('The network the payments were made on'),
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
		.describe('Whether to include the full transaction and action history of the payments'),
});

export const queryPaymentCountSchemaInput = z.object({
	network: z.nativeEnum(Network).describe('The network the payments were made on'),
	filterSmartContractAddress: z
		.string()
		.optional()
		.nullable()
		.describe('The smart contract address of the payment source'),
});

export const queryPaymentCountSchemaOutput = z.object({
	total: z.number().describe('Total number of payments'),
});

export const paymentResponseSchema = z
	.object({
		id: z.string().describe('Unique identifier for the payment'),
		createdAt: z.date().describe('Timestamp when the payment was created'),
		updatedAt: z.date().describe('Timestamp when the payment was last updated'),
		blockchainIdentifier: z.string().describe('Unique blockchain identifier for the payment'),
		agentIdentifier: z.string().nullable().describe('Identifier of the agent that is being paid'),
		lastCheckedAt: z
			.date()
			.nullable()
			.describe('Timestamp when the payment was last checked on-chain. Null if never checked'),
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
		collateralReturnLovelace: z
			.string()
			.nullable()
			.describe('Amount of collateral to return in lovelace. Null if no collateral'),
		externalDisputeUnlockTime: z
			.string()
			.describe('Unix timestamp (in milliseconds) after which external dispute resolution can occur'),
		requestedById: z.string().describe('ID of the API key that created this payment'),
		resultHash: z.string().nullable().describe('SHA256 hash of the result submitted by the seller (hex string)'),
		nextActionLastChangedAt: z.date().describe('Timestamp when the next action was last changed'),
		onChainStateOrResultLastChangedAt: z
			.date()
			.describe('Timestamp when the on-chain state or result was last changed'),
		nextActionOrOnChainStateOrResultLastChangedAt: z
			.date()
			.describe('Timestamp when the next action or on-chain state or result was last changed'),
		inputHash: z.string().nullable().describe('SHA256 hash of the input data for the payment (hex string)'),
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
		cooldownTime: z.number().describe('Cooldown period in milliseconds for the seller to dispute'),
		cooldownTimeOtherParty: z.number().describe('Cooldown period in milliseconds for the buyer to dispute'),
		onChainState: z
			.nativeEnum(OnChainState)
			.nullable()
			.describe('Current state of the payment on the blockchain. Null if not yet on-chain'),
		NextAction: z
			.object({
				requestedAction: z.nativeEnum(PaymentAction).describe('Next action required for this payment'),
				errorType: z.nativeEnum(PaymentErrorType).nullable().describe('Type of error that occurred, if any'),
				errorNote: z.string().nullable().describe('Additional details about the error, if any'),
				resultHash: z
					.string()
					.nullable()
					.describe('SHA256 hash of the result to be submitted (hex string). Null if not applicable'),
			})
			.describe('Next action required for this payment'),
		ActionHistory: z
			.array(
				z
					.object({
						id: z.string().describe('Unique identifier for the action'),
						createdAt: z.date().describe('Timestamp when the action was created'),
						updatedAt: z.date().describe('Timestamp when the action was last updated'),
						submittedTxHash: z.string().nullable().describe('Cardano transaction hash'),
						requestedAction: z.nativeEnum(PaymentAction).describe('Next action required for this payment'),
						errorType: z.nativeEnum(PaymentErrorType).nullable().describe('Type of error that occurred, if any'),
						errorNote: z.string().nullable().describe('Additional details about the error, if any'),
						resultHash: z
							.string()
							.nullable()
							.describe('SHA256 hash of the result to be submitted (hex string). Null if not applicable'),
					})
					.describe('Next action required for this payment'),
			)
			.nullable()
			.describe('Historical list of all actions for this payment. Null if includeHistory is false'),
		CurrentTransaction: z
			.object({
				id: z.string().describe('Unique identifier for the transaction'),
				createdAt: z.date().describe('Timestamp when the transaction was created'),
				updatedAt: z.date().describe('Timestamp when the transaction was last updated'),
				fees: z.string().nullable(),
				blockHeight: z.number().nullable().describe('Block height of the transaction'),
				blockTime: z.number().nullable().describe('Block time of the transaction'),
				txHash: z.string().nullable().describe('Cardano transaction hash'),
				status: z.nativeEnum(TransactionStatus).describe('Current status of the transaction'),
				previousOnChainState: z
					.nativeEnum(OnChainState)
					.nullable()
					.describe('Previous on-chain state before this transaction'),
				newOnChainState: z.nativeEnum(OnChainState).nullable().describe('New on-chain state of this transaction'),
				confirmations: z.number().nullable().describe('Number of block confirmations for this transaction'),
			})
			.nullable()
			.describe('Current active transaction for this payment. Null if no transaction in progress'),
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
			.describe('Historical list of all transactions for this payment. Null if includeHistory is false'),
		RequestedFunds: z.array(
			z.object({
				amount: z
					.string()
					.describe(
						'The quantity of the asset. Make sure to convert it from the underlying smallest unit (in case of decimals, multiply it by the decimal factor e.g. for 1 ADA = 10000000 lovelace)',
					),
				unit: z
					.string()
					.describe(
						'Asset policy id + asset name concatenated. Use an empty string for ADA/lovelace e.g (1000000 lovelace = 1 ADA)',
					),
			}),
		),
		WithdrawnForSeller: z
			.array(
				z.object({
					amount: z.string().describe('Amount of the asset withdrawn (as string to handle large numbers)'),
					unit: z.string().describe('Asset policy id + asset name concatenated. Empty string for ADA/lovelace'),
				}),
			)
			.describe('List of assets and amounts withdrawn for the seller'),
		WithdrawnForBuyer: z
			.array(
				z.object({
					amount: z.string().describe('Amount of the asset withdrawn (as string to handle large numbers)'),
					unit: z.string().describe('Asset policy id + asset name concatenated. Empty string for ADA/lovelace'),
				}),
			)
			.describe('List of assets and amounts withdrawn for the buyer (refunds)'),
		PaymentSource: z
			.object({
				id: z.string().describe('Unique identifier for the payment source'),
				network: z.nativeEnum(Network).describe('The Cardano network (Mainnet, Preprod, or Preview)'),
				smartContractAddress: z.string().describe('Address of the smart contract managing this payment'),
				policyId: z.string().nullable().describe('Policy ID for the agent registry NFTs. Null if not applicable'),
			})
			.describe('Payment source configuration for this payment'),
		BuyerWallet: z
			.object({
				id: z.string().describe('Unique identifier for the buyer wallet'),
				walletVkey: z.string().describe('Payment key hash of the buyer wallet'),
			})
			.nullable()
			.describe('Buyer wallet information. Null if buyer has not yet submitted payment'),
		SmartContractWallet: z
			.object({
				id: z.string().describe('Unique identifier for the smart contract wallet'),
				walletVkey: z.string().describe('Payment key hash of the smart contract wallet'),
				walletAddress: z.string().describe('Cardano address of the smart contract wallet'),
			})
			.nullable()
			.describe('Smart contract wallet (seller wallet) managing this payment. Null if not set'),
		metadata: z
			.string()
			.nullable()
			.describe('Optional metadata stored with the payment for additional context. Null if not provided'),
	})
	.openapi('Payment');

export const queryPaymentsSchemaOutput = z.object({
	Payments: z.array(paymentResponseSchema),
});

export const createPaymentsSchemaInput = z.object({
	inputHash: z
		.string()
		.max(250)
		.describe(
			'The hash of the input data of the payment, should be sha256 hash of the input data, therefore needs to be in hex string format',
		),
	network: z.nativeEnum(Network).describe('The network the payment will be received on'),
	agentIdentifier: z.string().min(57).max(250).describe('The identifier of the agent that will be paid'),
	RequestedFunds: z
		.array(
			z.object({
				amount: z.string().max(25).describe('Amount of the asset in smallest unit (e.g., lovelace for ADA)'),
				unit: z.string().max(150).describe('Asset policy id + asset name concatenated. Empty string for ADA/lovelace'),
			}),
		)
		.max(7)
		.optional()
		.describe('The amounts of the payment, should be null for fixed amount'),
	payByTime: ez
		.dateIn()
		.default(() => paymentTimeSchema.parse(new Date(1000 * 60 * 60 * 12).toISOString()))
		.describe('The time after which the payment has to be submitted to the smart contract'),
	submitResultTime: ez
		.dateIn()
		.default(() => paymentTimeSchema.parse(new Date(1000 * 60 * 60 * 12).toISOString()))
		.describe('The time after which the payment has to be submitted to the smart contract'),
	unlockTime: ez.dateIn().optional().describe('The time after which the payment will be unlocked'),
	externalDisputeUnlockTime: ez
		.dateIn()
		.optional()
		.describe('The time after which the payment will be unlocked for external dispute'),
	metadata: z.string().optional().describe('Metadata to be stored with the payment request'),
	identifierFromPurchaser: z
		.string()
		.min(14)
		.max(26)
		.describe('A unique nonce from the purchaser. It must be in hex format'),
});

export const createPaymentSchemaOutput = paymentResponseSchema.omit({
	TransactionHistory: true,
	ActionHistory: true,
});
