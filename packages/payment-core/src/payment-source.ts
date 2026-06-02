// Mesh SDK pinning: `payment-core` declares the V1 mesh line
// (`@meshsdk/core-cst@1.9.0-beta.90`) because the helpers in this module
// (address parsing, payment-key-hash resolution) are shared across V1 and the
// framework. V2 code paths in `packages/payment-source-v2` pin and use a
// newer mesh line; they import their own copies of these helpers from there
// rather than depending on this V1-aligned version. Do not bump. See
// docs/adr/0005-meshsdk-version-pinning-v1-v2.md.
import { AddressType, deserializeAddress, resolvePaymentKeyHash, resolveStakeKeyHash } from '@meshsdk/core-cst';
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

function validateCardanoPubKeyBaseAddressForNetwork(address: string, network: Network) {
	validateCardanoAddressForNetwork(address, network);
	const parsedAddress = deserializeAddress(address);
	if (parsedAddress.getType() !== AddressType.BasePaymentKeyStakeKey) {
		throw new Error('Cardano address must be a base address with payment and stake key credentials');
	}

	try {
		resolvePaymentKeyHash(address);
		resolveStakeKeyHash(address);
	} catch {
		throw new Error('Cardano address must include payment and stake key credentials');
	}
}

export function isCardanoPubKeyBaseAddressForNetwork(address: string, network: Network): boolean {
	try {
		validateCardanoPubKeyBaseAddressForNetwork(address, network);
		return true;
	} catch {
		return false;
	}
}

export function validateSupportedPaymentSourcesOrThrow(
	supportedPaymentSources: SupportedPaymentSource[],
	expectedNetwork: Network,
	// Type of the payment source that the registry entry is being minted
	// against. The rule is asymmetric — by design — between V1 and V2:
	//   - V2 entries (the canonical going-forward type) MUST advertise
	//     only V2 payment sources. Advertising a Legacy V1 source on a
	//     V2 mint confuses on-chain consumers about which contract
	//     family the agent actually targets.
	//   - V1 entries (Legacy Payment Source Type) MAY advertise any
	//     payment-source type, including V2. This lets a legacy entry
	//     cross-list to V2 as a "migration breadcrumb" without rebuilding
	//     it from scratch.
	// Caller may pass `undefined` only on early-boot / off-route
	// validation paths where the registering type is not yet bound;
	// in that case the asymmetric rule is skipped.
	registeringPaymentSourceType?: PaymentSourceType,
) {
	for (const supportedPaymentSource of supportedPaymentSources) {
		if (supportedPaymentSource.network !== expectedNetwork) {
			throw new Error('Supported payment source network must match the registry network');
		}

		if (supportedPaymentSource.chain !== Chain.Cardano) {
			throw new Error('Unsupported payment source chain');
		}

		if (
			registeringPaymentSourceType === PaymentSourceType.Web3CardanoV2 &&
			supportedPaymentSource.paymentSourceType !== PaymentSourceType.Web3CardanoV2
		) {
			throw new Error(
				'V2 registry entries may only advertise V2 payment sources. Legacy V1 sources cannot be listed on a V2 mint.',
			);
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
