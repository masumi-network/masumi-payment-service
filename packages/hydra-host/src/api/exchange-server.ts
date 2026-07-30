/**
 * The Exchange Plane: the one Host surface a counterparty may reach.
 *
 * A separate listener rather than a path on the control plane, because the two
 * have opposite security models and mixing them means one routing mistake
 * exposes fleet management. Nothing here can provision, delete, reconfigure or
 * proxy a node; the entire vocabulary is "redeem an invite I issued" and "leave
 * an invite for my operator".
 *
 * It is unauthenticated by design — the invite is the credential and its
 * authority is a signature. But it is not an open door:
 *
 *  - redemption requires a nonce this Host issued, unspent and unexpired;
 *  - a POSTed invite requires an issuer on the allow-list the payment service
 *    pushed, so a stranger cannot write here at all;
 *  - bodies are capped, and the inbox is bounded.
 *
 * No signature is checked here. That is the payment service's job when it
 * polls, and the division is deliberate: everything this plane can do without
 * cryptography is reversible — a node can be deleted — while everything
 * irreversible waits for a service that holds keys.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ExchangeStore } from '../registry/exchange-store.js';
import { isExchangeMaterial, isExchangeSignature } from '../registry/exchange-types.js';
import type { SupervisorLogger } from '../supervisor/supervisor.js';

/** Smaller than the control plane's: an invite is a few hundred bytes. */
const MAX_BODY_BYTES = 64 * 1024;

export type ExchangeDeps = {
	store: ExchangeStore;
	logger: SupervisorLogger;
	/**
	 * Configure and start the node reserved for this invite.
	 *
	 * Separated from the transport so the plane can be tested without a
	 * supervisor, and so a start failure is recorded rather than thrown at a
	 * counterparty who can do nothing about it.
	 */
	onRedeemed: (nonce: string, hostNodeId: string) => Promise<void>;
};

function send(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
	response.end(JSON.stringify(body ?? null));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = chunk as Buffer;
		size += buffer.length;
		if (size > MAX_BODY_BYTES) {
			throw new Error('request body is too large');
		}
		chunks.push(buffer);
	}
	if (size === 0) {
		return null;
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch {
		throw new Error('request body is not valid JSON');
	}
}

const NONCE_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

type RedeemBody = { nonce: string; redeemer: unknown; signature: unknown };

function readRedeemBody(body: unknown): RedeemBody | null {
	if (typeof body !== 'object' || body === null) {
		return null;
	}
	const candidate = body as Partial<RedeemBody>;
	if (typeof candidate.nonce !== 'string' || !NONCE_PATTERN.test(candidate.nonce)) {
		return null;
	}
	return { nonce: candidate.nonce, redeemer: candidate.redeemer, signature: candidate.signature };
}

type InboundBody = { payload: string; signature: unknown; nonce: string; issuerWalletAddress: string };

function readInboundBody(body: unknown): InboundBody | null {
	if (typeof body !== 'object' || body === null) {
		return null;
	}
	const candidate = body as Partial<InboundBody>;
	if (
		typeof candidate.payload !== 'string' ||
		typeof candidate.nonce !== 'string' ||
		!NONCE_PATTERN.test(candidate.nonce) ||
		typeof candidate.issuerWalletAddress !== 'string' ||
		candidate.issuerWalletAddress.length === 0
	) {
		return null;
	}
	return {
		payload: candidate.payload,
		signature: candidate.signature,
		nonce: candidate.nonce,
		issuerWalletAddress: candidate.issuerWalletAddress,
	};
}

export function createExchangePlane(deps: ExchangeDeps): Server {
	const { store, logger, onRedeemed } = deps;

	return createServer((request, response) => {
		void handle(request, response).catch((error: unknown) => {
			// Never echo the message: this is an unauthenticated surface and the
			// error text can describe internal state.
			logger.error(`[exchange] ${(error as Error).message}`);
			if (!response.headersSent) {
				send(response, 400, { error: 'bad request' });
			}
		});
	});

	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const pathname = new URL(request.url ?? '/', 'http://exchange.invalid').pathname.replace(/\/+$/, '');

		if (request.method !== 'POST') {
			send(response, 405, { error: 'method not allowed' });
			return;
		}

		if (pathname === '/exchange/redeem') {
			await handleRedeem(request, response);
			return;
		}
		if (pathname === '/exchange/invite') {
			await handleInbound(request, response);
			return;
		}

		// Anything else, including every control-plane path, is simply absent
		// here. There is no proxy and no node route to reach.
		send(response, 404, { error: 'not found' });
	}

	async function handleRedeem(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const body = readRedeemBody(await readBody(request));
		if (body === null || !isExchangeMaterial(body.redeemer) || !isExchangeSignature(body.signature)) {
			send(response, 400, { error: 'malformed redemption' });
			return;
		}

		const result = await store.redeem(body.nonce, body.redeemer, body.signature, Date.now());
		if (!result.ok) {
			send(response, result.status, { error: result.reason });
			return;
		}

		// The reply carries nothing the counterparty must trust — everything they
		// need was signed inside the invite — so this is an acknowledgement, and
		// the Host never has to speak for its operator's wallet.
		send(response, 200, { redeemed: true });

		// After answering: the counterparty can neither help nor wait if this
		// fails, and the failure belongs in the operator's poll.
		try {
			await onRedeemed(body.nonce, result.invite.hostNodeId);
		} catch (error) {
			const message = (error as Error).message;
			logger.error(`[exchange] node ${result.invite.hostNodeId} failed to start after redemption: ${message}`);
			await store.recordStartError(body.nonce, message).catch(() => undefined);
		}
	}

	async function handleInbound(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const body = readInboundBody(await readBody(request));
		if (body === null || !isExchangeSignature(body.signature)) {
			send(response, 400, { error: 'malformed invite' });
			return;
		}

		const allowed = await store.allowedIssuers();
		if (!allowed.includes(body.issuerWalletAddress)) {
			// Identical to a malformed body from the caller's side: an unlisted
			// issuer learns nothing about who is listed.
			logger.warn(`[exchange] refused an invite from an unlisted issuer`);
			send(response, 403, { error: 'not accepted from this issuer' });
			return;
		}

		await store.acceptInbound({
			nonce: body.nonce,
			receivedAt: Date.now(),
			payload: body.payload,
			signature: body.signature,
			issuerWalletAddress: body.issuerWalletAddress,
		});
		send(response, 202, { accepted: true });
	}
}
