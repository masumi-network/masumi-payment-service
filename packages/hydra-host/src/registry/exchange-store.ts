/**
 * Durable state for the Exchange Plane.
 *
 * Three things live here, all on the persistence volume because all three
 * survive a restart by necessity:
 *
 *  - invites this Host will honour, and whether each has been redeemed. A
 *    redemption that were forgotten would let the same nonce open a second
 *    head, which is the one thing single-use is meant to prevent;
 *  - invites that arrived from counterparties, waiting for the operator;
 *  - the wallet addresses allowed to POST an invite here at all.
 *
 * Writes are serialised through one queue rather than per-key. The exchange is
 * a low-rate path — a handful of invites per operator per day — and a single
 * queue makes "check then redeem" atomic without a lock per nonce.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write.js';
import { isPlainObject } from './json.js';
import type { ExchangeMaterial, ExchangeSignature, InboundInviteRecord, InviteRecord } from './exchange-types.js';

const EXCHANGE_FILE = 'exchange.json';

/** Bounds the inbox so an allow-listed but misbehaving peer cannot fill the volume. */
export const MAX_INBOUND_INVITES = 256;

export class ExchangeStoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ExchangeStoreError';
	}
}

type ExchangeState = {
	invites: InviteRecord[];
	inbound: InboundInviteRecord[];
	/** Wallet addresses whose POSTed invites are accepted. */
	allowedIssuers: string[];
};

function emptyState(): ExchangeState {
	return { invites: [], inbound: [], allowedIssuers: [] };
}

function parseState(raw: string): ExchangeState {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new ExchangeStoreError('exchange.json is not valid JSON; the exchange log may be damaged');
	}
	if (!isPlainObject(parsed)) {
		throw new ExchangeStoreError('exchange.json does not contain an exchange state');
	}
	const state = parsed as unknown as Partial<ExchangeState>;
	return {
		invites: Array.isArray(state.invites) ? state.invites : [],
		inbound: Array.isArray(state.inbound) ? state.inbound : [],
		allowedIssuers: Array.isArray(state.allowedIssuers) ? state.allowedIssuers : [],
	};
}

export class ExchangeStore {
	private readonly file: string;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(dataDir: string) {
		this.file = path.join(dataDir, EXCHANGE_FILE);
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const next = this.queue.then(task, task);
		this.queue = next.catch(() => undefined);
		return next;
	}

	private async read(): Promise<ExchangeState> {
		try {
			return parseState(await fs.readFile(this.file, 'utf8'));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return emptyState();
			}
			throw error;
		}
	}

	private async write(state: ExchangeState): Promise<void> {
		await fs.mkdir(path.dirname(this.file), { recursive: true });
		await writeFileAtomic(this.file, `${JSON.stringify(state, null, 2)}\n`);
	}

	async listInvites(): Promise<InviteRecord[]> {
		return (await this.read()).invites;
	}

	async listInbound(): Promise<InboundInviteRecord[]> {
		return (await this.read()).inbound;
	}

	async allowedIssuers(): Promise<string[]> {
		return (await this.read()).allowedIssuers;
	}

	/** Register an invite the Host must honour. Idempotent on nonce. */
	async registerInvite(record: InviteRecord): Promise<void> {
		await this.enqueue(async () => {
			const state = await this.read();
			const existing = state.invites.findIndex((invite) => invite.nonce === record.nonce);
			if (existing === -1) {
				state.invites.push(record);
			} else {
				// A retried registration must not clear a redemption that already
				// happened between the two attempts.
				state.invites[existing] = { ...record, ...pickRedemption(state.invites[existing]) };
			}
			await this.write(state);
		});
	}

	/**
	 * Record a redemption, or report why it was refused.
	 *
	 * The check and the write happen inside one queued task, so two callers
	 * racing on the same nonce cannot both be told they won.
	 */
	async redeem(
		nonce: string,
		redeemer: ExchangeMaterial,
		signature: ExchangeSignature,
		now: number,
	): Promise<{ ok: true; invite: InviteRecord } | { ok: false; reason: string; status: 404 | 409 | 410 }> {
		return await this.enqueue(async () => {
			const state = await this.read();
			const invite = state.invites.find((candidate) => candidate.nonce === nonce);
			if (invite === undefined) {
				// Deliberately the same shape as a redeemed invite's refusal would
				// be if it leaked timing: an unknown nonce and a spent one are both
				// simply "not open".
				return { ok: false as const, reason: 'no such invite', status: 404 as const };
			}
			if (invite.redeemedAt !== null) {
				return { ok: false as const, reason: 'invite already redeemed', status: 409 as const };
			}
			if (invite.expiresAt <= now) {
				return { ok: false as const, reason: 'invite expired', status: 410 as const };
			}

			invite.redeemedAt = now;
			invite.redeemer = redeemer;
			invite.redeemerSignature = signature;
			await this.write(state);
			return { ok: true as const, invite };
		});
	}

	/** Note that starting the node after a redemption failed, so the poll can surface it. */
	async recordStartError(nonce: string, message: string): Promise<void> {
		await this.enqueue(async () => {
			const state = await this.read();
			const invite = state.invites.find((candidate) => candidate.nonce === nonce);
			if (invite === undefined) {
				return;
			}
			invite.startError = message;
			await this.write(state);
		});
	}

	/** Accept an invite from a counterparty. Idempotent on nonce. */
	async acceptInbound(record: InboundInviteRecord): Promise<void> {
		await this.enqueue(async () => {
			const state = await this.read();
			if (state.inbound.some((candidate) => candidate.nonce === record.nonce)) {
				return;
			}
			state.inbound.push(record);
			// Oldest first, so a flood cannot push out an invite the operator has
			// not seen while leaving newer ones they also have not seen.
			if (state.inbound.length > MAX_INBOUND_INVITES) {
				state.inbound = state.inbound.slice(state.inbound.length - MAX_INBOUND_INVITES);
			}
			await this.write(state);
		});
	}

	async forgetInbound(nonce: string): Promise<void> {
		await this.enqueue(async () => {
			const state = await this.read();
			state.inbound = state.inbound.filter((candidate) => candidate.nonce !== nonce);
			await this.write(state);
		});
	}

	async setAllowedIssuers(addresses: string[]): Promise<void> {
		await this.enqueue(async () => {
			const state = await this.read();
			state.allowedIssuers = [...new Set(addresses)].sort();
			await this.write(state);
		});
	}

	async forgetInvite(nonce: string): Promise<void> {
		await this.enqueue(async () => {
			const state = await this.read();
			state.invites = state.invites.filter((candidate) => candidate.nonce !== nonce);
			await this.write(state);
		});
	}
}

function pickRedemption(invite: InviteRecord) {
	return {
		redeemedAt: invite.redeemedAt,
		redeemer: invite.redeemer,
		redeemerSignature: invite.redeemerSignature,
		startError: invite.startError,
	};
}
