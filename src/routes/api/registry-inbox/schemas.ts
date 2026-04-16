import { Network, RegistrationState, TransactionStatus } from '@/generated/prisma/client';
import { z } from '@/utils/zod-openapi';

export enum FilterStatus {
	Registered = 'Registered',
	Deregistered = 'Deregistered',
	Pending = 'Pending',
	Failed = 'Failed',
}

export const registryInboxRequestOutputSchema = z
	.object({
		error: z.string().nullable().describe('Error message if registration failed. Null if no error'),
		id: z.string().describe('Unique identifier for the inbox registration request'),
		name: z.string().describe('Name of the inbox agent'),
		description: z.string().nullable().describe('Description of the inbox agent. Null if not provided'),
		agentSlug: z.string().describe('Canonical slug registered for the inbox agent'),
		state: z.nativeEnum(RegistrationState).describe('Current state of the inbox registration process'),
		createdAt: z.date().describe('Timestamp when the inbox registration request was created'),
		updatedAt: z.date().describe('Timestamp when the inbox registration request was last updated'),
		lastCheckedAt: z
			.date()
			.nullable()
			.describe('Timestamp when the inbox registration was last checked. Null if never checked'),
		agentIdentifier: z
			.string()
			.min(57)
			.max(250)
			.nullable()
			.describe('Full inbox agent identifier (policy ID + asset name). Null if not yet minted'),
		metadataVersion: z.number().int().describe('Version of the inbox metadata schema'),
		sendFundingLovelace: z
			.string()
			.nullable()
			.describe(
				'Effective lovelace amount explicitly configured for the NFT output. Null means the default minimum NFT funding is used.',
			),
		SmartContractWallet: z
			.object({
				walletVkey: z.string().describe('Payment key hash of the minting wallet'),
				walletAddress: z.string().describe('Cardano address of the minting wallet'),
			})
			.describe('Minting wallet managing this inbox registration'),
		RecipientWallet: z
			.object({
				walletVkey: z.string().describe('Payment key hash of the managed recipient wallet'),
				walletAddress: z.string().describe('Cardano address of the managed recipient wallet'),
			})
			.nullable()
			.describe('Managed wallet that receives the inbox registry NFT. Null when the minting wallet receives it'),
		CurrentTransaction: z
			.object({
				txHash: z.string().nullable().describe('Cardano transaction hash'),
				status: z.nativeEnum(TransactionStatus).describe('Current status of the transaction'),
				confirmations: z
					.number()
					.nullable()
					.describe('Number of block confirmations for this transaction. Null if not yet confirmed'),
				fees: z.string().nullable().describe('Fees of the transaction'),
				blockHeight: z.number().nullable().describe('Block height of the transaction'),
				blockTime: z.number().nullable().describe('Block time of the transaction'),
			})
			.nullable(),
	})
	.openapi('RegistryInboxEntry');

export const queryRegistryInboxRequestSchemaInput = z.object({
	limit: z.coerce.number().min(1).max(100).default(10).describe('The number of inbox registry entries to return'),
	cursorId: z.string().optional().describe('The cursor id to paginate through the results'),
	network: z.nativeEnum(Network).describe('The Cardano network used to register the inbox agent on'),
	filterSmartContractAddress: z
		.string()
		.optional()
		.nullable()
		.describe('The smart contract address of the payment source'),
	filterStatus: z.nativeEnum(FilterStatus).optional().describe('Filter by inbox registration status category'),
	searchQuery: z
		.string()
		.optional()
		.describe('Search query to filter by name, description, agent slug, minting or recipient wallet address, or state'),
});

export const queryRegistryInboxRequestSchemaOutput = z.object({
	Assets: z.array(registryInboxRequestOutputSchema),
});

export const queryRegistryInboxCountSchemaInput = z.object({
	network: z.nativeEnum(Network).describe('The Cardano network used to register the inbox agent on'),
	filterSmartContractAddress: z
		.string()
		.optional()
		.nullable()
		.describe('The smart contract address of the payment source'),
});

export const queryRegistryInboxCountSchemaOutput = z.object({
	total: z.number().describe('Total number of inbox agents'),
});

export const registerInboxAgentSchemaInput = z.object({
	network: z.nativeEnum(Network).describe('The Cardano network used to register the inbox agent on'),
	sellingWalletVkey: z.string().max(250).describe('The payment key of a specific wallet used for the registration'),
	recipientWalletAddress: z
		.string()
		.max(250)
		.optional()
		.describe(
			'Optional managed hot wallet address on the same payment source that should receive the minted inbox registry NFT. If omitted, the minting wallet receives it.',
		),
	sendFundingLovelace: z
		.string()
		.regex(/^\d+$/)
		.max(25)
		.optional()
		.describe(
			'Optional lovelace amount to include with the minted inbox registry NFT output. If provided below the minimum NFT funding, the current minimum is still used.',
		),
	name: z.string().min(1).max(120).describe('Display name of the inbox agent'),
	description: z.string().max(500).optional().describe('Optional description of the inbox agent'),
	agentSlug: z.string().min(1).max(80).describe('Canonical inbox slug. Must already be normalized and not reserved'),
});

export const registerInboxAgentSchemaOutput = registryInboxRequestOutputSchema;

export const deleteInboxAgentRegistrationSchemaInput = z.object({
	id: z.string().cuid().describe('The database ID of the inbox registration record to be deleted.'),
});

export const deleteInboxAgentRegistrationSchemaOutput = registryInboxRequestOutputSchema;
