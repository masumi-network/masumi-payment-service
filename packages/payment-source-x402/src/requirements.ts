import canonicalStringify from 'canonical-json';
import createHttpError from 'http-errors';
import type { Network, PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { Prisma, X402PaymentScheme, prisma } from '@masumi/payment-core/db';
import { normalizeAddress } from './internal';

export const EXACT_SCHEME = 'exact';
const DEFAULT_X402_TIMEOUT_SECONDS = 300;
const PERMIT2_EXTRA = { assetTransferMethod: 'permit2' };

export type X402SourceRecord = NonNullable<Awaited<ReturnType<typeof getX402SupportedPaymentSourceOrThrow>>>;

type X402RequirementExtra = {
	assetTransferMethod?: unknown;
	decimals?: unknown;
};

function toJsonObject(value: Prisma.JsonValue | null | undefined): Prisma.JsonObject {
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

export function sourceToRequirements(source: X402SourceRecord): PaymentRequirements {
	if (source.scheme !== X402PaymentScheme.Exact) {
		throw createHttpError(400, 'Only x402 exact payment sources are supported');
	}
	if (source.asset == null || source.amount == null || source.payTo == null || source.decimals == null) {
		throw createHttpError(400, 'x402 supported payment source is incomplete');
	}

	return {
		scheme: EXACT_SCHEME,
		network: source.network as Network,
		asset: source.asset,
		amount: source.amount.toString(),
		payTo: source.payTo,
		maxTimeoutSeconds: DEFAULT_X402_TIMEOUT_SECONDS,
		extra: {
			...toJsonObject(source.extra),
			...PERMIT2_EXTRA,
			decimals: source.decimals,
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
