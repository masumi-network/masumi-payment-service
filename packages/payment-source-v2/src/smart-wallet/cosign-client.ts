// Mesh SDK pinning: this file lives in the V2 package and resolves the V2 mesh
// line (`@meshsdk/core-cst@1.9.1`). See docs/adr/0005-meshsdk-version-pinning-v1-v2.md.
//
// Client for an external quorum co-signing service (`POST /v1/cosign`). The
// request/response shape below is Masumi's PROPOSAL for MAS-596 P0 item 1; it
// is not frozen with Exchain yet. The co-signer only ever adds vkey witnesses
// to a body we froze. It can refuse, it can never change what the body spends.
import {
	addVKeyWitnessSetToTransaction,
	Ed25519PublicKey,
	Ed25519Signature,
	HexBlob,
	resolveTxHash,
	TransactionWitnessSet,
} from '@meshsdk/core-cst';
import { z } from '@masumi/payment-core/zod';

const DEFAULT_TIMEOUT_MS = 10_000;
const hex = z.string().regex(/^(?:[0-9a-f]{2})+$/, 'lowercase hex');
const hash28 = z.string().regex(/^[0-9a-f]{56}$/, '28-byte hex');
const hash32 = z.string().regex(/^[0-9a-f]{64}$/, '32-byte hex');
const lovelace = z.string().regex(/^\d+$/, 'integer lovelace string');
const address = z.string().min(1).max(200);

/** Placeholder 12-code denial taxonomy, pending Exchain's frozen list (MAS-596 P0 item 1). */
export const COSIGN_DENIAL_CODES = [
	'POLICY_LIMIT_EXCEEDED',
	'RECIPIENT_NOT_ALLOWED',
	'INTENT_MISMATCH',
	'WALLET_INPUT_UNKNOWN',
	'VALIDITY_TOO_WIDE',
	'SIGNER_NOT_MEMBER',
	'QUORUM_UNAVAILABLE',
	'RESERVATION_CONFLICT',
	'DUPLICATE_REQUEST',
	'FROZEN',
	'RATE_LIMITED',
	'INTERNAL',
] as const;
export type CosignDenialCode = (typeof COSIGN_DENIAL_CODES)[number];

export const cosignRequestSchema = z.object({
	version: z.literal(1),
	network: z.enum(['preprod', 'mainnet']),
	txCbor: hex.max(40_000),
	txHash: hash32,
	wallet: z.object({
		address,
		stateTokenUnit: z.string().regex(/^[0-9a-f]{56}[0-9a-f]{64}$/, 'policy id + 32-byte token name'),
		input: z.object({ txHash: hash32, outputIndex: z.number().int().min(0) }),
	}),
	requiredSigners: z.array(hash28).min(1).max(16),
	intent: z.object({
		kind: z.literal('escrow-lock'),
		/** The key address named as buyer in every escrow datum. */
		buyerAddress: address,
		// Every payee an escrow datum can release funds to is named here, so a
		// co-signer checks the decoded datums against it rather than trusting totals.
		locks: z
			.array(
				z.object({
					address,
					lovelace,
					blockchainIdentifier: hex.max(4_000),
					sellerAddress: address,
					buyerReturnAddress: address.nullable(),
					sellerReturnAddress: address.nullable(),
				}),
			)
			.min(1)
			.max(64),
		outflowLovelace: lovelace,
		changeAddress: address,
		validity: z.object({
			invalidBefore: z.number().int().min(0),
			invalidAfter: z.number().int().min(0),
		}),
		requestedBy: z.string().min(1).max(100),
	}),
	reservationTtlSeconds: z.number().int().min(1).max(3_600),
});
export type CosignRequest = z.infer<typeof cosignRequestSchema>;

export const cosignApprovedSchema = z.object({
	decision: z.literal('approved'),
	txHash: hash32,
	signatures: z.array(z.object({ vkh: hash28, witnessSet: hex.max(2_000) })).min(1),
	expiresAt: z.string().min(1),
});
export type CosignApproved = z.infer<typeof cosignApprovedSchema>;

export const cosignDeniedSchema = z.object({
	decision: z.literal('denied'),
	code: z.enum(COSIGN_DENIAL_CODES),
	message: z.string().max(1_000),
	retryable: z.boolean(),
	/** Per-lock verdicts, so one denied purchase does not have to kill the batch (P0 item 3). */
	locks: z.array(
		z.object({
			index: z.number().int().min(0),
			verdict: z.enum(['allowed', 'denied']),
			code: z.enum(COSIGN_DENIAL_CODES).optional(),
		}),
	),
});
export type CosignDenied = z.infer<typeof cosignDeniedSchema>;

export type CosignConfig = {
	url: string;
	apiKey: string;
	timeoutMs?: number;
	trustedPlaintextHosts?: string[];
};

/** Anything other than an explicit approve or deny. Never a reason to submit, never a denial. */
export class CosignTransportError extends Error {
	constructor(
		message: string,
		readonly status: number | null,
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

export type CosignDecision = { httpStatus: 200; approved: CosignApproved } | { httpStatus: 409; denied: CosignDenied };

/** Validate a `/v1/cosign` HTTP response. Separate from the fetch so it can be checked without a network. */
export function parseCosignResponse(status: number, bodyText: string, expectedTxHash: string): CosignDecision {
	let body: unknown;
	try {
		body = bodyText.length === 0 ? null : JSON.parse(bodyText);
	} catch {
		throw new CosignTransportError(`co-sign service returned non-JSON (HTTP ${status})`, status);
	}
	if (status === 200) {
		const parsed = cosignApprovedSchema.safeParse(body);
		if (!parsed.success) {
			throw new CosignTransportError('co-sign approval does not match the contract', status);
		}
		if (parsed.data.txHash !== expectedTxHash) {
			throw new CosignTransportError('co-sign approval names a different transaction body', status);
		}
		return { httpStatus: 200, approved: parsed.data };
	}
	if (status === 409) {
		const parsed = cosignDeniedSchema.safeParse(body);
		if (!parsed.success) {
			throw new CosignTransportError('co-sign denial does not match the contract', status);
		}
		return { httpStatus: 409, denied: parsed.data };
	}
	throw new CosignTransportError(`co-sign service answered HTTP ${status}`, status);
}

export async function requestCosign(config: CosignConfig, request: CosignRequest): Promise<CosignDecision> {
	const validated = cosignRequestSchema.parse(request);
	const baseUrl = assertSafeCosignUrl(config.url, config.trustedPlaintextHosts);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	try {
		const response = await fetch(`${baseUrl}/v1/cosign`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${config.apiKey}`,
				// Body-derived: a rebuilt body is a new request, a retried timeout is a replay.
				'Idempotency-Key': validated.txHash,
			},
			body: JSON.stringify(validated),
			redirect: 'error',
			signal: controller.signal,
		});
		return parseCosignResponse(response.status, await response.text(), validated.txHash);
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

/**
 * Add the co-signers' vkey witnesses to the frozen body.
 *
 * Every requested signer must return exactly one witness whose key hashes to
 * its vkh and whose signature verifies over the body hash. The body hash is
 * re-checked after each merge, so a witness set can never alter what is signed.
 */
export function mergeCosignWitnesses(
	unsignedTx: string,
	expected: { txHash: string; signerVkhs: string[] },
	signatures: CosignApproved['signatures'],
): string {
	if (resolveTxHash(unsignedTx) !== expected.txHash) {
		throw new Error('the transaction to merge into is not the frozen body');
	}
	let tx = unsignedTx;
	for (const vkh of expected.signerVkhs) {
		const entries = signatures.filter((signature) => signature.vkh === vkh);
		if (entries.length !== 1) {
			throw new Error(`co-signer ${vkh} returned ${entries.length} witness set(s); expected exactly 1`);
		}
		const witnesses = TransactionWitnessSet.fromCbor(HexBlob(entries[0].witnessSet)).vkeys()?.values() ?? [];
		if (witnesses.length !== 1) {
			throw new Error(`co-signer ${vkh} returned ${witnesses.length} vkey witnesses; expected exactly 1`);
		}
		const publicKey = Ed25519PublicKey.fromHex(witnesses[0].vkey());
		if (publicKey.hash().hex() !== vkh) {
			throw new Error(`co-signer ${vkh} returned a witness for a different key`);
		}
		if (!publicKey.verify(Ed25519Signature.fromHex(witnesses[0].signature()), HexBlob(expected.txHash))) {
			throw new Error(`co-signer ${vkh} returned a signature that does not verify over the body hash`);
		}
		tx = addVKeyWitnessSetToTransaction(tx, entries[0].witnessSet);
		if (resolveTxHash(tx) !== expected.txHash) {
			throw new Error('merging a co-signer witness changed the transaction body');
		}
	}
	return tx;
}
