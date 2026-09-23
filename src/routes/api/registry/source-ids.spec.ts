import {
	Network,
	PaymentSourceType,
	PricingType,
	RegistrationState,
	RegistryEntryType,
	X402PaymentScheme,
} from '@/generated/prisma/client';
import { supportedPaymentSourceSchema } from '@/types/payment-source';
import { queryRegistryRequestSchemaOutput } from './schemas';
import { serializeRegistryEntry, serializeSupportedPaymentSources } from './serializers';

const timestamp = new Date('2026-09-23T00:00:00Z');

type SourceRow = Parameters<typeof serializeSupportedPaymentSources>[0][number] & { id: string };
function sourceRow(id: string, position: number): SourceRow {
	return {
		id,
		position,
		chain: 'EVM',
		network: 'eip155:84532',
		paymentSourceType: null,
		address: '0x1111111111111111111111111111111111111111',
		scheme: X402PaymentScheme.Exact,
		payTo: '0x1111111111111111111111111111111111111111',
		resource: `https://agent.example/${id}`,
		extra: null,
		dynamicAsset: null,
		dynamicDecimals: null,
		fixedDecimals: 6,
		Pricing: {
			id: `pricing-${id}`,
			createdAt: timestamp,
			updatedAt: timestamp,
			registryRequestId: null,
			supportedPaymentSourceId: id,
			pricingType: PricingType.Fixed,
			FixedPricing: {
				id: `fixed-${id}`,
				createdAt: timestamp,
				updatedAt: timestamp,
				agentPricingId: `pricing-${id}`,
				Amounts: [{ unit: '0x2222222222222222222222222222222222222222', amount: 100n }],
			},
		},
	};
}
function serializeListedSources(rows: SourceRow[]) {
	const entry: Parameters<typeof serializeRegistryEntry>[0] = {
		id: 'registry',
		createdAt: timestamp,
		updatedAt: timestamp,
		lastCheckedAt: null,
		paymentSourceId: 'payment-source',
		smartContractWalletId: 'holder',
		recipientHotWalletId: null,
		recipientWalletAddress: null,
		deregistrationHotWalletId: null,
		sendFundingLovelace: null,
		name: 'Agent',
		type: RegistryEntryType.Standard,
		apiBaseUrl: 'https://agent.example',
		openApiSpecUrl: null,
		x402ResourcesUrl: null,
		capabilityName: null,
		capabilityVersion: null,
		description: null,
		privacyPolicy: null,
		terms: null,
		other: null,
		authorName: 'Author',
		authorContactEmail: null,
		authorContactOther: null,
		authorOrganization: null,
		metadataVersion: 1,
		tags: [],
		agentIdentifier: null,
		state: RegistrationState.RegistrationConfirmed,
		registrationStateLastChangedAt: timestamp,
		currentTransactionId: null,
		error: null,
		collateralPrepFailureCount: 0,
		requestedById: 'key',
		ExampleOutputs: [],
		SmartContractWallet: { walletVkey: 'vkey', walletAddress: 'addr_test1holder' },
		RecipientWallet: null,
		SupportedPaymentSources: rows,
		Pricing: null,
		Verifications: [],
		CurrentTransaction: null,
	};
	return serializeRegistryEntry(entry).supportedPaymentSources;
}

describe('authenticated registry source IDs', () => {
	it('preserves each row ID through the GET response schema in position order', () => {
		const result = serializeListedSources([sourceRow('second', 1), sourceRow('first', 0)]);
		const schema = queryRegistryRequestSchemaOutput.shape.Assets.element.shape.supportedPaymentSources;
		expect(schema.parse(result)).toMatchObject([
			{ id: 'first', resource: 'https://agent.example/first' },
			{ id: 'second', resource: 'https://agent.example/second' },
		]);
	});
	it('includes IDs for Cardano rows without shifting the EVM association', () => {
		const cardano = {
			...sourceRow('cardano', 0),
			chain: 'Cardano',
			network: Network.Preprod,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
			address: 'addr_test1example',
		};
		expect(serializeListedSources([sourceRow('evm', 1), cardano])).toMatchObject([
			{ id: 'cardano', chain: 'Cardano' },
			{ id: 'evm', chain: 'EVM' },
		]);
	});
	it('rejects an incomplete preceding row instead of assigning its ID to the next source', () => {
		const incomplete = { ...sourceRow('invalid', 0), Pricing: null };
		expect(() => serializeListedSources([incomplete, sourceRow('valid', 1)])).toThrow('missing source-owned pricing');
	});
	it('keeps node IDs out of write and metadata serialization', () => {
		const row = sourceRow('private-node-id', 0);
		const [serialized] = serializeSupportedPaymentSources([row])!;
		expect(serialized).not.toHaveProperty('id');
		expect(supportedPaymentSourceSchema.parse({ ...serialized, id: row.id })).not.toHaveProperty('id');
	});
	it('retains null for a legacy entry without sources', () => {
		expect(serializeListedSources([])).toBeNull();
	});
});
