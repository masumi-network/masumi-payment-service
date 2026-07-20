// Mesh SDK pinning: `payment-core` declares the V1 mesh line
// (`@meshsdk/core-cst@1.9.0-beta.90`) because the helpers in this module
// (address parsing, payment-key-hash resolution) are shared across V1 and the
// framework. V2 code paths in `packages/payment-source-v2` pin and use a
// newer mesh line; they import their own copies of these helpers from there
// rather than depending on this V1-aligned version. Do not bump. See
// docs/adr/0005-meshsdk-version-pinning-v1-v2.md.
import { AddressType, deserializeAddress, resolvePaymentKeyHash, resolveStakeKeyHash } from '@meshsdk/core-cst';
import { Network, PaymentSourceType, PricingType } from '@prisma/client';
import { z } from './zod';
import { isAllowedCaip2Network } from './network';

export const SupportedPaymentSourceChain = {
	Cardano: 'Cardano',
	EVM: 'EVM',
} as const;

// Prisma maps PostgreSQL BIGINT columns to JavaScript bigint, but PostgreSQL
// itself is limited to signed int64. Keep every externally supplied atomic
// amount within that range before it reaches a persistence boundary.
export const POSTGRES_BIGINT_MAX = 9223372036854775807n;

export const paymentSourceTypeSchema = z.nativeEnum(PaymentSourceType).describe('The configured payment source type');

const evmAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Expected an EVM address');
const x402AssetSchema = evmAddressSchema.describe('ERC-20 token contract address');
const x402AtomicAmountSchema = z
	.string()
	.regex(/^\d+$/)
	.refine((amount) => {
		const parsedAmount = BigInt(amount);
		return parsedAmount > 0n && parsedAmount <= POSTGRES_BIGINT_MAX;
	}, `Atomic amount must be between 1 and ${POSTGRES_BIGINT_MAX.toString()}`)
	.describe('Atomic token amount');

const cardanoSupportedPaymentSourceSchema = z.object({
	chain: z.literal(SupportedPaymentSourceChain.Cardano).describe('The blockchain this payment source is available on'),
	network: z.nativeEnum(Network).describe('The Cardano network this payment source is available on'),
	paymentSourceType: paymentSourceTypeSchema,
	address: z.string().max(250).describe('The escrow smart contract address for this payment source'),
});

const x402SupportedPaymentSourceBaseSchema = z.object({
	chain: z.literal(SupportedPaymentSourceChain.EVM).describe('The chain family used by standard x402'),
	network: z
		.string()
		.regex(/^eip155:\d+$/, 'x402 EVM network must be a CAIP-2 eip155 chain id')
		.describe('CAIP-2 EVM network id, for example eip155:8453'),
	paymentSourceType: paymentSourceTypeSchema.nullable().optional(),
	address: evmAddressSchema.optional().describe('Alias for payTo, kept for existing payment-source shape'),
	scheme: z.literal('Exact').describe('x402 payment scheme'),
	payTo: evmAddressSchema.describe('EVM address receiving the x402 payment'),
	resource: z.string().url().max(500).optional().describe('Optional absolute resource URL this x402 option protects'),
	extra: z.record(z.string(), z.unknown()).optional().describe('Additional x402 metadata'),
});

const x402FixedPaymentSourceSchema = x402SupportedPaymentSourceBaseSchema.extend({
	pricingType: z.literal(PricingType.Fixed).describe('A fixed amount is advertised in the registry'),
	asset: x402AssetSchema,
	amount: x402AtomicAmountSchema,
	decimals: z.number().int().min(0).max(255).describe('Token decimals'),
});

const x402DynamicPaymentSourceSchema = x402SupportedPaymentSourceBaseSchema.extend({
	pricingType: z
		.literal(PricingType.Dynamic)
		.describe('The exact positive amount is supplied dynamically in each x402 payment requirement'),
	asset: x402AssetSchema.optional().describe('Optional asset allowlist for dynamic payment requirements'),
	decimals: z.number().int().min(0).max(255).optional().describe('Decimals for the optional dynamic asset'),
});

const x402FreePaymentSourceSchema = x402SupportedPaymentSourceBaseSchema.extend({
	pricingType: z.literal(PricingType.Free).describe('This resource does not require an x402 payment'),
});

export const supportedPaymentSourceSchema = z
	.union([
		cardanoSupportedPaymentSourceSchema,
		x402FixedPaymentSourceSchema,
		x402DynamicPaymentSourceSchema,
		x402FreePaymentSourceSchema,
	])
	.superRefine((source, ctx) => {
		if (
			source.chain === SupportedPaymentSourceChain.EVM &&
			source.address != null &&
			source.address.toLowerCase() !== source.payTo.toLowerCase()
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['address'],
				message: 'x402 address alias must match payTo',
			});
		}
		if (
			source.chain === SupportedPaymentSourceChain.EVM &&
			source.pricingType === PricingType.Dynamic &&
			(source.asset == null) !== (source.decimals == null)
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: source.asset == null ? ['asset'] : ['decimals'],
				message: 'Dynamic x402 asset and decimals must be provided together',
			});
		}
	});

// Fixed was the only x402 pricing model before pricingType was introduced.
// Keep that compatibility only at write boundaries: response/on-chain schemas
// retain a required discriminator so generated clients never see it as optional.
const legacyX402FixedPaymentSourceInputSchema = z.preprocess(
	// A payload that carries pricingType must parse via supportedPaymentSourceSchema:
	// non-strict parsing would strip a malformed pricingType (e.g. lowercase
	// 'fixed') and silently re-interpret the source as Fixed. Poison such input to
	// undefined so this union member fails while other unknown keys are still
	// stripped, matching the pre-pricingType schema behavior. (A pricingType key
	// in the object shape would be the natural guard, but zod-to-openapi cannot
	// represent ZodUndefined/ZodNever fields.)
	(value) => (typeof value === 'object' && value != null && 'pricingType' in value ? undefined : value),
	x402SupportedPaymentSourceBaseSchema
		.extend({
			asset: x402AssetSchema,
			amount: x402AtomicAmountSchema,
			decimals: z.number().int().min(0).max(255).describe('Token decimals'),
		})
		.superRefine((source, ctx) => {
			if (source.address != null && source.address.toLowerCase() !== source.payTo.toLowerCase()) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['address'],
					message: 'x402 address alias must match payTo',
				});
			}
		})
		.transform((source) => ({ ...source, pricingType: PricingType.Fixed })),
);

export const supportedPaymentSourceInputSchema = z.union([
	supportedPaymentSourceSchema,
	legacyX402FixedPaymentSourceInputSchema,
]);

// Hard cap on advertised payment sources, enforced both on parse and when
// emitting on-chain metadata.
export const MAX_SUPPORTED_PAYMENT_SOURCES = 25;

export const supportedPaymentSourcesSchema = z
	.array(supportedPaymentSourceSchema)
	.min(1)
	.max(MAX_SUPPORTED_PAYMENT_SOURCES)
	.describe('Payment sources advertised by this registry entry');

export const supportedPaymentSourcesInputSchema = z
	.array(supportedPaymentSourceInputSchema)
	.min(1)
	.max(MAX_SUPPORTED_PAYMENT_SOURCES)
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

// One asset descriptor inside a rail's pricing block. `asset` is the rail's
// currency id: `''` (lovelace) or `policyId+assetName` hex for Cardano, or an
// ERC-20 contract `0x…` for EVM.
const supportedPaymentSourceMetadataAssetSchema = z.object({
	asset: metadataStringSchema,
	decimals: metadataStringSchema.optional(),
});

const supportedPaymentSourceMetadataAmountSchema = supportedPaymentSourceMetadataAssetSchema.extend({
	amount: metadataStringSchema,
});

// Shared pricing sub-object, identical across rails. `fixed` carries priced
// assets; `dynamic` carries accepted assets whose amount is chosen per request.
const supportedPaymentSourceMetadataPricingSchema = z.object({
	pricingType: metadataStringSchema,
	fixed: z.array(supportedPaymentSourceMetadataAmountSchema).optional(),
	dynamic: z.array(supportedPaymentSourceMetadataAssetSchema).optional(),
});

// Superset of both rails' settlement fields; the parser reads only the keys
// relevant to `chain`. Cardano uses `paymentSourceType`/`address` (escrow
// contract); x402/EVM uses `scheme`/`payTo`/`resource`/`extra`.
const supportedPaymentSourceMetadataSettlementSchema = z.object({
	paymentSourceType: metadataStringSchema.optional(),
	address: metadataStringSchema.optional(),
	scheme: metadataStringSchema.optional(),
	payTo: metadataStringSchema.optional(),
	resource: metadataStringSchema.optional(),
	extra: z.unknown().optional(),
});

// On-chain (CIP-25) shape of one supported payment source. Each leaf may be a
// single string or an array of <=60-char chunks. A source is self-contained:
// rail-native `settlement` (where/how funds move) + shared `pricing` (how much).
// Reassembled into the flat `SupportedPaymentSource` domain shape by
// `parseSupportedPaymentSourcesFromMetadata`.
export const supportedPaymentSourceMetadataSchema = z.object({
	chain: metadataStringSchema,
	network: metadataStringSchema,
	settlement: supportedPaymentSourceMetadataSettlementSchema.optional(),
	pricing: supportedPaymentSourceMetadataPricingSchema.optional(),
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

function validateCardanoPubKeyAddressForNetwork(address: string, network: Network) {
	validateCardanoAddressForNetwork(address, network);
	const parsedAddress = deserializeAddress(address);
	const addressType = parsedAddress.getType();
	// The vested_pay validators (V1 and V2) only ever read the PAYMENT
	// credential of participant addresses (`address_to_verification_key`
	// matches `VerificationKey(vkey)` and ignores the stake part), and payouts
	// are full-address equality against the datum. Base (payment key + stake
	// key) and enterprise (payment key, no stake) addresses are therefore both
	// safe; the datum builders encode a missing stake credential as Plutus
	// `None`. Script payment credentials remain banned — every spending
	// redeemer does `expect Some(vk) = address_to_verification_key(...)`, so a
	// script-credential participant permanently bricks the escrow. Pointer,
	// reward, and script-stake variants stay rejected as well.
	if (addressType !== AddressType.BasePaymentKeyStakeKey && addressType !== AddressType.EnterpriseKey) {
		throw new Error('Cardano address must be a base or enterprise address with a payment key credential');
	}

	try {
		resolvePaymentKeyHash(address);
		if (addressType === AddressType.BasePaymentKeyStakeKey) {
			resolveStakeKeyHash(address);
		}
	} catch {
		throw new Error('Cardano address must include a payment key credential');
	}
}

export function isCardanoPubKeyAddressForNetwork(address: string, network: Network): boolean {
	try {
		validateCardanoPubKeyAddressForNetwork(address, network);
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
	const seenSources = new Set<string>();
	for (const supportedPaymentSource of supportedPaymentSources) {
		const sourceKey =
			supportedPaymentSource.chain === SupportedPaymentSourceChain.EVM
				? JSON.stringify([
						supportedPaymentSource.chain,
						supportedPaymentSource.network,
						supportedPaymentSource.scheme,
						supportedPaymentSource.pricingType,
						'asset' in supportedPaymentSource ? (supportedPaymentSource.asset ?? '').toLowerCase() : '',
						'amount' in supportedPaymentSource && supportedPaymentSource.amount != null
							? BigInt(supportedPaymentSource.amount).toString()
							: '',
						'decimals' in supportedPaymentSource ? (supportedPaymentSource.decimals ?? '') : '',
						supportedPaymentSource.payTo.toLowerCase(),
						supportedPaymentSource.resource ?? '',
					])
				: JSON.stringify([
						supportedPaymentSource.chain,
						supportedPaymentSource.network,
						supportedPaymentSource.paymentSourceType,
						supportedPaymentSource.address,
					]);
		if (seenSources.has(sourceKey)) {
			throw new Error('Duplicate supported payment source');
		}
		seenSources.add(sourceKey);

		if (supportedPaymentSource.chain === SupportedPaymentSourceChain.EVM) {
			if (registeringPaymentSourceType !== PaymentSourceType.Web3CardanoV2) {
				throw new Error('x402 payment sources may only be advertised by V2 registry entries.');
			}
			if (supportedPaymentSource.pricingType === PricingType.Fixed && BigInt(supportedPaymentSource.amount) <= 0n) {
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
		parsed.data.map((source) => {
			const chain = metadataToString(source.chain);
			const settlement = source.settlement ?? {};
			const pricingType = metadataToString(source.pricing?.pricingType);
			const fixed = source.pricing?.fixed?.[0];
			const dynamic = source.pricing?.dynamic?.[0];
			if (chain === SupportedPaymentSourceChain.EVM) {
				const base = {
					chain,
					network: metadataToString(source.network),
					scheme: metadataToString(settlement.scheme),
					payTo: metadataToString(settlement.payTo),
					resource: metadataToString(settlement.resource),
					extra: settlement.extra,
				};
				if (pricingType === PricingType.Fixed) {
					const decimals = metadataToString(fixed?.decimals);
					return {
						...base,
						pricingType,
						asset: metadataToString(fixed?.asset),
						amount: metadataToString(fixed?.amount),
						decimals: decimals != null ? Number(decimals) : undefined,
					};
				}
				if (pricingType === PricingType.Dynamic) {
					const decimals = metadataToString(dynamic?.decimals);
					return {
						...base,
						pricingType,
						asset: metadataToString(dynamic?.asset),
						decimals: decimals != null ? Number(decimals) : undefined,
					};
				}
				return { ...base, pricingType };
			}
			return {
				chain,
				network: metadataToString(source.network),
				paymentSourceType: metadataToString(settlement.paymentSourceType),
				address: metadataToString(settlement.address),
			};
		}),
	);
	return reparsed.success ? reparsed.data : null;
}
