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
// Well-known sentinel addresses some ecosystems use to denote the native
// asset. They are syntactically valid EVM addresses but can never be an
// ERC-20 contract, so reject them anywhere a token contract is expected.
const EVM_NATIVE_SENTINEL_ADDRESSES = new Set([
	'0x0000000000000000000000000000000000000000',
	'0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
]);
const x402AssetSchema = evmAddressSchema
	.refine(
		(asset) => !EVM_NATIVE_SENTINEL_ADDRESSES.has(asset.toLowerCase()),
		'Native-asset sentinel addresses are not ERC-20 token contracts',
	)
	.describe('ERC-20 token contract address');
export const atomicAmountSchema = z
	.string()
	// int64 max is 19 digits; bound the string before BigInt parsing.
	.max(19)
	.regex(/^\d+$/)
	.refine((amount) => {
		// Zod 4 runs refinements even when the checks above already failed, so
		// re-guard before BigInt() — BigInt('abc') throws an uncaught
		// SyntaxError (a 500), not a validation issue.
		if (!/^\d+$/.test(amount)) return false;
		const parsedAmount = BigInt(amount);
		return parsedAmount > 0n && parsedAmount <= POSTGRES_BIGINT_MAX;
	}, `Atomic amount must be between 1 and ${POSTGRES_BIGINT_MAX.toString()}`)
	.describe('Atomic token amount');

const supportedPaymentSourceFixedPriceSchema = z.object({
	asset: z.string().max(250).describe('Chain-native asset identifier'),
	amount: atomicAmountSchema,
	decimals: z.number().int().min(0).max(255).optional().describe('Asset decimals when required by the rail'),
});

const supportedPaymentSourceDynamicAssetSchema = z.object({
	asset: z.string().max(250).describe('Optional accepted asset identifier'),
	decimals: z.number().int().min(0).max(255).optional().describe('Asset decimals when required by the rail'),
});

export const supportedPaymentSourcePricingSchema = z.union([
	z.object({
		pricingType: z.literal(PricingType.Fixed).describe('A fixed amount is advertised for this payment source'),
		fixed: z.array(supportedPaymentSourceFixedPriceSchema).min(1).max(5),
	}),
	z.object({
		pricingType: z
			.literal(PricingType.Dynamic)
			.describe('The exact positive amount is supplied dynamically for each payment request'),
		dynamic: z.array(supportedPaymentSourceDynamicAssetSchema).min(1).max(1).optional(),
	}),
	z.object({
		pricingType: z.literal(PricingType.Free).describe('This payment source does not require payment'),
	}),
]);

const cardanoSupportedPaymentSourceSchema = z.object({
	chain: z.literal(SupportedPaymentSourceChain.Cardano).describe('The blockchain this payment source is available on'),
	network: z.nativeEnum(Network).describe('The Cardano network this payment source is available on'),
	paymentSourceType: paymentSourceTypeSchema,
	address: z.string().max(250).describe('The escrow smart contract address for this payment source'),
	pricing: supportedPaymentSourcePricingSchema,
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

const x402SupportedPaymentSourceSchema = x402SupportedPaymentSourceBaseSchema.extend({
	pricing: supportedPaymentSourcePricingSchema,
});

export const supportedPaymentSourceSchema = z
	.union([cardanoSupportedPaymentSourceSchema, x402SupportedPaymentSourceSchema])
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

		if (source.chain === SupportedPaymentSourceChain.Cardano) {
			if (source.pricing.pricingType === PricingType.Fixed) {
				source.pricing.fixed.forEach((price, index) => {
					if (price.decimals != null) {
						ctx.addIssue({
							code: z.ZodIssueCode.custom,
							path: ['pricing', 'fixed', index, 'decimals'],
							message: 'Cardano fixed pricing does not use decimals',
						});
					}
				});
			}
			if (source.pricing.pricingType === PricingType.Dynamic && source.pricing.dynamic != null) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['pricing', 'dynamic'],
					message: 'Cardano dynamic pricing does not support an asset allowlist',
				});
			}
			return;
		}

		if (source.pricing.pricingType === PricingType.Fixed) {
			if (source.pricing.fixed.length !== 1) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['pricing', 'fixed'],
					message: 'Fixed x402 pricing requires exactly one asset',
				});
				return;
			}
			const [price] = source.pricing.fixed;
			if (!x402AssetSchema.safeParse(price.asset).success) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['pricing', 'fixed', 0, 'asset'],
					message: 'Fixed x402 pricing requires an ERC-20 token contract address',
				});
			}
			if (price.decimals == null) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['pricing', 'fixed', 0, 'decimals'],
					message: 'Fixed x402 pricing requires token decimals',
				});
			}
		}

		if (source.pricing.pricingType === PricingType.Dynamic && source.pricing.dynamic != null) {
			const [acceptedAsset] = source.pricing.dynamic;
			if (!x402AssetSchema.safeParse(acceptedAsset.asset).success) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['pricing', 'dynamic', 0, 'asset'],
					message: 'Dynamic x402 accepted asset must be an ERC-20 token contract address',
				});
			}
			if (acceptedAsset.decimals == null) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['pricing', 'dynamic', 0, 'decimals'],
					message: 'Dynamic x402 accepted asset requires token decimals',
				});
			}
		}
	});

// Hard cap on advertised payment sources, enforced both on parse and when
// emitting on-chain metadata.
export const MAX_SUPPORTED_PAYMENT_SOURCES = 25;

export const supportedPaymentSourcesSchema = z
	.array(supportedPaymentSourceSchema)
	.min(1)
	.max(MAX_SUPPORTED_PAYMENT_SOURCES)
	.describe('Payment sources advertised by this registry entry');

export type SupportedPaymentSource = z.infer<typeof supportedPaymentSourceSchema>;
export type SupportedPaymentSourcePricing = z.infer<typeof supportedPaymentSourcePricingSchema>;

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

// `Number()` coerces `''` to 0 and accepts hex/exponent spellings; metadata
// decimals must be plain digit strings. Returning NaN makes the zod
// `.int()` check fail so malformed third-party metadata is rejected instead
// of silently misparsed.
function parseMetadataDecimals(value: string | string[] | undefined): number | undefined {
	const decimals = metadataToString(value);
	if (decimals == null) return undefined;
	return /^\d+$/.test(decimals) ? Number(decimals) : Number.NaN;
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
	// against. V1 pricing is top-level and therefore cannot advertise this
	// V2-only source list. V2 entries may advertise only V2 Cardano sources.
	// Caller may pass `undefined` only on early-boot / off-route
	// validation paths where the registering type is not yet bound;
	// in that case the asymmetric rule is skipped.
	registeringPaymentSourceType?: PaymentSourceType,
	// CAIP-2 networks the caller is authorized to advertise on. `null` means
	// unlimited (admin); `undefined` skips the check (off-route validation paths).
	allowedCaip2Networks?: string[] | null,
) {
	if (registeringPaymentSourceType === PaymentSourceType.Web3CardanoV1 && supportedPaymentSources.length > 0) {
		throw new Error('V1 registry entries must not advertise supported payment sources');
	}

	const seenSources = new Set<string>();
	for (const [index, supportedPaymentSource] of supportedPaymentSources.entries()) {
		const sourceKey = getSupportedPaymentSourceCanonicalKey(supportedPaymentSource);
		if (seenSources.has(sourceKey)) {
			throw new Error(`supportedPaymentSources[${index}] duplicates an earlier payment option`);
		}
		seenSources.add(sourceKey);

		if (supportedPaymentSource.chain === SupportedPaymentSourceChain.EVM) {
			if (registeringPaymentSourceType !== PaymentSourceType.Web3CardanoV2) {
				throw new Error('x402 payment sources may only be advertised by V2 registry entries.');
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

// Canonical asset spelling for duplicate detection. Must stay in lockstep
// with the persistence-side normalization (`normalizeCardanoAsset` in
// `src/services/registry/source-pricing.ts`): both `''` and `'lovelace'`
// denote ADA and are persisted as `''`, so the canonical key must fold them
// too or alias-spelled duplicates evade rejection.
function canonicalAssetId(asset: string): string {
	const lowered = asset.toLowerCase();
	return lowered === 'lovelace' ? '' : lowered;
}

// Codepoint comparison: `localeCompare` is ICU/locale-dependent and this sort
// feeds a PERSISTED uniqueness key (`canonicalKey`), which must be stable
// across deployments.
function compareCodepoints(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalPricing(pricing: SupportedPaymentSourcePricing) {
	if (pricing.pricingType === PricingType.Fixed) {
		return {
			pricingType: pricing.pricingType,
			fixed: pricing.fixed
				.map((price) => ({
					asset: canonicalAssetId(price.asset),
					amount: BigInt(price.amount).toString(),
					decimals: price.decimals ?? null,
				}))
				.sort((left, right) =>
					compareCodepoints(
						`${left.asset}:${left.amount}:${left.decimals ?? ''}`,
						`${right.asset}:${right.amount}:${right.decimals ?? ''}`,
					),
				),
		};
	}
	if (pricing.pricingType === PricingType.Dynamic) {
		return {
			pricingType: pricing.pricingType,
			dynamic:
				pricing.dynamic?.map((asset) => ({
					asset: canonicalAssetId(asset.asset),
					decimals: asset.decimals ?? null,
				})) ?? [],
		};
	}
	return { pricingType: pricing.pricingType };
}

export function getSupportedPaymentSourceCanonicalKey(source: SupportedPaymentSource): string {
	return source.chain === SupportedPaymentSourceChain.EVM
		? JSON.stringify({
				chain: source.chain,
				network: source.network,
				scheme: source.scheme,
				payTo: source.payTo.toLowerCase(),
				resource: source.resource ?? '',
				pricing: canonicalPricing(source.pricing),
			})
		: JSON.stringify({
				chain: source.chain,
				network: source.network,
				paymentSourceType: source.paymentSourceType,
				address: source.address,
				pricing: canonicalPricing(source.pricing),
			});
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
			const pricing =
				pricingType === PricingType.Fixed
					? {
							pricingType,
							fixed:
								source.pricing?.fixed?.map((price) => ({
									asset: metadataToString(price.asset),
									amount: metadataToString(price.amount),
									decimals: parseMetadataDecimals(price.decimals),
								})) ?? [],
						}
					: pricingType === PricingType.Dynamic
						? {
								pricingType,
								dynamic: source.pricing?.dynamic?.map((asset) => ({
									asset: metadataToString(asset.asset),
									decimals: parseMetadataDecimals(asset.decimals),
								})),
							}
						: { pricingType };
			if (chain === SupportedPaymentSourceChain.EVM) {
				return {
					chain,
					network: metadataToString(source.network),
					scheme: metadataToString(settlement.scheme),
					payTo: metadataToString(settlement.payTo),
					resource: metadataToString(settlement.resource),
					extra: settlement.extra,
					pricing,
				};
			}
			return {
				chain,
				network: metadataToString(source.network),
				paymentSourceType: metadataToString(settlement.paymentSourceType),
				address: metadataToString(settlement.address),
				pricing,
			};
		}),
	);
	return reparsed.success ? reparsed.data : null;
}
