import { Network, PaymentSourceType, PricingType, RegistrationState } from '@/generated/prisma/client';
import { SupportedPaymentSourceChain } from '@/types/payment-source';
import { z } from '@masumi/payment-core/zod';
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
	SmartContractWallet: {
		walletVkey: 'wallet_vkey',
		walletAddress: 'wallet_address',
	},
	RecipientWallet: null,
	CurrentTransaction: null,
} satisfies z.infer<typeof registerAgentSchemaOutput>;
