// Mesh SDK pinning: this file lives in the V2 package and resolves the V2 mesh
// line (`@meshsdk/core-cst@1.9.1`). See docs/adr/0005-meshsdk-version-pinning-v1-v2.md.
//
// Client for Exchain's quorum co-signing service (`POST /v1/cosign`), speaking
// the contract served at https://cosign-preprod.exchain.network/openapi.yaml
// (`info.version: 1.1.0`, responses carry `schemaVersion: "1.1"`).
//
// The co-signer only ever adds vkey witnesses to a body we froze. It can
// refuse, it can never change what the body spends: the request carries the
// transaction BODY only, every reply must echo the body hash we computed
// ourselves, and each returned witness is verified against that hash before it
// is merged.
import {
	addVKeyWitnessSetToTransaction,
	deserializeTx,
	Ed25519PublicKey,
	Ed25519Signature,
	HexBlob,
	resolveTxHash,
	TransactionWitnessSet,
} from '@meshsdk/core-cst';
import { z } from '@masumi/payment-core/zod';

const DEFAULT_TIMEOUT_MS = 10_000;
/** Exchain prefixes every 32-byte digest on the wire. Our own hashes are bare hex. */
const BLAKE2B_PREFIX = 'blake2b_256:';
const MAX_TX_BODY_HEX = 32_768;

const hex = z.string().regex(/^(?:[0-9a-f]{2})+$/, 'lowercase hex');
const hash28 = z.string().regex(/^[0-9a-f]{56}$/, '28-byte hex');
const hash32 = z.string().regex(/^[0-9a-f]{64}$/, '32-byte hex');
const blake2b256 = z.string().regex(/^blake2b_256:[0-9a-f]{64}$/, 'blake2b_256-prefixed 32-byte hex');
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'lowercase uuid');
const amount = z.string().regex(/^\d+$/, 'minor units as a decimal string');
const assetId = z
	.string()
	.regex(/^(?:lovelace|[0-9a-f]{56}\.(?:[0-9a-f]{2}){0,32})$/, '`lovelace` or `policyId.nameHex`');
const counterparty = z.string().regex(/^sellerVkeyHash:[0-9a-f]{56}$/, '`sellerVkeyHash:<28-byte hex>`');
const address = z.string().min(1).max(200);
const decisionId = z.string().regex(/^dec_[0-9A-HJKMNP-TV-Z]{26}$/, 'ULID with a `dec_` prefix');

export function stripDigestPrefix(digest: string): string {
	return digest.startsWith(BLAKE2B_PREFIX) ? digest.slice(BLAKE2B_PREFIX.length) : digest;
}

export function withDigestPrefix(digest: string): string {
	return digest.startsWith(BLAKE2B_PREFIX) ? digest : `${BLAKE2B_PREFIX}${digest}`;
}

// ---------------------------------------------------------------- denial codes

/**
 * Codes that deny ONE member of the batch; the rest of the batch may still be signed.
 * The first eight are the `MASUMI_INTEGRATION.md` §3.4 set; the last three were added by
 * contract 1.1. This list documents what we expect — the wire field itself is parsed as a
 * plain string (see `memberVerdictSchema`), so a code Exchain adds later is reported rather
 * than treated as a malformed reply.
 */
export const COSIGN_MEMBER_DENIAL_CODES = [
	'per_tx_cap',
	'hourly_outflow',
	'daily_outflow',
	'monthly_outflow',
	'per_seller_cap',
	'velocity_burst',
	'registry_gate',
	'envelope_exhausted',
	'per_agent_cap',
	'price_above_published',
	'counterparty_blocked',
] as const;

/** Codes that deny the WHOLE batch before any member is evaluated. */
export const COSIGN_BATCH_DENIAL_CODES = [
	'asset_not_listed',
	'body_mismatch',
	'payee_unpinned',
	'utxo_unknown',
	'clock_skew',
	'reservation_conflict',
] as const;

export const COSIGN_DENIAL_CODES = [...COSIGN_MEMBER_DENIAL_CODES, ...COSIGN_BATCH_DENIAL_CODES] as const;
export type CosignMemberDenialCode = (typeof COSIGN_MEMBER_DENIAL_CODES)[number];
export type CosignBatchDenialCode = (typeof COSIGN_BATCH_DENIAL_CODES)[number];
export type CosignDenialCode = (typeof COSIGN_DENIAL_CODES)[number];

/** `member_denied` marks "see `members[]`"; it is never a member's own code. */
export const MEMBER_DENIED = 'member_denied' as const;

// ---------------------------------------------------------------- request

export const cosignIntentSchema = z.object({
	/** Unique within the batch. `rebuild.keep` names these. */
	purchaseId: z.string().min(1).max(200),
	/** The escrow output this purchase funds, as its index in the frozen body. Unique within the batch. */
	outputIndex: z.number().int().min(0),
	counterparty,
	amount,
	asset: assetId,
	jobHash: blake2b256,
	agentIdentifier: z.string().min(1).max(250),
});
export type CosignIntent = z.infer<typeof cosignIntentSchema>;

export const cosignContextSchema = z.object({
	nodeId: z.string().min(1).max(200),
	orgId: z.string().min(1).max(200),
	submittedAt: z.string().min(1),
	/** Deprecated since 1.1 (the wallet is resolved from the body), still accepted. Sent for 1.0 clients. */
	walletAddress: address.optional(),
});
export type CosignContext = z.infer<typeof cosignContextSchema>;

export const cosignRequestSchema = z
	.object({
		batchId: uuid,
		/** The guarded wallet input being spent, `txHash#index`. */
		walletUtxoRef: z.string().regex(/^[0-9a-f]{64}#\d+$/, '`txHash#index`'),
		/** In submission order; rolling windows are consumed in this order. */
		intents: z.array(cosignIntentSchema).min(1).max(10),
		context: cosignContextSchema,
		/** The frozen CBOR transaction BODY (not the whole transaction). */
		txBodyHex: hex.max(MAX_TX_BODY_HEX),
	})
	.superRefine((request, ctx) => {
		const purchaseIds = new Set(request.intents.map((intent) => intent.purchaseId));
		if (purchaseIds.size !== request.intents.length) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'intents repeat a purchaseId' });
		}
		const outputIndexes = new Set(request.intents.map((intent) => intent.outputIndex));
		if (outputIndexes.size !== request.intents.length) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'intents repeat an outputIndex' });
		}
	});
export type CosignRequest = z.infer<typeof cosignRequestSchema>;

// ---------------------------------------------------------------- response

const envelopeShape = {
	asOf: z.string().min(1),
	// Deliberately not an enum: a minor contract bump must not stop the node
	// locking funds. Every field we act on is validated on its own, and a
	// witness can never change the body it is merged into.
	schemaVersion: z.string().min(1),
	chainTip: z.object({ slot: z.number().int().min(0), blockHash: hash32 }).nullable(),
};

const boundSchema = z.object({
	limit: amount,
	used: amount,
	remaining: amount,
	windowResetsAt: z.string().optional(),
	scope: z.string().optional(),
});

/**
 * One purchase's verdict. The contract expresses the field combinations as a
 * five-branch `oneOf`; the refinement below enforces the one invariant that
 * matters to us — a code is present exactly when the verdict is `denied` — and
 * keeps the optional bound fields as data.
 */
export const memberVerdictSchema = z
	.object({
		purchaseId: z.string().min(1),
		outputIndex: z.number().int().min(0),
		verdict: z.enum(['allowed', 'denied', 'not_evaluated']),
		/** A documented `COSIGN_MEMBER_DENIAL_CODES` value. Parsed loosely on purpose: nothing
		 *  branches on the code, so an unknown one must not fail the whole reply. */
		denied: z.string().min(1).optional(),
		reasonEnglish: z.string().optional(),
		bound: amount.optional(),
		used: amount.optional(),
		attempted: amount.optional(),
		retryAfterSec: z.number().int().min(0).optional(),
		windowResetsAt: z.string().optional(),
		scope: z.string().optional(),
	})
	.superRefine((member, ctx) => {
		if ((member.verdict === 'denied') !== (member.denied != null)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'a member carries a denial code exactly when its verdict is denied',
			});
		}
	});
export type CosignMemberVerdict = z.infer<typeof memberVerdictSchema>;

const witnessSchema = z.object({
	member: z.string().min(1),
	vkeyHex: hash32,
	signatureHex: z.string().regex(/^[0-9a-f]{128}$/, '64-byte signature hex'),
});

export const cosignAllowSchema = z.object({
	...envelopeShape,
	decisionId,
	txBodyHash: blake2b256,
	requiredSigners: z.array(hash28),
	quorumMembers: z.array(z.string()).min(1),
	/** A CBOR `transaction_witness_set` carrying only vkey witnesses. */
	witnessSetHex: hex.max(20_000),
	witnesses: z.array(witnessSchema).min(1),
	members: z.array(memberVerdictSchema).min(1).max(10),
	boundsRemaining: z.record(z.string(), boundSchema),
	journalRef: z.string().min(1),
});
export type CosignAllow = z.infer<typeof cosignAllowSchema>;

export const cosignDenySchema = z.object({
	...envelopeShape,
	decisionId,
	txBodyHash: blake2b256,
	requiredSigners: z.array(hash28),
	/** `member_denied` routes to the rebuild path; every other value is a batch denial, known
	 *  code or not, so an unrecognised one stops the batch instead of being mistaken for one. */
	denied: z.string().min(1),
	reasonEnglish: z.string().optional(),
	detail: z.string().optional(),
	members: z.array(memberVerdictSchema).min(1).max(10),
	rebuild: z
		.object({
			/** The admitted purchaseIds; rebuild with exactly these, under the same batchId. */
			keep: z.array(z.string()),
			batchId: uuid,
			heldUntil: z.string().min(1),
		})
		.optional(),
	alarm: z.boolean(),
	journalRef: z.string().min(1),
});
export type CosignDeny = z.infer<typeof cosignDenySchema>;

export const quorumUnavailableSchema = z.object({
	...envelopeShape,
	error: z.literal('quorum_unavailable'),
	reachable: z.number().int().min(0),
	threshold: z.number().int().min(1),
	retryAfterSec: z.number().int().min(0),
});
export type QuorumUnavailable = z.infer<typeof quorumUnavailableSchema>;

export type CosignDecision =
	| { httpStatus: 200; approved: CosignAllow }
	| { httpStatus: 409; denied: CosignDeny }
	/** Nothing was consumed and nothing was signed. Retry with the same batchId. */
	| { httpStatus: 503; unavailable: QuorumUnavailable };

// ---------------------------------------------------------------- transport

export type CosignConfig = {
	url: string;
	apiKey: string;
	timeoutMs?: number;
	trustedPlaintextHosts?: string[];
};

/** Anything other than an explicit approve, deny or quorum outage. Never a reason to submit, never a denial. */
export class CosignTransportError extends Error {
	constructor(
		message: string,
		readonly status: number | null,
		readonly retryAfterSec?: number,
	) {
		super(message);
		this.name = 'CosignTransportError';
	}
}

function isLoopbackHost(hostname: string): boolean {
	if (hostname === 'localhost' || hostname === '::1') return true;
	const octets = hostname.split('.');
	return (
		octets.length === 4 &&
		octets[0] === '127' &&
		octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
	);
}

/**
 * Base URL of the co-sign service, normalised without a trailing slash.
 * TLS is required except for loopback and hosts explicitly allowlisted.
 */
export function assertSafeCosignUrl(rawUrl: string, trustedPlaintextHosts: string[] = []): string {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error('co-sign service URL is malformed');
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new Error(`co-sign service URL uses unsupported protocol ${url.protocol}`);
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new Error('co-sign service URL must not contain credentials, a query or a fragment');
	}
	const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
	const trusted = trustedPlaintextHosts.map((host) => host.trim().toLowerCase()).filter(Boolean);
	if (url.protocol === 'http:' && !isLoopbackHost(hostname) && !trusted.includes(hostname)) {
		throw new Error('co-sign service URL must use https outside loopback or an allowlisted plaintext host');
	}
	return url.toString().replace(/\/+$/, '');
}

// ---------------------------------------------------------------- body decoding

export type CosignBody = {
	/** The body alone, as the contract's `txBodyHex`. */
	txBodyHex: string;
	/** `blake2b_256(body)`, bare hex. Identical to the transaction hash. */
	txBodyHash: string;
	/** Decoded from the body, never taken from a request hint. */
	requiredSigners: string[];
};

/**
 * Split a frozen transaction into the body the co-signer judges and the hash it
 * must sign. The body's CBOR is byte-identical to the bytes inside the
 * transaction, so `blake2b_256(txBodyHex)` is the transaction hash.
 */
export function decodeCosignBody(txCbor: string): CosignBody {
	const body = deserializeTx(txCbor).body();
	return {
		txBodyHex: body.toCbor(),
		txBodyHash: resolveTxHash(txCbor),
		requiredSigners:
			body
				.requiredSigners()
				?.values()
				.map((hash) => hash.toCore()) ?? [],
	};
}

export type CosignBodyEcho = Pick<CosignBody, 'txBodyHash' | 'requiredSigners'>;

/** The two fields every reply must echo back. Quorum requests alone omit the agent signer. */
export function decodeCosignBodyEcho(txCbor: string): CosignBodyEcho {
	const { txBodyHash, requiredSigners } = decodeCosignBody(txCbor);
	return { txBodyHash, requiredSigners };
}

/** What the node knows before it reads a reply. Everything here is checked against the reply. */
export type CosignExpectation = CosignBodyEcho & {
	batchId: string;
	/** Our intents' purchaseIds, in submission order. */
	purchaseIds: string[];
};

// ---------------------------------------------------------------- response validation

function sameSignerSet(actual: string[], expected: string[]): boolean {
	const left = [...actual].sort();
	const right = [...expected].sort();
	return (
		left.length === right.length &&
		new Set(left).size === left.length &&
		left.every((signer, index) => signer === right[index])
	);
}

function assertBoundToOurBody(
	reply: { txBodyHash: string; requiredSigners: string[]; members: CosignMemberVerdict[] },
	expected: CosignExpectation,
	status: number,
): void {
	if (stripDigestPrefix(reply.txBodyHash) !== expected.txBodyHash) {
		throw new CosignTransportError('co-sign response names a different transaction body', status);
	}
	if (!sameSignerSet(reply.requiredSigners, expected.requiredSigners)) {
		throw new CosignTransportError('co-sign response names different required signers', status);
	}
	// "Same length and order as `intents`" — so a verdict can never be read
	// against the wrong purchase.
	if (
		reply.members.length !== expected.purchaseIds.length ||
		reply.members.some((member, index) => member.purchaseId !== expected.purchaseIds[index])
	) {
		throw new CosignTransportError('co-sign response members do not match the submitted intents', status);
	}
}

function errorMessageOf(body: unknown, status: number): string {
	const parsed = z.object({ error: z.string().optional(), detail: z.string().optional() }).safeParse(body);
	const error = parsed.success ? parsed.data.error : undefined;
	const detail = parsed.success ? parsed.data.detail : undefined;
	const suffix = [error, detail].filter(Boolean).join(': ');
	return suffix.length > 0
		? `co-sign service answered HTTP ${status} (${suffix})`
		: `co-sign service answered HTTP ${status}`;
}

/** Validate a `/v1/cosign` HTTP response. Separate from the fetch so it can be checked without a network. */
export function parseCosignResponse(status: number, bodyText: string, expected: CosignExpectation): CosignDecision {
	let body: unknown;
	try {
		body = bodyText.length === 0 ? null : JSON.parse(bodyText);
	} catch {
		throw new CosignTransportError(`co-sign service returned non-JSON (HTTP ${status})`, status);
	}

	if (status === 200) {
		const parsed = cosignAllowSchema.safeParse(body);
		if (!parsed.success) {
			throw new CosignTransportError('co-sign approval does not match the contract', status);
		}
		assertBoundToOurBody(parsed.data, expected, status);
		if (parsed.data.members.some((member) => member.verdict !== 'allowed')) {
			throw new CosignTransportError('co-sign approval carries a member that was not allowed', status);
		}
		return { httpStatus: 200, approved: parsed.data };
	}

	if (status === 409) {
		const parsed = cosignDenySchema.safeParse(body);
		if (!parsed.success) {
			throw new CosignTransportError('co-sign denial does not match the contract', status);
		}
		const denial = parsed.data;
		assertBoundToOurBody(denial, expected, status);
		if (denial.denied === MEMBER_DENIED) {
			if (denial.rebuild == null) {
				throw new CosignTransportError('a member denial must carry a rebuild set', status);
			}
			if (denial.rebuild.batchId !== expected.batchId) {
				throw new CosignTransportError('the rebuild set names a different batch', status);
			}
			const submitted = new Set(expected.purchaseIds);
			if (denial.rebuild.keep.some((purchaseId) => !submitted.has(purchaseId))) {
				throw new CosignTransportError('the rebuild set names a purchase we did not submit', status);
			}
			if (!denial.members.some((member) => member.verdict === 'denied')) {
				throw new CosignTransportError('a member denial names no denied member', status);
			}
		} else if (denial.members.some((member) => member.verdict !== 'not_evaluated')) {
			throw new CosignTransportError('a batch-level denial must leave every member unevaluated', status);
		}
		return { httpStatus: 409, denied: denial };
	}

	if (status === 503) {
		const parsed = quorumUnavailableSchema.safeParse(body);
		if (!parsed.success) {
			throw new CosignTransportError('co-sign quorum outage does not match the contract', status);
		}
		return { httpStatus: 503, unavailable: parsed.data };
	}

	const rateLimited = z.object({ retryAfterSec: z.number().int().min(0) }).safeParse(body);
	throw new CosignTransportError(
		errorMessageOf(body, status),
		status,
		rateLimited.success ? rateLimited.data.retryAfterSec : undefined,
	);
}

// ---------------------------------------------------------------- the call

export type CosignCall = {
	/** The frozen transaction. Only its body is sent. */
	unsignedTx: string;
	batchId: string;
	walletUtxoRef: string;
	intents: CosignIntent[];
	context: CosignContext;
};

export async function requestCosign(config: CosignConfig, call: CosignCall): Promise<CosignDecision> {
	const body = decodeCosignBody(call.unsignedTx);
	const request = cosignRequestSchema.parse({
		batchId: call.batchId,
		walletUtxoRef: call.walletUtxoRef,
		intents: call.intents,
		context: call.context,
		txBodyHex: body.txBodyHex,
	});
	const expected: CosignExpectation = {
		txBodyHash: body.txBodyHash,
		requiredSigners: body.requiredSigners,
		batchId: request.batchId,
		purchaseIds: request.intents.map((intent) => intent.purchaseId),
	};

	const baseUrl = assertSafeCosignUrl(config.url, config.trustedPlaintextHosts);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	try {
		const response = await fetch(`${baseUrl}/v1/cosign`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${config.apiKey}`,
				// The batch id IS the idempotency key: the same key with the same
				// body replays the stored decision, the same key with a new body
				// supersedes it and releases its hold.
				'Idempotency-Key': request.batchId,
			},
			body: JSON.stringify(request),
			redirect: 'error',
			signal: controller.signal,
		});
		return parseCosignResponse(response.status, await response.text(), expected);
	} catch (error) {
		if (error instanceof CosignTransportError) throw error;
		// Never echo the credential; the transport message carries only the cause.
		throw new CosignTransportError(
			`could not reach the co-sign service: ${error instanceof Error ? error.message : String(error)}`,
			null,
		);
	} finally {
		clearTimeout(timer);
	}
}

// ---------------------------------------------------------------- witness merge

/**
 * Add the quorum's vkey witnesses to the frozen body.
 *
 * Every signer we declared must return exactly one witness whose key hashes to
 * its key hash and whose signature verifies over the body hash, and no other
 * key may appear — an undeclared witness was never priced into the fee. The
 * body hash is re-checked after each merge, so a witness set can never alter
 * what is signed.
 */
export function mergeCosignWitnesses(
	unsignedTx: string,
	expected: { txHash: string; signerVkhs: string[] },
	witnessSetHex: string,
): string {
	if (resolveTxHash(unsignedTx) !== expected.txHash) {
		throw new Error('the transaction to merge into is not the frozen body');
	}
	const witnesses = TransactionWitnessSet.fromCbor(HexBlob(witnessSetHex)).vkeys()?.values() ?? [];
	const byVkh = new Map<string, string>();
	for (const witness of witnesses) {
		const publicKey = Ed25519PublicKey.fromHex(witness.vkey());
		const vkh = publicKey.hash().hex();
		if (!expected.signerVkhs.includes(vkh)) {
			throw new Error(`the co-signer returned a witness for undeclared key ${vkh}`);
		}
		if (byVkh.has(vkh)) {
			throw new Error(`the co-signer returned two witnesses for key ${vkh}`);
		}
		if (!publicKey.verify(Ed25519Signature.fromHex(witness.signature()), HexBlob(expected.txHash))) {
			throw new Error(`co-signer ${vkh} returned a signature that does not verify over the body hash`);
		}
		byVkh.set(vkh, witness.toCbor());
	}
	for (const vkh of expected.signerVkhs) {
		if (!byVkh.has(vkh)) {
			throw new Error(`co-signer ${vkh} returned no witness`);
		}
	}

	const merged = addVKeyWitnessSetToTransaction(unsignedTx, witnessSetHex);
	if (resolveTxHash(merged) !== expected.txHash) {
		throw new Error('merging the co-signer witnesses changed the transaction body');
	}
	return merged;
}
