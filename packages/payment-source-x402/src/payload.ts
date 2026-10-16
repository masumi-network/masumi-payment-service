import canonicalStringify from 'canonical-json';
import { createHash } from 'crypto';
import type { PaymentPayload } from '@x402/core/types';
import { extractAndValidatePaymentIdentifier } from '@x402/extensions/payment-identifier';
import { Prisma } from '@masumi/payment-core/db';
import { encrypt } from '@masumi/payment-core/encryption';
import { POSTGRES_BIGINT_MAX } from '@masumi/payment-core/payment-source';

// Payload serialization helpers shared by the sell side (verify/settle in service.ts) and the
// buy side (createX402Payment in pay.ts): hashing, encryption-at-rest, JSON coercion and the
// payment-identifier extraction. Kept in one module so both sides share a single implementation.

// Parse an unsigned-integer string to BigInt, returning null for null/undefined or
// any non-integer form. Used for amounts that arrive from external services where a
// malformed value must not throw (e.g. after an irreversible on-chain settle).
// Also returns null for values that overflow the int64 column: the settle already
// happened on-chain, so recording a null amount is far better than throwing on the DB
// write and losing the settlement record entirely (the tx hash is the source of truth).
export function parseUintStringOrNull(value: string | null | undefined): bigint | null {
	if (value == null || !/^\d+$/.test(value)) return null;
	const parsed = BigInt(value);
	if (parsed > POSTGRES_BIGINT_MAX) return null;
	return parsed;
}

export function toJsonValue(value: unknown): Prisma.InputJsonValue {
	const parsed: unknown = JSON.parse(
		JSON.stringify(value, (_key: string, item: unknown) => (typeof item === 'bigint' ? item.toString() : item)),
	);
	return parsed as Prisma.InputJsonValue;
}

// Canonical serialization shared by the payload hash and the encrypted audit copy.
//
// canonical-json routes a value of `undefined` into its object branch and calls Object.keys on
// it, so any own key valued undefined throws `TypeError: Cannot convert undefined or null to
// object`. @x402/core assembles a signed payload as an object literal and sets `extensions` and
// `resource` as own keys even when the forwarded 402 declared neither, so a payload straight
// from the SDK crashes an unguarded canonicalStringify. toJsonValue drops those keys first.
//
// Both callers must work over identical bytes. paymentPayloadHash is the replay key (unique on
// X402Settlement, and the advisory claim key around settle), so a hashed form that drifts from
// the stored form would be invisible. Deriving the string in one place makes that drift
// impossible.
function canonicalPayloadString(paymentPayload: unknown): string {
	// Without this guard a non-object reaches JSON.parse(undefined) inside toJsonValue and reports
	// `SyntaxError: "undefined" is not valid JSON`, which points at JSON rather than at the payload.
	if (typeof paymentPayload !== 'object' || paymentPayload === null) {
		throw new TypeError('x402 payment payload must be a non-null object');
	}
	return canonicalStringify(toJsonValue(paymentPayload));
}

export function hashX402PaymentPayload(paymentPayload: unknown): string {
	return createHash('sha256').update(canonicalPayloadString(paymentPayload)).digest('hex');
}

// The signed x402 payload embeds a reusable payment authorization (EIP-3009 / Permit2
// signature), so it is persisted encrypted at rest like every other wallet secret. It
// is a write-only audit record (never selected back by the service); decrypt with the
// configured key only for manual forensics. Stored as a JSON string in the Json column.
export function encryptPaymentPayloadForStorage(paymentPayload: unknown): Prisma.InputJsonValue {
	return encrypt(canonicalPayloadString(paymentPayload));
}

export function getPaymentIdentifier(paymentPayload: PaymentPayload): { id: string | null; errors: string[] } {
	const { id, validation } = extractAndValidatePaymentIdentifier(paymentPayload);
	return {
		id,
		errors: validation.valid ? [] : (validation.errors ?? ['Invalid payment-identifier extension']),
	};
}
