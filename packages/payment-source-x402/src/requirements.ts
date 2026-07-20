import canonicalStringify from 'canonical-json';
import createHttpError from 'http-errors';
import type { Network, PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { PricingType, Prisma, X402PaymentScheme, prisma } from '@masumi/payment-core/db';
import { POSTGRES_BIGINT_MAX } from '@masumi/payment-core/payment-source';
import { normalizeAddress } from './internal';

export const EXACT_SCHEME = 'exact';
const DEFAULT_X402_TIMEOUT_SECONDS = 300;
const PERMIT2_EXTRA = { assetTransferMethod: 'permit2' };

export type X402SourceRecord = NonNullable<Awaited<ReturnType<typeof getX402SupportedPaymentSourceOrThrow>>>;

type X402RequirementExtra = {
	assetTransferMethod?: unknown;
	decimals?: unknown;
};

function toJsonObject(value: unknown): Prisma.JsonObject {
	if (value != null && typeof value === 'object' && !Array.isArray(value)) {
		return value;
	}
	return {};
}

function toRequirementExtra(value: unknown): X402RequirementExtra {
	if (value != null && typeof value === 'object' && !Array.isArray(value)) {
		return value as X402RequirementExtra;
	}
	return {};
}

function assertValidAsset(asset: string): void {
	if (!/^0x[a-fA-F0-9]{40}$/.test(asset)) {
		throw createHttpError(400, 'x402 asset must be an EVM token contract');
	}
}

function parseDecimals(value: unknown): number {
	const decimals = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
	if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
		throw createHttpError(400, 'x402 payment requirements must include valid asset decimals');
	}
	return decimals;
}

function assertPositiveAmount(amount: string): void {
	if (!/^\d+$/.test(amount)) {
		throw createHttpError(400, 'x402 payment amount must be a positive unsigned integer');
	}
	const parsedAmount = BigInt(amount);
	if (parsedAmount <= 0n || parsedAmount > POSTGRES_BIGINT_MAX) {
		throw createHttpError(
			400,
			`x402 payment amount must be between 1 and ${POSTGRES_BIGINT_MAX.toString()} atomic units`,
		);
	}
}

export function sourceToRequirements(
	source: X402SourceRecord,
	trustedRuntimeRequirements?: PaymentRequirements,
): PaymentRequirements {
	if (source.scheme !== X402PaymentScheme.Exact) {
		throw createHttpError(400, 'Only x402 exact payment sources are supported');
	}
	if (source.payTo == null || source.Pricing == null) {
		throw createHttpError(400, 'x402 supported payment source is incomplete');
	}
	const pricingType = source.Pricing.pricingType;

	if (pricingType === PricingType.Free) {
		throw createHttpError(400, 'Free x402 sources do not require payment verification or settlement');
	}

	let asset: string;
	let amount: string;
	let decimals: number;
	let maxTimeoutSeconds = DEFAULT_X402_TIMEOUT_SECONDS;
	let runtimeExtra: Prisma.JsonObject = {};

	if (pricingType === PricingType.Fixed) {
		const [fixedPrice] = source.Pricing.FixedPricing?.Amounts ?? [];
		if (source.Pricing.FixedPricing?.Amounts.length !== 1 || fixedPrice == null || source.fixedDecimals == null) {
			throw createHttpError(400, 'Fixed x402 supported payment source is incomplete');
		}
		asset = fixedPrice.unit;
		amount = fixedPrice.amount.toString();
		decimals = source.fixedDecimals;
	} else if (pricingType === PricingType.Dynamic) {
		if (trustedRuntimeRequirements == null) {
			throw createHttpError(400, 'Dynamic x402 sources require trusted runtime payment requirements');
		}
		if (
			trustedRuntimeRequirements.scheme !== EXACT_SCHEME ||
			trustedRuntimeRequirements.network !== source.network ||
			normalizeAddress(trustedRuntimeRequirements.payTo) !== normalizeAddress(source.payTo)
		) {
			throw createHttpError(400, 'Runtime x402 payment requirements do not match the registered source');
		}
		asset = trustedRuntimeRequirements.asset;
		amount = trustedRuntimeRequirements.amount;
		decimals = source.dynamicDecimals ?? parseDecimals(toRequirementExtra(trustedRuntimeRequirements.extra).decimals);
		maxTimeoutSeconds = trustedRuntimeRequirements.maxTimeoutSeconds;
		if (!Number.isInteger(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) {
			throw createHttpError(400, 'x402 payment requirements must include a positive timeout');
		}
		runtimeExtra = toJsonObject(trustedRuntimeRequirements.extra);
		if (source.dynamicAsset != null && normalizeAddress(source.dynamicAsset) !== normalizeAddress(asset)) {
			throw createHttpError(400, 'x402 payment asset is not accepted by this registered resource');
		}
	} else {
		throw createHttpError(400, 'Unsupported x402 pricing type');
	}

	assertValidAsset(asset);
	assertPositiveAmount(amount);

	return {
		scheme: EXACT_SCHEME,
		network: source.network as Network,
		asset,
		amount,
		payTo: source.payTo,
		maxTimeoutSeconds,
		extra: {
			// Runtime extra (owner-issued, only present for Dynamic) wins over the
			// persisted registry extra: dynamic sellers may vary EIP-712 domain
			// details per 402 and the buyer signed the runtime values. The transfer
			// method and decimals stay pinned by this service regardless of input.
			...toJsonObject(source.extra),
			...runtimeExtra,
			...PERMIT2_EXTRA,
			decimals,
		},
	};
}

function resourceMatchesRegisteredResource(registeredResource: string, candidate: string): boolean {
	return candidate === registeredResource;
}

export function assertPaymentPayloadMatchesRegisteredResource(
	source: X402SourceRecord,
	paymentPayload: PaymentPayload,
) {
	if (source.resource == null) return;
	const payloadResourceUrl = paymentPayload.resource?.url;
	if (payloadResourceUrl == null) {
		throw createHttpError(400, 'x402 payment payload resource is required for this registered resource');
	}
	if (!resourceMatchesRegisteredResource(source.resource, payloadResourceUrl)) {
		throw createHttpError(400, 'x402 payment payload resource does not match the registered resource');
	}
}

export async function getX402SupportedPaymentSourceOrThrow(supportedPaymentSourceId: string) {
	const source = await prisma.supportedPaymentSource.findUnique({
		where: { id: supportedPaymentSourceId },
		include: {
			Pricing: {
				include: {
					FixedPricing: {
						include: { Amounts: true },
					},
				},
			},
			RegistryRequest: {
				select: {
					id: true,
					apiBaseUrl: true,
					agentIdentifier: true,
					requestedById: true,
				},
			},
		},
	});
	if (source == null || source.chain !== 'EVM') {
		throw createHttpError(404, 'x402 supported payment source not found');
	}
	return source;
}

export function requirementsMatch(a: PaymentRequirements, b: PaymentRequirements): boolean {
	// Match on every economically- and authorization-relevant field, including
	// maxTimeoutSeconds and the full `extra` (transfer method / EIP-712 domain), so
	// the signing policy pins to the exact selected variant and the SDK cannot sign a
	// different accepts[] entry that happens to share the core economics.
	return (
		a.scheme === b.scheme &&
		a.network === b.network &&
		normalizeAddress(a.asset) === normalizeAddress(b.asset) &&
		a.amount === b.amount &&
		normalizeAddress(a.payTo) === normalizeAddress(b.payTo) &&
		a.maxTimeoutSeconds === b.maxTimeoutSeconds &&
		canonicalStringify(a.extra ?? {}) === canonicalStringify(b.extra ?? {})
	);
}

function assertRequirementsMatchRegisteredSource(requirements: PaymentRequirements, expected: PaymentRequirements) {
	const requirementsExtra = toRequirementExtra(requirements.extra);
	const expectedExtra = toRequirementExtra(expected.extra);
	// Deliberately NOT requirementsMatch(): that canonical-stringify-compares the
	// full `extra`, which hard-fails sellers whose 402 carries extra keys this
	// service does not persist (EIP-712 domain fields) or serializes decimals as
	// a string. Compare only the economically- and authorization-relevant fields.
	if (
		requirements.scheme !== EXACT_SCHEME ||
		requirements.network !== expected.network ||
		normalizeAddress(requirements.asset) !== normalizeAddress(expected.asset) ||
		requirements.amount !== expected.amount ||
		normalizeAddress(requirements.payTo) !== normalizeAddress(expected.payTo) ||
		// Pin maxTimeoutSeconds too, mirroring requirementsMatch, so the signing window
		// cannot drift from the registered policy.
		requirements.maxTimeoutSeconds !== expected.maxTimeoutSeconds ||
		requirementsExtra.assetTransferMethod !== PERMIT2_EXTRA.assetTransferMethod ||
		// decimals arrives untyped from the wire (may be number or string); compare
		// by canonical string form so 6 and "6" are treated as equal.
		String(requirementsExtra.decimals) !== String(expectedExtra.decimals)
	) {
		throw createHttpError(400, 'Remote x402 payment requirements do not match the registered resource');
	}
}

export function assertPayloadRequirementsMatchRegisteredSource(
	requirements: PaymentRequirements,
	expected: PaymentRequirements,
) {
	try {
		assertRequirementsMatchRegisteredSource(requirements, expected);
	} catch {
		throw createHttpError(400, 'x402 payment requirements do not match the registered resource');
	}
}
