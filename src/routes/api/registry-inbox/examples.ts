import { RegistrationState } from '@/generated/prisma/client';
import { z } from '@/utils/zod-openapi';
import { registerInboxAgentSchemaOutput } from './schemas';

export const registryInboxEntryExample = {
	error: null,
	id: 'inbox_registry_id',
	name: 'Inbox Agent',
	description: 'Masumi inbox identity registration',
	agentSlug: 'inbox-agent',
	state: RegistrationState.RegistrationRequested,
	createdAt: new Date(1713636260),
	updatedAt: new Date(1713636260),
	lastCheckedAt: null,
	agentIdentifier: 'policy_id_asset_name_policy_id_asset_name_policy_id_asset_name',
	metadataVersion: 1,
	sendFundingLovelace: null,
	SmartContractWallet: {
		walletVkey: 'wallet_vkey',
		walletAddress: 'wallet_address',
	},
	RecipientWallet: null,
	CurrentTransaction: null,
} satisfies z.infer<typeof registerInboxAgentSchemaOutput>;
