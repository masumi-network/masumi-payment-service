// Mesh SDK pinning: `payment-core` declares the V1 mesh line
// (`@meshsdk/core-cst@1.9.0-beta.90`) because the helpers in this module
// (address parsing, payment-key-hash resolution) are shared across V1 and the
// framework. V2 code paths in `packages/payment-source-v2` pin and use a
// newer mesh line; they import their own copies of these helpers from there
// rather than depending on this V1-aligned version. Do not bump. See
// docs/adr/0005-meshsdk-version-pinning-v1-v2.md.
import { AddressType, deserializeAddress, resolvePaymentKeyHash, resolveStakeKeyHash } from '@meshsdk/core-cst';
import { Network, PaymentSourceType } from '@prisma/client';
import { z } from './zod';
import { isAllowedCaip2Network } from './network';

export const SupportedPaymentSourceChain = {
	Cardano: 'Cardano',
	EVM: 'EVM',
} as const;

export const paymentSourceTypeSchema = z.nativeEnum(PaymentSourceType).describe('The configured payment source type');

const evmAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Expected an EVM address');

const cardanoSupportedPaymentSourceSchema = z.object({
	chain: z.literal(SupportedPaymentSourceChain.Cardano).describe('The blockchain this payment source is available on'),
	network: z.nativeEnum(Network).describe('The Cardano network this payment source is available on'),
	paymentSourceType: paymentSourceTypeSchema,
	address: z.string().max(250).describe('The escrow smart contract address for this payment source'),
});

const x402SupportedPaymentSourceSchema = z
	.object({
		chain: z.literal(SupportedPaymentSourceChain.EVM).describe('The chain family used by standard x402'),
		network: z
			.string()
			.regex(/^eip155:\d+$/, 'x402 EVM network must be a CAIP-2 eip155 chain id')
			.describe('CAIP-2 EVM network id, for example eip155:8453'),
		paymentSourceType: paymentSourceTypeSchema.nullable().optional(),
		address: evmAddressSchema.optional().describe('Alias for payTo, kept for existing payment-source shape'),
		scheme: z.literal('Exact').describe('x402 payment scheme'),
		asset: evmAddressSchema.describe('ERC-20 token contract address'),
		amount: z.string().regex(/^\d+$/).describe('Atomic token amount'),
		decimals: z.number().int().min(0).max(255).describe('ERC-20 token decimals'),
		payTo: evmAddressSchema.describe('EVM address receiving the x402 payment'),
		resource: z.string().url().max(500).optional().describe('Optional absolute resource URL this x402 option protects'),
		extra: z.record(z.string(), z.unknown()).optional().describe('Additional x402 metadata'),
	})
	.superRefine((source, ctx) => {
		if (source.address != null && source.address.toLowerCase() !== source.payTo.toLowerCase()) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['address'],
				message: 'x402 address alias must match payTo',
			});
		}
	});

export const supportedPaymentSourceSchema = z.discriminatedUnion('chain', [
	cardanoSupportedPaymentSourceSchema,
	x402SupportedPaymentSourceSchema,
]);

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
	paymentSourceType: metadataStringSchema.optional(),
	address: metadataStringSchema.optional(),
	scheme: metadataStringSchema.optional(),
	asset: metadataStringSchema.optional(),
	amount: metadataStringSchema.optional(),
	decimals: metadataStringSchema.optional(),
	payTo: metadataStringSchema.optional(),
	resource: metadataStringSchema.optional(),
	extra: z.unknown().optional(),
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
	// CAIP-2 networks the caller is authorized to advertise on. `null` means
	// unlimited (admin); `undefined` skips the check (off-route validation paths).
	allowedCaip2Networks?: string[] | null,
) {
	for (const supportedPaymentSource of supportedPaymentSources) {
		if (supportedPaymentSource.chain === SupportedPaymentSourceChain.EVM) {
			if (registeringPaymentSourceType !== PaymentSourceType.Web3CardanoV2) {
				throw new Error('x402 payment sources may only be advertised by V2 registry entries.');
			}
			if (BigInt(supportedPaymentSource.amount) <= 0n) {
				throw new Error('x402 payment source amount must be greater than zero');
			}
			if (
				allowedCaip2Networks !== undefined &&
				!isAllowedCaip2Network(allowedCaip2Networks, supportedPaymentSource.network)
			) {
				throw new Error('Not authorized to advertise x402 payment sources on this network');
			}
			continue;
		}

		if (supportedPaymentSource.network !== expectedNetwork) {
			throw new Error('Supported payment source network must match the registry network');
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
			scheme: metadataToString(source.scheme),
			asset: metadataToString(source.asset),
			amount: metadataToString(source.amount),
			decimals: metadataToString(source.decimals) != null ? Number(metadataToString(source.decimals)) : undefined,
			payTo: metadataToString(source.payTo),
			resource: metadataToString(source.resource),
			extra: source.extra,
		})),
	);
	return reparsed.success ? reparsed.data : null;
}
