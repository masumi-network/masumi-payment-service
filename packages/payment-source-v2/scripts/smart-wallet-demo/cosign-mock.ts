// Mock of Exchain's `POST /v1/cosign` for the MAS-596 demo, speaking the
// shape proposed in ./cosign-proposal-client.ts. It holds the quorum
// member keys, checks the frozen body against the intent (cosign-policy.ts),
// and signs or refuses. It never builds, changes or submits a transaction.
//
// `GET /` renders the decision feed; it is the iframe stand-in until Exchain's
// hosted dashboard (X-08) exists. Binds to 127.0.0.1 only.
import { createHash, timingSafeEqual } from 'node:crypto';
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
import { deserializeTx, resolveTxHash } from '@meshsdk/core-cst';
import { logger } from '@masumi/payment-core/logger';
import { SmartContractState } from '@masumi/payment-core/smart-contract-state';
import { decodeV2ContractDatum } from '@/utils/converter/string-datum-convert';
import {
	cosignRequestSchema,
	decodeCosignBodyEcho,
	type CosignApproved,
	type CosignDenied,
	type CosignRequest,
} from './cosign-proposal-client';
import {
	verifyIntentAgainstBody,
	type CosignPolicy,
	type DecodedEscrowLock,
	type DecodedTxBody,
	type TxRef,
} from './cosign-policy';

const MAX_BODY_BYTES = 1_000_000;
const FEED_SIZE = 100;

export type MockCosignOptions = {
	memberMnemonics: string[];
	apiKey: string;
	threshold: number;
	maxOutflowLovelace: bigint;
	maxValiditySlots: number;
	resolveInputLovelace: (ref: TxRef) => Promise<bigint>;
	decisionsFile: string;
	port: number;
};

export type MockCosignServer = { url: string; memberVkhs: string[]; close: () => Promise<void> };

type DecisionRecord = {
	at: string;
	txHash: string;
	decision: 'approved' | 'denied';
	code: string | null;
	walletInput: string;
	locks: number;
	outflowLovelace: string;
	deniedLocks: number[];
};

type Reply = { status: number; body: CosignApproved | CosignDenied | { error: string } };

export async function memberVkhOf(mnemonic: string): Promise<string> {
	const wallet = new MeshWallet({ networkId: 0, key: { type: 'mnemonic', words: mnemonic.split(' ') } });
	return resolvePaymentKeyHash((await wallet.getUnusedAddresses())[0]);
}

/** Decode an output's inline datum as a V2 escrow datum with the repo's own decoder; null for anything else. */
function decodeEscrowLock(
	inlineDatumCbor: string | undefined,
	address: string,
	network: CosignRequest['network'],
): DecodedEscrowLock | null {
	if (inlineDatumCbor == null) return null;
	try {
		const decoded = decodeV2ContractDatum(deserializeDatum(inlineDatumCbor), network, address);
		if (decoded == null) return null;
		return {
			blockchainIdentifier: decoded.blockchainIdentifier,
			buyerAddress: decoded.buyerAddress,
			buyerReturnAddress: decoded.buyerReturnAddress ?? null,
			sellerAddress: decoded.sellerAddress,
			sellerReturnAddress: decoded.sellerReturnAddress ?? null,
			fundsLocked: decoded.state === SmartContractState.FundsLocked,
		};
	} catch {
		return null;
	}
}

function decodeTxBody(txCbor: string, network: CosignRequest['network']): DecodedTxBody {
	const body = deserializeTx(txCbor).body();
	const start = body.validityStartInterval();
	const ttl = body.ttl();
	return {
		inputs: body
			.inputs()
			.values()
			.map((input) => ({ txHash: input.transactionId(), outputIndex: Number(input.index()) })),
		outputs: body.outputs().map((output) => {
			const address = output.address().toBech32();
			return {
				address,
				lovelace: output.amount().coin(),
				lock: decodeEscrowLock(output.datum()?.asInlineData()?.toCbor(), address, network),
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
			(record) => `<tr class="${record.decision}">
	<td>${escapeHtml(record.at)}</td>
	<td><strong>${escapeHtml(record.decision)}</strong>${record.code ? `<br><code>${escapeHtml(record.code)}</code>` : ''}</td>
	<td class="hash"><code title="${escapeHtml(record.txHash)}">${escapeHtml(record.txHash)}</code></td>
	<td>${record.locks}</td>
	<td>${escapeHtml((Number(BigInt(record.outflowLovelace)) / 1e6).toFixed(2))} tADA</td>
	<td>${record.deniedLocks.length > 0 ? escapeHtml(record.deniedLocks.join(', ')) : '—'}</td>
</tr>`,
		)
		.join('\n');
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Co-sign decisions (mock)</title>
<meta http-equiv="refresh" content="10">
<style>
body{font:14px/1.4 system-ui,sans-serif;margin:16px;color:#1f2937;background:#fff}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top}
tr.approved td:nth-child(2){color:#047857}tr.denied td:nth-child(2){color:#b91c1c}
p{color:#6b7280}
/* The cell holds the FULL 32-byte hash and only clips it visually, so copying
   yields all 64 characters. user-select:all makes one click select the whole
   value. The earlier version put a 16-character prefix in the DOM, so a copy
   silently produced a truncated hash that matches nothing on an explorer. */
td.hash code{display:inline-block;max-width:18ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom;-webkit-user-select:all;user-select:all;cursor:text}
</style></head><body>
<h1>Quorum co-sign decisions</h1>
<p>Mock co-signer for the MAS-596 demo. Refreshes every 10 s. Each row is one frozen transaction body. Click a body hash to select all 64 characters.</p>
<table><thead><tr><th>Time</th><th>Decision</th><th>Body hash</th><th>Locks</th><th>Wallet outflow</th><th>Denied locks</th></tr></thead>
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
		options.memberMnemonics.map(async (mnemonic) => ({
			vkh: await memberVkhOf(mnemonic),
			wallet: new MeshWallet({ networkId: 0, key: { type: 'mnemonic', words: mnemonic.split(' ') } }),
		})),
	);
	const policy: CosignPolicy = {
		memberVkhs: members.map((member) => member.vkh),
		threshold: options.threshold,
		maxOutflowLovelace: options.maxOutflowLovelace,
		maxValiditySlots: options.maxValiditySlots,
	};
	const replies = new Map<string, Reply>();
	const reservations = new Map<string, { txHash: string; expiresAt: number }>();

	const record = (request: CosignRequest, reply: CosignApproved | CosignDenied) => {
		const entry: DecisionRecord = {
			at: new Date().toISOString(),
			txHash: request.txHash,
			decision: reply.decision,
			code: reply.decision === 'denied' ? reply.code : null,
			walletInput: `${request.wallet.input.txHash}#${request.wallet.input.outputIndex}`,
			locks: request.intent.locks.length,
			outflowLovelace: request.intent.outflowLovelace,
			deniedLocks:
				reply.decision === 'denied'
					? reply.locks.filter((lock) => lock.verdict === 'denied').map((lock) => lock.index)
					: [],
		};
		fs.appendFileSync(options.decisionsFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
		logger.info('mock co-sign decision', { txHash: entry.txHash, decision: entry.decision, code: entry.code });
	};

	const decide = async (request: CosignRequest): Promise<Reply> => {
		let body: DecodedTxBody;
		let recomputedTxHash: string;
		try {
			body = decodeTxBody(request.txCbor, request.network);
			recomputedTxHash = resolveTxHash(request.txCbor);
		} catch {
			return { status: 400, body: { error: 'txCbor does not decode as a transaction' } };
		}
		const walletInputKey = `${request.wallet.input.txHash}#${request.wallet.input.outputIndex}`;
		let walletInputLovelace: bigint;
		try {
			walletInputLovelace = await options.resolveInputLovelace(request.wallet.input);
		} catch {
			const denial: CosignDenied = {
				decision: 'denied',
				code: 'WALLET_INPUT_UNKNOWN',
				message: 'the wallet input could not be resolved on chain',
				retryable: true,
				locks: [],
			};
			record(request, denial);
			return { status: 409, body: denial };
		}
		const verdict = verifyIntentAgainstBody({ request, body, recomputedTxHash, walletInputLovelace, policy });
		if (!verdict.ok) {
			record(request, verdict.denial);
			return { status: 409, body: verdict.denial };
		}
		const expiresAt = body.ttl == null ? NaN : slotToBeginUnixTime(body.ttl, SLOT_CONFIG_NETWORK[request.network]);
		if (!Number.isSafeInteger(body.ttl) || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
			const denial: CosignDenied = {
				decision: 'denied',
				code: 'VALIDITY_TOO_WIDE',
				message: 'the decoded validity upper bound must be finite and in the future',
				retryable: false,
				locks: [],
			};
			record(request, denial);
			return { status: 409, body: denial };
		}
		const reservation = reservations.get(walletInputKey);
		if (reservation != null && reservation.txHash !== request.txHash && reservation.expiresAt > Date.now()) {
			const denial: CosignDenied = {
				decision: 'denied',
				code: 'RESERVATION_CONFLICT',
				message: 'another approved body holds this wallet input until its validity interval closes',
				retryable: true,
				locks: [],
			};
			record(request, denial);
			return { status: 409, body: denial };
		}
		// Reserve synchronously after input resolution and before any signer runs.
		// Keep the hold if signing fails: an earlier member may already have signed.
		// The request TTL cannot shorten the validity of an existing signature.
		reservations.set(walletInputKey, { txHash: recomputedTxHash, expiresAt });
		const signers = request.requiredSigners.map((vkh) => members.find((member) => member.vkh === vkh));
		const signatures: CosignApproved['signatures'] = [];
		for (const signer of signers) {
			if (signer == null) throw new Error('verified signer is missing from the member set');
			signatures.push({ vkh: signer.vkh, witnessSet: await signer.wallet.signTx(request.txCbor, true, false) });
		}
		const approval: CosignApproved = {
			decision: 'approved',
			txHash: request.txHash,
			signatures,
			expiresAt: new Date(expiresAt).toISOString(),
		};
		record(request, approval);
		return { status: 200, body: approval };
	};

	const handle = async (request: http.IncomingMessage, response: http.ServerResponse) => {
		let bodyEcho: ReturnType<typeof decodeCosignBodyEcho> | undefined;
		const send = (status: number, payload: Reply['body']) => {
			const result = status === 200 || status === 409 ? { ...payload, ...bodyEcho } : payload;
			response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
		};
		const path = (request.url ?? '/').split('?')[0];
		// HEAD included: Node drops the body for it, and probes/link checkers use it.
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
			send(404, { error: 'not found' });
			return;
		}
		if (!sameSecret(request.headers.authorization, options.apiKey)) {
			send(401, { error: 'unauthorized' });
			return;
		}
		const raw = await readBody(request);
		if (raw == null) {
			send(413, { error: 'request body too large' });
			return;
		}
		let json: unknown;
		try {
			json = JSON.parse(raw);
		} catch {
			send(400, { error: 'request body is not JSON' });
			return;
		}
		const parsed = cosignRequestSchema.safeParse(json);
		if (!parsed.success) {
			send(400, { error: 'request does not match the /v1/cosign contract' });
			return;
		}
		if (request.headers['idempotency-key'] !== parsed.data.txHash) {
			send(400, { error: 'Idempotency-Key must equal txHash' });
			return;
		}
		try {
			bodyEcho = decodeCosignBodyEcho(parsed.data.txCbor);
		} catch {
			send(400, { error: 'txCbor does not decode as a transaction' });
			return;
		}
		if (bodyEcho.txBodyHash !== parsed.data.txHash) {
			send(400, { error: 'txHash does not match txCbor' });
			return;
		}
		const cached = replies.get(parsed.data.txHash);
		if (cached != null) {
			send(cached.status, cached.body);
			return;
		}
		const reply = await decide(parsed.data);
		if (reply.status === 200 || reply.status === 409) {
			replies.set(parsed.data.txHash, reply);
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
	return {
		url: `http://127.0.0.1:${port}`,
		memberVkhs: policy.memberVkhs,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}
