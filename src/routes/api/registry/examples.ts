import { PricingType, RegistrationState } from '@/generated/prisma/client';
import { z } from '@/utils/zod-openapi';
import { registerAgentSchemaOutput } from './schemas';

export const registryEntryExample = {
	error: null,
	id: 'registry_id',
	name: 'Agent Name',
	description: 'Agent Description',
	apiBaseUrl: 'https://api.example.com',
	Capability: { name: 'Capability Name', version: '1.0.0' },
	Author: {
		name: 'Author Name',
		contactEmail: 'author@example.com',
		contactOther: 'contact-other',
		organization: 'Author Org',
	},
	Legal: {
		privacyPolicy: 'https://example.com/privacy',
		terms: 'https://example.com/terms',
		other: 'https://example.com/other',
	},
	state: RegistrationState.RegistrationRequested,
	Tags: ['tag1', 'tag2'],
	createdAt: new Date(1713636260),
	updatedAt: new Date(1713636260),
	lastCheckedAt: null,
	ExampleOutputs: [
		{
			name: 'example_output_name',
			url: 'https://example.com/example_output',
			mimeType: 'application/json',
		},
	],
	agentIdentifier: 'policy_id_asset_name_policy_id_asset_name_policy_id_asset_name',
	metadataVersion: 1,
	agentCardUrl: null,
	a2aProtocolVersions: [],
	a2aAgentVersion: null,
	a2aDefaultInputModes: [],
	a2aDefaultOutputModes: [],
	a2aProviderName: null,
	a2aProviderUrl: null,
	a2aDocumentationUrl: null,
	a2aIconUrl: null,
	a2aCapabilitiesStreaming: null,
	a2aCapabilitiesPushNotifications: null,
	AgentPricing: {
		pricingType: PricingType.Fixed,
		Pricing: [
			{
				unit: '',
				amount: '10000000',
			},
		],
	},
	SmartContractWallet: {
		walletVkey: 'wallet_vkey',
		walletAddress: 'wallet_address',
	},
	CurrentTransaction: null,
} satisfies z.infer<typeof registerAgentSchemaOutput>;
