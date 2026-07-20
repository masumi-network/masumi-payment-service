import canonicalStringify from 'canonical-json';
import createHttpError from 'http-errors';
import type { Network, PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { PricingType, Prisma, X402PaymentScheme, prisma } from '@masumi/payment-core/db';
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
	if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n) {
		throw createHttpError(400, 'x402 payment amount must be a positive unsigned integer');
	}
}

export function sourceToRequirements(
	source: X402SourceRecord,
	trustedRuntimeRequirements?: PaymentRequirements,
): PaymentRequirements {
	if (source.scheme !== X402PaymentScheme.Exact) {
		throw createHttpError(400, 'Only x402 exact payment sources are supported');
	}
	if (source.payTo == null || source.pricingType == null) {
		throw createHttpError(400, 'x402 supported payment source is incomplete');
	}

	if (source.pricingType === PricingType.Free) {
		throw createHttpError(400, 'Free x402 sources do not require payment verification or settlement');
	}

	let asset: string;
	let amount: string;
	let decimals: number;
	let maxTimeoutSeconds = DEFAULT_X402_TIMEOUT_SECONDS;
	let runtimeExtra: Prisma.JsonObject = {};

	if (source.pricingType === PricingType.Fixed) {
		if (source.asset == null || source.amount == null || source.decimals == null) {
			throw createHttpError(400, 'Fixed x402 supported payment source is incomplete');
		}
		asset = source.asset;
		amount = source.amount.toString();
		decimals = source.decimals;
	} else if (source.pricingType === PricingType.Dynamic) {
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
		decimals = source.decimals ?? parseDecimals(toRequirementExtra(trustedRuntimeRequirements.extra).decimals);
		maxTimeoutSeconds = trustedRuntimeRequirements.maxTimeoutSeconds;
		if (!Number.isInteger(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) {
			throw createHttpError(400, 'x402 payment requirements must include a positive timeout');
		}
		runtimeExtra = toJsonObject(trustedRuntimeRequirements.extra);
		if (source.asset != null && normalizeAddress(source.asset) !== normalizeAddress(asset)) {
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
			...runtimeExtra,
			...toJsonObject(source.extra),
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
	if (requirements.scheme !== EXACT_SCHEME || !requirementsMatch(requirements, expected)) {
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
