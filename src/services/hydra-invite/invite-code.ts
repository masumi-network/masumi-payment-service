/**
 * The form an invite takes when a human moves it.
 *
 * One opaque string rather than a URL with query parameters, for two reasons.
 * A URL invites someone to click it, and clicking is exactly the wrong verb —
 * an invite is pasted into the service that will redeem it, not opened. And
 * anything in a query string ends up in browser history, proxy logs and
 * referrer headers; an invite is not secret, but its nonce is single-use, and a
 * copy sitting in a log is a copy that can be spent.
 *
 * Base64url so it survives email, chat and a terminal without escaping, with a
 * short prefix so an operator who pastes the wrong thing is told which wrong
 * thing they pasted.
 */

import createHttpError from 'http-errors';
import { getOwnValue, isPlainObject } from '@masumi/payment-core/object-properties';
import type { HydraHeadInvitePayloadInput } from './invite-payload';
import type { InviteSignature } from './invite-signing';

export const INVITE_CODE_PREFIX = 'masumi-hydra-invite-1.';

/** Refuse anything implausibly large before spending work parsing it. */
const MAX_CODE_LENGTH = 8 * 1024;

export type DecodedInvite = {
	payload: HydraHeadInvitePayloadInput;
	signature: InviteSignature;
};

export function encodeInviteCode(invite: DecodedInvite): string {
	const json = JSON.stringify({ payload: invite.payload, signature: invite.signature });
	return `${INVITE_CODE_PREFIX}${Buffer.from(json, 'utf8').toString('base64url')}`;
}

const REQUIRED_PAYLOAD_STRINGS = [
	'nonce',
	'expiresAt',
	'network',
	'issuerWalletAddress',
	'hydraVerificationKey',
	'cardanoVerificationKey',
	'advertise',
	'exchangeUrl',
] as const;

const REQUIRED_PAYLOAD_NUMBERS = [
	'contestationPeriodSeconds',
	'depositPeriodSeconds',
	'unsyncedPeriodSeconds',
] as const;

/**
 * Parse an invite code into the exact shape the verifier expects.
 *
 * Structural only — nothing here says the invite is genuine. Verification comes
 * next, and it must run against a payload whose fields are known to be the right
 * types, or the canonical hash would differ from the one the issuer signed and
 * every invite would look forged.
 */
export function decodeInviteCode(code: string): DecodedInvite {
	const trimmed = code.trim();
	if (trimmed.length === 0 || trimmed.length > MAX_CODE_LENGTH) {
		throw createHttpError(400, 'that is not an invite code');
	}
	if (!trimmed.startsWith(INVITE_CODE_PREFIX)) {
		throw createHttpError(
			400,
			'that does not look like a Masumi Hydra invite — it should start with "masumi-hydra-invite-1."',
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(trimmed.slice(INVITE_CODE_PREFIX.length), 'base64url').toString('utf8'));
	} catch {
		throw createHttpError(400, 'the invite code is damaged; ask for it again rather than editing it');
	}
	if (!isPlainObject(parsed)) {
		throw createHttpError(400, 'the invite code does not contain an invite');
	}

	const payload = getOwnValue(parsed, 'payload');
	const signature = getOwnValue(parsed, 'signature');
	if (!isPlainObject(payload) || !isPlainObject(signature)) {
		throw createHttpError(400, 'the invite code is missing its payload or signature');
	}

	for (const field of REQUIRED_PAYLOAD_STRINGS) {
		if (typeof getOwnValue(payload, field) !== 'string') {
			throw createHttpError(400, `the invite is missing ${field}`);
		}
	}
	for (const field of REQUIRED_PAYLOAD_NUMBERS) {
		if (typeof getOwnValue(payload, field) !== 'number') {
			throw createHttpError(400, `the invite is missing ${field}`);
		}
	}
	const ledgerParamsHash = getOwnValue(payload, 'ledgerParamsHash');
	if (ledgerParamsHash !== null && typeof ledgerParamsHash !== 'string') {
		throw createHttpError(400, 'the invite has a malformed ledgerParamsHash');
	}
	if (typeof getOwnValue(signature, 'signature') !== 'string' || typeof getOwnValue(signature, 'key') !== 'string') {
		throw createHttpError(400, 'the invite signature is malformed');
	}

	return {
		payload: payload as unknown as HydraHeadInvitePayloadInput,
		signature: signature as unknown as InviteSignature,
	};
}
