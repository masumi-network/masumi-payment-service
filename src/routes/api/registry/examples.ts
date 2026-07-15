import { Network, PaymentSourceType, PricingType, RegistrationState } from '@/generated/prisma/client';
import { SupportedPaymentSourceChain } from '@/types/payment-source';
import { z } from '@masumi/payment-core/zod';
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
	sendFundingLovelace: null,
	supportedPaymentSources: [
		{
			chain: SupportedPaymentSourceChain.Cardano,
			network: Network.Preprod,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
			address: 'addr_test1wz7j4kmg2cs7yf92uat3ed4a3u97kr7axxr4avaz0lhwdsqukgwfm',
		},
	],
	verifications: [
		{
			method: 'KERI-ACDC',
			schemaVersion: '1',
			issuer: {
				aid: 'EIaIeKvfBLmZf3wfqB0oR1uM5n8m9k2pQ7rT4sV1wX3y',
				oobi: 'https://witness.example.com/oobi/EIaIeKvfBLmZf3wfqB0oR1uM5n8m9k2pQ7rT4sV1wX3y/witness',
			},
			schema: {
				said: 'EJ1gXWfzLyW2u0YY5Zb8c4d6e9f1g3h5j7k9l2m4n6p',
				oobi: 'https://schema.example.com/oobi/EJ1gXWfzLyW2u0YY5Zb8c4d6e9f1g3h5j7k9l2m4n6p',
			},
			credential: {
				said: 'EHpH79tPZoSl7VJZ7xMi3JWF4rH9wZ2ntGvKABd9N14z',
				oobi: 'https://cred.example.com/oobi/EHpH79tPZoSl7VJZ7xMi3JWF4rH9wZ2ntGvKABd9N14z',
				registry: 'ER7yQ3kL9mN2pT5vX8a1b4c7d0e3f6g9h2j5k8l1m4n7',
			},
			holder: {
				aid: 'EBcd1ef2gh3ij4kl5mn6op7qr8st9uv0wx1yz2ab3cd4',
				oobi: 'https://keria.example.com/oobi/EBcd1ef2gh3ij4kl5mn6op7qr8st9uv0wx1yz2ab3cd4/agent/EAgnt',
			},
			baseUrl: 'https://verify.example.com',
		},
	],
	SmartContractWallet: {
		walletVkey: 'wallet_vkey',
		walletAddress: 'wallet_address',
	},
	RecipientWallet: null,
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
