// Mock of Exchain's `POST /v1/cosign` for the MAS-596 demo, speaking contract
// 1.1 (https://cosign-preprod.exchain.network/openapi.yaml). It holds the
// quorum member keys, checks the frozen body against the declared intents
// (cosign-policy.ts), and signs or names exactly which members were refused. It
// never builds, changes or submits a transaction.
//
// `GET /` renders the decision feed; it is the iframe stand-in for the hosted
// dashboard. Binds to 127.0.0.1 only.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
	deserializeDatum,
	MeshWallet,
	resolvePaymentKeyHash,
	SLOT_CONFIG_NETWORK,
	slotToBeginUnixTime,
} from '@meshsdk/core';
import {
	addVKeyWitnessSetToTransaction,
	deserializeTx,
	HexBlob,
	resolveTxHash,
	TransactionWitnessSet,
} from '@meshsdk/core-cst';
import { logger } from '@masumi/payment-core/logger';
import { SmartContractState } from '@masumi/payment-core/smart-contract-state';
import { decodeV2ContractDatum } from '@/utils/converter/string-datum-convert';
import {
	cosignRequestSchema,
	withDigestPrefix,
	type CosignAllow,
	type CosignDeny,
	type CosignMemberVerdict,
	type CosignRequest,
	type QuorumUnavailable,
} from '../../src/smart-wallet/cosign-client';
import {
	verifyIntentAgainstBody,
	type CosignPolicy,
	type DecodedEscrowLock,
	type DecodedTxBody,
	type TxRef,
} from './cosign-policy';

const MAX_BODY_BYTES = 1_000_000;
const FEED_SIZE = 100;
const REBUILD_HOLD_MS = 120_000;
const NETWORK = 'preprod' as const;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export type MockCosignOptions = {
	memberMnemonics: string[];
	apiKey: string;
	threshold: number;
	maxOutflowLovelace: bigint;
	maxPerIntentLovelace: bigint;
	maxValiditySlots: number;
	/** From registration: hot keys allowed to spend, and the escrow addresses they may pay. */
	agentVkhs: string[];
	escrowAddresses: string[];
	resolveWalletInput: (ref: TxRef) => Promise<{ address: string; lovelace: bigint }>;
	decisionsFile: string;
	port: number;
};

export type MockCosignServer = { url: string; memberVkhs: string[]; close: () => Promise<void> };

type DecisionRecord = {
	at: string;
	decisionId: string;
	batchId: string;
	txBodyHash: string;
	outcome: 'allowed' | 'denied' | 'security';
	denied: string | null;
	walletUtxoRef: string;
	intents: number;
	admitted: number;
	deniedPurchaseIds: string[];
	outflowLovelace: string;
};

/** Every JSON body the contract carries, including the plain error shapes. */
type Envelope = { asOf: string; schemaVersion: string; chainTip: null };
type ErrorBody = Envelope & { error: string; detail?: string; retryAfterSec?: number };
type ReplyBody = CosignAllow | CosignDeny | QuorumUnavailable | ErrorBody;
type Reply = { status: number; body: ReplyBody };

export async function memberVkhOf(mnemonic: string): Promise<string> {
	const wallet = new MeshWallet({ networkId: 0, key: { type: 'mnemonic', words: mnemonic.split(' ') } });
	return resolvePaymentKeyHash((await wallet.getUnusedAddresses())[0]);
}

function ulid(prefix: string): string {
	let out = '';
	for (const byte of randomBytes(26)) out += CROCKFORD[byte % CROCKFORD.length];
	return `${prefix}${out}`;
}

/**
 * The request carries the BODY only. Wrapping it as `[body, {}, true, null]`
 * yields a transaction whose hash is `blake2b_256(body)` — the same hash the
 * node froze — so one decoding path serves both inspection and signing.
 */
function wrapBody(txBodyHex: string): string {
	return `84${txBodyHex}a0f5f6`;
}

/** Decode an output's inline datum as a V2 escrow datum with the repo's own decoder; null for anything else. */
function decodeEscrowLock(inlineDatumCbor: string | undefined, address: string): DecodedEscrowLock | null {
	if (inlineDatumCbor == null) return null;
	try {
		const decoded = decodeV2ContractDatum(deserializeDatum(inlineDatumCbor), NETWORK, address);
		if (decoded == null) return null;
		return {
			blockchainIdentifier: decoded.blockchainIdentifier,
			buyerPaymentKeyHash: paymentKeyHashOf(decoded.buyerAddress),
			sellerPaymentKeyHash: paymentKeyHashOf(decoded.sellerAddress),
			fundsLocked: decoded.state === SmartContractState.FundsLocked,
		};
	} catch {
		return null;
	}
}

/** Null for a script address or anything unparseable — the caller treats that as "not a key payee". */
function paymentKeyHashOf(address: string): string | null {
	try {
		return resolvePaymentKeyHash(address);
	} catch {
		return null;
	}
}

function decodeTxBody(txBodyHex: string): DecodedTxBody {
	const body = deserializeTx(wrapBody(txBodyHex)).body();
	const start = body.validityStartInterval();
	const ttl = body.ttl();
	return {
		inputs: body
			.inputs()
			.values()
			.map((input) => ({ txHash: input.transactionId(), outputIndex: Number(input.index()) })),
		outputs: body.outputs().map((output) => {
			const address = output.address().toBech32();
			const value = output.amount();
			return {
				address,
				lovelace: value.coin(),
				hasOtherAssets: (value.multiasset()?.size ?? 0) > 0,
				paymentKeyHash: paymentKeyHashOf(address),
				lock: decodeEscrowLock(output.datum()?.asInlineData()?.toCbor(), address),
			};
		}),
		requiredSigners:
			body
				.requiredSigners()
				?.values()
				.map((hash) => hash.toCore()) ?? [],
		validityStart: start == null ? null : Number(start),
		ttl: ttl == null ? null : Number(ttl),
	};
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function readFeed(decisionsFile: string): DecisionRecord[] {
	if (!fs.existsSync(decisionsFile)) return [];
	return fs
		.readFileSync(decisionsFile, 'utf8')
		.split('\n')
		.filter((line) => line.trim().length > 0)
		.slice(-FEED_SIZE)
		.map((line) => JSON.parse(line) as DecisionRecord)
		.reverse();
}

function renderFeed(records: DecisionRecord[]): string {
	const rows = records
		.map(
			(record) => `<tr class="${record.outcome}">
	<td>${escapeHtml(record.at)}</td>
	<td><strong>${escapeHtml(record.outcome)}</strong>${record.denied ? `<br><code>${escapeHtml(record.denied)}</code>` : ''}</td>
	<td class="hash"><code title="${escapeHtml(record.txBodyHash)}">${escapeHtml(record.txBodyHash)}</code></td>
	<td>${record.admitted} / ${record.intents}</td>
	<td>${escapeHtml((Number(BigInt(record.outflowLovelace)) / 1e6).toFixed(2))} tADA</td>
	<td>${record.deniedPurchaseIds.length > 0 ? escapeHtml(record.deniedPurchaseIds.join(', ')) : '—'}</td>
</tr>`,
		)
		.join('\n');
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Co-sign decisions (mock)</title>
<meta http-equiv="refresh" content="10">
<style>
body{font:14px/1.4 system-ui,sans-serif;margin:16px;color:#1f2937;background:#fff}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top}
tr.allowed td:nth-child(2){color:#047857}tr.denied td:nth-child(2){color:#b91c1c}tr.security td:nth-child(2){color:#7c2d12;font-weight:700}
p{color:#6b7280}
/* The cell holds the FULL hash and only clips it visually, so copying yields
   every character. user-select:all makes one click select the whole value. */
td.hash code{display:inline-block;max-width:18ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom;-webkit-user-select:all;user-select:all;cursor:text}
</style></head><body>
<h1>Quorum co-sign decisions</h1>
<p>Mock co-signer for the MAS-596 demo, speaking contract 1.1. Refreshes every 10 s. Each row is one frozen transaction body. Click a body hash to select all of it.</p>
<table><thead><tr><th>Time</th><th>Decision</th><th>Body hash</th><th>Admitted</th><th>Wallet outflow</th><th>Denied purchases</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6">No decisions yet.</td></tr>'}</tbody></table>
</body></html>`;
}

function sameSecret(presented: string | undefined, expected: string): boolean {
	if (presented == null) return false;
	const a = createHash('sha256').update(presented).digest();
	const b = createHash('sha256').update(`Bearer ${expected}`).digest();
	return timingSafeEqual(a, b);
}

async function readBody(request: http.IncomingMessage): Promise<string | null> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		size += buffer.length;
		if (size > MAX_BODY_BYTES) return null;
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString('utf8');
}

export async function startMockCosignServer(options: MockCosignOptions): Promise<MockCosignServer> {
	const members = await Promise.all(
		options.memberMnemonics.map(async (mnemonic, index) => ({
			id: `mock-member-${index + 1}`,
			vkh: await memberVkhOf(mnemonic),
			wallet: new MeshWallet({ networkId: 0, key: { type: 'mnemonic', words: mnemonic.split(' ') } }),
		})),
	);
	const policy: CosignPolicy = {
		memberVkhs: members.map((member) => member.vkh),
		threshold: options.threshold,
		maxOutflowLovelace: options.maxOutflowLovelace,
		maxPerIntentLovelace: options.maxPerIntentLovelace,
		maxValiditySlots: options.maxValiditySlots,
		agentVkhs: options.agentVkhs,
		escrowAddresses: options.escrowAddresses,
	};
	/** Idempotency: one stored answer per batch id, superseded when the body changes. */
	const replies = new Map<string, { txBodyHash: string; reply: Reply }>();
	const reservations = new Map<string, { batchId: string; expiresAt: number }>();
	let baseUrl = '';

	const envelope = (): Envelope => ({ asOf: new Date().toISOString(), schemaVersion: '1.1', chainTip: null });

	const record = (request: CosignRequest, decisionId: string, txBodyHash: string, reply: CosignAllow | CosignDeny) => {
		const denied = 'denied' in reply ? reply.denied : null;
		const members_: CosignMemberVerdict[] = reply.members;
		const alarm = 'alarm' in reply ? reply.alarm : false;
		const entry: DecisionRecord = {
			at: new Date().toISOString(),
			decisionId,
			batchId: request.batchId,
			txBodyHash,
			outcome: denied == null ? 'allowed' : alarm ? 'security' : 'denied',
			denied,
			walletUtxoRef: request.walletUtxoRef,
			intents: request.intents.length,
			admitted: members_.filter((member) => member.verdict === 'allowed').length,
			deniedPurchaseIds: members_.filter((member) => member.verdict === 'denied').map((member) => member.purchaseId),
			outflowLovelace: request.intents.reduce((sum, intent) => sum + BigInt(intent.amount), 0n).toString(),
		};
		fs.appendFileSync(options.decisionsFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
		logger.info('mock co-sign decision', { decisionId, outcome: entry.outcome, denied });
	};

	const notEvaluated = (request: CosignRequest): CosignMemberVerdict[] =>
		request.intents.map((intent) => ({
			purchaseId: intent.purchaseId,
			outputIndex: intent.outputIndex,
			verdict: 'not_evaluated' as const,
		}));

	const decide = async (request: CosignRequest, txBodyHash: string): Promise<Reply> => {
		const decisionId = ulid('dec_');
		const journalRef = `${baseUrl}/decisions/${decisionId}`;
		let body: DecodedTxBody;
		try {
			body = decodeTxBody(request.txBodyHex);
		} catch {
			return {
				status: 400,
				body: { ...envelope(), error: 'bad_request', detail: 'txBodyHex does not decode as a transaction body' },
			};
		}
		const alarmCodes = new Set(['body_mismatch', 'payee_unpinned', 'clock_skew']);
		const denyBatch = (code: string, reasonEnglish: string, detail?: string): Reply => {
			const deny: CosignDeny = {
				...envelope(),
				decisionId,
				txBodyHash: withDigestPrefix(txBodyHash),
				requiredSigners: body.requiredSigners,
				denied: code as CosignDeny['denied'],
				reasonEnglish,
				...(detail == null ? {} : { detail }),
				members: notEvaluated(request),
				alarm: alarmCodes.has(code),
				journalRef,
			};
			record(request, decisionId, txBodyHash, deny);
			return { status: 409, body: deny };
		};

		let walletInput: { address: string; lovelace: bigint };
		try {
			walletInput = await options.resolveWalletInput({
				txHash: request.walletUtxoRef.split('#')[0],
				outputIndex: Number(request.walletUtxoRef.split('#')[1]),
			});
		} catch {
			return denyBatch('utxo_unknown', 'The wallet input could not be resolved on chain.', 'stale_ref');
		}

		const outcome = verifyIntentAgainstBody({ request, body, walletInput, policy, nowMs: Date.now() });
		if (outcome.kind === 'batch-denied') {
			return denyBatch(outcome.code, outcome.reasonEnglish, outcome.detail);
		}

		// A validity upper bound that is absent, unreadable or already past can
		// never produce a submittable transaction.
		const expiresAt = body.ttl == null ? NaN : slotToBeginUnixTime(body.ttl, SLOT_CONFIG_NETWORK[NETWORK]);
		if (!Number.isSafeInteger(body.ttl) || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
			return denyBatch('clock_skew', 'The decoded validity upper bound must be finite and in the future.');
		}

		if (outcome.kind === 'member-denied') {
			const deny: CosignDeny = {
				...envelope(),
				decisionId,
				txBodyHash: withDigestPrefix(txBodyHash),
				requiredSigners: body.requiredSigners,
				denied: 'member_denied',
				members: outcome.members,
				rebuild: {
					keep: outcome.keep,
					batchId: request.batchId,
					heldUntil: new Date(Date.now() + REBUILD_HOLD_MS).toISOString(),
				},
				alarm: false,
				journalRef,
			};
			record(request, decisionId, txBodyHash, deny);
			return { status: 409, body: deny };
		}

		const reservation = reservations.get(request.walletUtxoRef);
		if (reservation != null && reservation.batchId !== request.batchId && reservation.expiresAt > Date.now()) {
			return denyBatch(
				'reservation_conflict',
				'Another signed body holds this wallet input until its validity interval closes.',
			);
		}
		// Reserve synchronously after resolution and before any signer runs. Keep
		// the hold if signing fails: an earlier member may already have signed,
		// and a request cannot shorten the validity of an existing signature.
		reservations.set(request.walletUtxoRef, { batchId: request.batchId, expiresAt });

		const signing = members.filter((member) => body.requiredSigners.includes(member.vkh));
		const dummyTx = wrapBody(request.txBodyHex);
		let merged = dummyTx;
		const witnesses: CosignAllow['witnesses'] = [];
		for (const member of signing) {
			const witnessSet = await member.wallet.signTx(dummyTx, true, false);
			const vkey = TransactionWitnessSet.fromCbor(HexBlob(witnessSet)).vkeys()?.values()[0];
			if (vkey == null) throw new Error(`member ${member.id} produced no vkey witness`);
			witnesses.push({ member: member.id, vkeyHex: vkey.vkey(), signatureHex: vkey.signature() });
			merged = addVKeyWitnessSetToTransaction(merged, witnessSet);
		}

		const allow: CosignAllow = {
			...envelope(),
			decisionId,
			txBodyHash: withDigestPrefix(txBodyHash),
			requiredSigners: body.requiredSigners,
			quorumMembers: signing.map((member) => member.id),
			witnessSetHex: deserializeTx(merged).witnessSet().toCbor(),
			witnesses,
			members: outcome.members,
			boundsRemaining: boundsAfter(request, policy),
			journalRef,
		};
		record(request, decisionId, txBodyHash, allow);
		return { status: 200, body: allow };
	};

	const handle = async (request: http.IncomingMessage, response: http.ServerResponse) => {
		const send = (status: number, payload: ReplyBody) =>
			response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
		const path = (request.url ?? '/').split('?')[0];
		// HEAD included: Node drops the body for it, and probes use it.
		if ((request.method === 'GET' || request.method === 'HEAD') && path === '/') {
			response
				.writeHead(200, {
					'Content-Type': 'text/html; charset=utf-8',
					'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
				})
				.end(renderFeed(readFeed(options.decisionsFile)));
			return;
		}
		if (request.method !== 'POST' || path !== '/v1/cosign') {
			send(404, { ...envelope(), error: 'not_found' });
			return;
		}
		if (!sameSecret(request.headers.authorization, options.apiKey)) {
			send(401, { ...envelope(), error: 'unauthorized' });
			return;
		}
		const raw = await readBody(request);
		if (raw == null) {
			send(413, { ...envelope(), error: 'payload_too_large' });
			return;
		}
		let json: unknown;
		try {
			json = JSON.parse(raw);
		} catch {
			send(400, { ...envelope(), error: 'bad_request', detail: 'request body is not JSON' });
			return;
		}
		const parsed = cosignRequestSchema.safeParse(json);
		if (!parsed.success) {
			send(400, { ...envelope(), error: 'bad_request', detail: 'request does not match the /v1/cosign contract' });
			return;
		}
		if (request.headers['idempotency-key'] !== parsed.data.batchId) {
			send(400, { ...envelope(), error: 'bad_request', detail: 'Idempotency-Key must equal batchId' });
			return;
		}
		let txBodyHash: string;
		try {
			txBodyHash = resolveTxHash(wrapBody(parsed.data.txBodyHex));
		} catch {
			send(400, { ...envelope(), error: 'bad_request', detail: 'txBodyHex does not decode as a transaction body' });
			return;
		}

		// Same batch id and same body replays the stored answer; same batch id
		// and a new body supersedes the earlier decision and releases its hold.
		const stored = replies.get(parsed.data.batchId);
		if (stored != null) {
			if (stored.txBodyHash === txBodyHash) {
				send(stored.reply.status, stored.reply.body);
				return;
			}
			replies.delete(parsed.data.batchId);
			for (const [ref, reservation] of reservations) {
				if (reservation.batchId === parsed.data.batchId) reservations.delete(ref);
			}
		}

		const reply = await decide(parsed.data, txBodyHash);
		if (reply.status === 200 || reply.status === 409) {
			replies.set(parsed.data.batchId, { txBodyHash, reply });
		}
		send(reply.status, reply.body);
	};

	const server = http.createServer((request, response) => {
		handle(request, response).catch((error: unknown) => {
			logger.error('mock co-sign request failed', { error: error instanceof Error ? error.message : String(error) });
			if (!response.headersSent) {
				response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'internal' }));
			}
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(options.port, '127.0.0.1', () => resolve());
	});
	const { port } = server.address() as AddressInfo;
	baseUrl = `http://127.0.0.1:${port}`;
	return {
		url: baseUrl,
		memberVkhs: policy.memberVkhs,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}

/** Remaining room under each mock rule after this batch, in the contract's shape. */
function boundsAfter(request: CosignRequest, policy: CosignPolicy): CosignAllow['boundsRemaining'] {
	const used = request.intents.reduce((sum, intent) => sum + BigInt(intent.amount), 0n);
	const remaining = policy.maxOutflowLovelace > used ? policy.maxOutflowLovelace - used : 0n;
	const largest = request.intents.reduce(
		(max, intent) => (BigInt(intent.amount) > max ? BigInt(intent.amount) : max),
		0n,
	);
	return {
		per_tx_cap: {
			limit: policy.maxPerIntentLovelace.toString(),
			used: largest.toString(),
			remaining: (policy.maxPerIntentLovelace > largest ? policy.maxPerIntentLovelace - largest : 0n).toString(),
		},
		hourly_outflow: {
			limit: policy.maxOutflowLovelace.toString(),
			used: used.toString(),
			remaining: remaining.toString(),
			windowResetsAt: new Date(Date.now() + 3_600_000).toISOString(),
		},
	};
}
