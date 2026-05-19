import { resolvePaymentKeyHash } from '@meshsdk/core-cst';
import { Network, PaymentSourceType } from '@/generated/prisma/client';
import { z } from '@/utils/zod-openapi';

export enum SupportedPaymentSourceChain {
	Cardano = 'Cardano',
}

export const paymentSourceTypeSchema = z.nativeEnum(PaymentSourceType).describe('The configured payment source type');

export const supportedPaymentSourceSchema = z.object({
	chain: z.nativeEnum(SupportedPaymentSourceChain).describe('The blockchain this payment source is available on'),
	network: z.nativeEnum(Network).describe('The blockchain network this payment source is available on'),
	paymentSourceType: paymentSourceTypeSchema,
	address: z.string().max(250).describe('The escrow smart contract address for this payment source'),
});

export const supportedPaymentSourcesSchema = z
	.array(supportedPaymentSourceSchema)
	.min(1)
	.max(25)
	.describe('Payment sources advertised by this registry entry');

export type SupportedPaymentSource = z.infer<typeof supportedPaymentSourceSchema>;

const metadataStringSchema = z.string().or(z.array(z.string()).min(1));

function metadataToString(value: string | string[] | undefined) {
	if (value == undefined) return undefined;
	if (typeof value === 'string') return value;
	return value.join('');
}

export const supportedPaymentSourceMetadataSchema = z.object({
	chain: metadataStringSchema,
	network: metadataStringSchema,
	paymentSourceType: metadataStringSchema,
	address: metadataStringSchema,
});

function validateCardanoAddressForNetwork(address: string, network: Network) {
	const expectedPrefix = network === Network.Mainnet ? 'addr1' : 'addr_test1';
	if (!address.startsWith(expectedPrefix)) {
		throw new Error('Supported Cardano payment source address does not match the registry network');
	}

	try {
		resolvePaymentKeyHash(address);
	} catch {
		throw new Error('Supported Cardano payment source address is not a valid Cardano address');
	}
}

export function validateSupportedPaymentSourcesOrThrow(
	supportedPaymentSources: SupportedPaymentSource[],
	expectedNetwork: Network,
) {
	for (const supportedPaymentSource of supportedPaymentSources) {
		if (supportedPaymentSource.network !== expectedNetwork) {
			throw new Error('Supported payment source network must match the registry network');
		}

		if (supportedPaymentSource.chain !== SupportedPaymentSourceChain.Cardano) {
			throw new Error('Unsupported payment source chain');
		}

		validateCardanoAddressForNetwork(supportedPaymentSource.address, expectedNetwork);
	}
}

export function parseSupportedPaymentSources(value: unknown): SupportedPaymentSource[] | null {
	if (value == null) {
		return null;
	}

	const parsed = supportedPaymentSourcesSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

export function parseSupportedPaymentSourcesFromMetadata(value: unknown): SupportedPaymentSource[] | null {
	if (value == null) {
		return null;
	}

	const parsed = z.array(supportedPaymentSourceMetadataSchema).safeParse(value);
	if (!parsed.success) {
		return null;
	}

	return parseSupportedPaymentSources(
		parsed.data.map((source) => ({
			chain: metadataToString(source.chain),
			network: metadataToString(source.network),
			paymentSourceType: metadataToString(source.paymentSourceType),
			address: metadataToString(source.address),
		})),
	);
}
