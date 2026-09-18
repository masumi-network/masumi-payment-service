// Mesh SDK pinning: this file lives in the V2 package and resolves the V2 mesh
// line (`@meshsdk/core-cst@1.9.1`). See docs/adr/0005-meshsdk-version-pinning-v1-v2.md.
//
// Client for the Exchain co-sign service, contract 1.1.1. The types in
// ./cosign-api.d.ts are generated from its openapi.yaml by openapi-typescript.
// The co-signer only ever adds vkey witnesses to a body we froze. It can
// refuse, it can never change what the body spends.
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
import type { components } from './cosign-api';

const DEFAULT_TIMEOUT_MS = 10_000;
const BODY_HASH_PREFIX = 'blake2b_256:';

export type CosignIntent = components['schemas']['Intent'];
export type CosignRequest = components['schemas']['CosignRequest'];
export type CosignAllow = components['schemas']['CosignAllow'];
export type CosignDeny = components['schemas']['CosignDeny'];
export type QuorumUnavailable = components['schemas']['QuorumUnavailable'];
export type WalletRegistration = components['schemas']['WalletRegistration'];
export type WalletRegistered = components['schemas']['WalletRegistered'];
export type ReadToken = components['schemas']['ReadToken'];

export type CosignBodyEcho = { txBodyHash: string; requiredSigners: string[] };

/** The body bytes the co-signer judges, and what its approval must echo back. */
export function freezeCosignBody(unsignedTx: string): CosignBodyEcho & { txBodyHex: string } {
	const body = deserializeTx(unsignedTx).body();
	return {
		txBodyHex: body.toCbor(),
		txBodyHash: resolveTxHash(unsignedTx),
		requiredSigners:
			body
				.requiredSigners()
				?.values()
				.map((hash) => hash.toCore()) ?? [],
	};
}

const allowSchema = z.object({
	decisionId: z.string().min(1),
	txBodyHash: z.string(),
	requiredSigners: z.array(z.string()),
	witnessSetHex: z.string().regex(/^(?:[0-9a-f]{2})+$/),
});
const denySchema = z.object({
	decisionId: z.string().min(1),
	denied: z.string().min(1),
	members: z.array(
		z.object({
			purchaseId: z.string(),
			verdict: z.enum(['allowed', 'denied', 'not_evaluated']),
		}),
	),
	rebuild: z.object({ keep: z.array(z.string()) }).optional(),
	alarm: z.boolean(),
});
const unavailableSchema = z.object({ retryAfterSec: z.number().int().min(0) });

export type CosignConfig = {
	url: string;
	apiKey: string;
	timeoutMs?: number;
	trustedPlaintextHosts?: string[];
};

/** Anything other than an explicit allow, deny or quorum outage. Never a reason to submit, never a denial. */
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

export type CosignDecision =
	| { httpStatus: 200; allow: CosignAllow }
	| { httpStatus: 409; deny: CosignDeny }
	| { httpStatus: 503; unavailable: QuorumUnavailable };

function parseJson(status: number, bodyText: string): unknown {
	try {
		return bodyText.length === 0 ? null : JSON.parse(bodyText);
	} catch {
		throw new CosignTransportError(`co-sign service returned non-JSON (HTTP ${status})`, status);
	}
}

/** Validate a `/v1/cosign` HTTP response. Separate from the fetch so it can be checked without a network. */
export function parseCosignResponse(status: number, bodyText: string, expected: CosignBodyEcho): CosignDecision {
	const body = parseJson(status, bodyText);
	if (status === 200) {
		const parsed = allowSchema.safeParse(body);
		if (!parsed.success) {
			throw new CosignTransportError('co-sign approval does not match the contract', status);
		}
		if (parsed.data.txBodyHash !== `${BODY_HASH_PREFIX}${expected.txBodyHash}`) {
			throw new CosignTransportError('co-sign approval names a different transaction body', status);
		}
		const actualSigners = [...parsed.data.requiredSigners].sort();
		const expectedSigners = [...expected.requiredSigners].sort();
		if (
			actualSigners.length !== expectedSigners.length ||
			new Set(actualSigners).size !== actualSigners.length ||
			actualSigners.some((signer, index) => signer !== expectedSigners[index])
		) {
			throw new CosignTransportError('co-sign approval names different required signers', status);
		}
		return { httpStatus: 200, allow: body as CosignAllow };
	}
	if (status === 409) {
		if (!denySchema.safeParse(body).success) {
			throw new CosignTransportError('co-sign denial does not match the contract', status);
		}
		return { httpStatus: 409, deny: body as CosignDeny };
	}
	if (status === 503) {
		if (!unavailableSchema.safeParse(body).success) {
			throw new CosignTransportError('co-sign outage answer does not match the contract', status);
		}
		return { httpStatus: 503, unavailable: body as QuorumUnavailable };
	}
	throw new CosignTransportError(`co-sign service answered HTTP ${status}`, status);
}

async function post(
	config: CosignConfig,
	path: string,
	init: { body?: unknown; idempotencyKey?: string },
): Promise<{ status: number; text: string }> {
	const baseUrl = assertSafeCosignUrl(config.url, config.trustedPlaintextHosts);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	try {
		const response = await fetch(`${baseUrl}${path}`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${config.apiKey}`,
				...(init.idempotencyKey != null ? { 'Idempotency-Key': init.idempotencyKey } : {}),
			},
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
			redirect: 'error',
			signal: controller.signal,
		});
		return { status: response.status, text: await response.text() };
	} catch (error) {
		// Never echo the credential; the transport message carries only the cause.
		throw new CosignTransportError(
			`could not reach the co-sign service: ${error instanceof Error ? error.message : String(error)}`,
			null,
		);
	} finally {
		clearTimeout(timer);
	}
}

/** `unsignedTx` is the frozen transaction; only its body leaves the host. The `batchId` is the idempotency key. */
export async function requestCosign(
	config: CosignConfig,
	unsignedTx: string,
	request: Omit<CosignRequest, 'txBodyHex'>,
): Promise<CosignDecision> {
	const { txBodyHex, ...expected } = freezeCosignBody(unsignedTx);
	const response = await post(config, '/v1/cosign', {
		body: { ...request, txBodyHex } satisfies CosignRequest,
		idempotencyKey: request.batchId,
	});
	return parseCosignResponse(response.status, response.text, expected);
}

export async function registerCosignWallet(
	config: CosignConfig,
	registration: WalletRegistration,
): Promise<WalletRegistered> {
	const response = await post(config, '/v1/wallets', { body: registration });
	const body = parseJson(response.status, response.text);
	const parsed = z.object({ walletId: z.string().regex(/^wal_[0-9A-HJKMNP-TV-Z]{26}$/) }).safeParse(body);
	if ((response.status !== 200 && response.status !== 201) || !parsed.success) {
		const error = z.object({ error: z.string(), detail: z.string().optional() }).safeParse(body);
		throw new CosignTransportError(
			`co-sign wallet registration answered HTTP ${response.status}${
				error.success ? `: ${error.data.error}${error.data.detail ? ` (${error.data.detail})` : ''}` : ''
			}`,
			response.status,
		);
	}
	return body as WalletRegistered;
}

export async function mintCosignReadToken(config: CosignConfig, exchainWalletId: string): Promise<ReadToken> {
	const response = await post(config, `/v1/wallets/${encodeURIComponent(exchainWalletId)}/read-token`, {});
	const body = parseJson(response.status, response.text);
	const parsed = z.object({ token: z.string().min(1), expiresAt: z.string().min(1) }).safeParse(body);
	if (response.status !== 201 || !parsed.success) {
		throw new CosignTransportError(`co-sign read-token answered HTTP ${response.status}`, response.status);
	}
	return body as ReadToken;
}

/**
 * Add the quorum's vkey witnesses to the frozen body.
 *
 * Every witness must come from a distinct declared quorum key and verify over
 * the body hash, and together they must reach the threshold (a key repeated in
 * `quorumVkhs` weighs as often as it is listed). The body hash is re-checked
 * after the merge, so a witness set can never alter what is signed.
 */
export function mergeCosignWitnesses(
	unsignedTx: string,
	expected: { txHash: string; quorumVkhs: string[]; threshold: number },
	witnessSetHex: string,
): string {
	if (resolveTxHash(unsignedTx) !== expected.txHash) {
		throw new Error('the transaction to merge into is not the frozen body');
	}
	const witnesses = TransactionWitnessSet.fromCbor(HexBlob(witnessSetHex)).vkeys()?.values() ?? [];
	const seen = new Set<string>();
	let weight = 0;
	for (const witness of witnesses) {
		const publicKey = Ed25519PublicKey.fromHex(witness.vkey());
		const vkh = publicKey.hash().hex();
		const listed = expected.quorumVkhs.filter((member) => member === vkh).length;
		if (listed === 0) {
			throw new Error(`co-signer returned a witness for ${vkh}, which is not a quorum key of this wallet`);
		}
		if (seen.has(vkh)) {
			throw new Error(`co-signer returned more than one witness for ${vkh}`);
		}
		if (!publicKey.verify(Ed25519Signature.fromHex(witness.signature()), HexBlob(expected.txHash))) {
			throw new Error(`co-signer ${vkh} returned a signature that does not verify over the body hash`);
		}
		seen.add(vkh);
		weight += listed;
	}
	if (weight < expected.threshold) {
		throw new Error(`co-signer returned ${weight} quorum witness(es); the wallet needs ${expected.threshold}`);
	}
	const tx = addVKeyWitnessSetToTransaction(unsignedTx, witnessSetHex);
	if (resolveTxHash(tx) !== expected.txHash) {
		throw new Error('merging the co-signer witnesses changed the transaction body');
	}
	return tx;
}
