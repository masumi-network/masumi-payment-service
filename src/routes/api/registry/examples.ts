import { PricingType, RegistrationState } from '@/generated/prisma/client';
import { z } from '@/utils/zod-openapi';
import { a2aRegistryRequestOutputSchema, registerAgentSchemaOutput } from './schemas';

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

export const a2aRegistryEntryExample = {
	error: null,
	id: 'a2a_registry_id',
	name: 'My A2A Agent',
	description: 'An A2A-capable AI agent',
	apiBaseUrl: 'https://api.example.com',
	agentCardUrl: 'https://api.example.com/.well-known/agent-card.json',
	a2aProtocolVersions: ['0.2.5'],
	a2aAgentVersion: '1.0.0',
	a2aDefaultInputModes: ['text/plain'],
	a2aDefaultOutputModes: ['text/plain'],
	a2aProviderName: 'Example Provider',
	a2aProviderUrl: 'https://example.com',
	a2aDocumentationUrl: null,
	a2aIconUrl: null,
	a2aCapabilitiesStreaming: false,
	a2aCapabilitiesPushNotifications: false,
	state: RegistrationState.RegistrationRequested,
	Tags: ['a2a', 'agent'],
	createdAt: new Date(1713636260),
	updatedAt: new Date(1713636260),
	lastCheckedAt: null,
	agentIdentifier: 'policy_id_asset_name_policy_id_asset_name_policy_id_asset_name',
	AgentPricing: {
		pricingType: PricingType.Free,
	},
	SmartContractWallet: {
		walletVkey: 'wallet_vkey',
		walletAddress: 'wallet_address',
	},
	CurrentTransaction: null,
} satisfies z.infer<typeof a2aRegistryRequestOutputSchema>;
