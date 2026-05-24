// Mesh SDK pinning: `payment-core` declares the V1 mesh line
// (`@meshsdk/core-cst@1.9.0-beta.90`) because the helpers in this module
// (address parsing, payment-key-hash resolution) are shared across V1 and the
// framework. V2 code paths in `packages/payment-source-v2` pin and use a
// newer mesh line; they import their own copies of these helpers from there
// rather than depending on this V1-aligned version. Do not bump. See
// docs/adr/0005-meshsdk-version-pinning-v1-v2.md.
import { resolvePaymentKeyHash } from '@meshsdk/core-cst';
import { Chain, Network, PaymentSourceType } from '@prisma/client';
import { z } from './zod';

export { Chain as SupportedPaymentSourceChain };

export const paymentSourceTypeSchema = z.nativeEnum(PaymentSourceType).describe('The configured payment source type');

export const supportedPaymentSourceSchema = z.object({
	chain: z.nativeEnum(Chain).describe('The blockchain this payment source is available on'),
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

/**
 * Minimal payment-source descriptor consumed by registry mint paths when
 * `SupportedPaymentSources` is empty and a synthetic default row must be
 * emitted on chain. Lives here rather than next to each register service so
 * V1 and V2 share one type definition (previously duplicated verbatim in
 * `packages/payment-source-v{1,2}/src/services/registry/register/service.ts`).
 */
export type RegistryMetadataPaymentSource = {
	network: Network;
	paymentSourceType: PaymentSourceType;
	smartContractAddress: string;
};

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

export function isCardanoAddressForNetwork(address: string, network: Network): boolean {
	try {
		validateCardanoAddressForNetwork(address, network);
		return true;
	} catch {
		return false;
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

		if (supportedPaymentSource.chain !== Chain.Cardano) {
			throw new Error('Unsupported payment source chain');
		}

		validateCardanoAddressForNetwork(supportedPaymentSource.address, expectedNetwork);
	}
}

export function parseSupportedPaymentSourcesFromMetadata(value: unknown): SupportedPaymentSource[] | null {
	if (value == null) {
		return null;
	}

	const parsed = z.array(supportedPaymentSourceMetadataSchema).safeParse(value);
	if (!parsed.success) {
		return null;
	}

	const reparsed = supportedPaymentSourcesSchema.safeParse(
		parsed.data.map((source) => ({
			chain: metadataToString(source.chain),
			network: metadataToString(source.network),
			paymentSourceType: metadataToString(source.paymentSourceType),
			address: metadataToString(source.address),
		})),
	);
	return reparsed.success ? reparsed.data : null;
}
