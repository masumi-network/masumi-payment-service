/**
 * Durable state for the Exchange Plane.
 *
 * Issued invites live here on the persistence volume because they must survive
 * a restart:
 *
 *  - invites this Host will honour, and whether each has been redeemed. A
 *    redemption that were forgotten would let the same nonce open a second
 *    head, which is the one thing single-use is meant to prevent.
 *
 * Writes are serialised through one queue rather than per-key. The exchange is
 * a low-rate path — a handful of invites per operator per day — and a single
 * queue makes "check then redeem" atomic without a lock per nonce.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write.js';
import { isPlainObject } from './json.js';
import type { ExchangeMaterial, ExchangeSignature, InviteRecord } from './exchange-types.js';

const EXCHANGE_FILE = 'exchange.json';
/** Replay tombstones need not live forever after the invite can no longer be used. */
export const INVITE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export class ExchangeStoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ExchangeStoreError';
	}
}

type ExchangeState = {
	invites: InviteRecord[];
};

function emptyState(): ExchangeState {
	return { invites: [] };
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
	};
}

export class ExchangeStore {
	private readonly file: string;
	private queue: Promise<unknown> = Promise.resolve();
	private state: ExchangeState | undefined;

	constructor(dataDir: string) {
		this.file = path.join(dataDir, EXCHANGE_FILE);
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const next = this.queue.then(task, task);
		this.queue = next.catch(() => undefined);
		return next;
	}

	private async read(): Promise<ExchangeState> {
		if (this.state !== undefined) {
			return this.state;
		}
		try {
			this.state = parseState(await fs.readFile(this.file, 'utf8'));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				this.state = emptyState();
			} else {
				throw error;
			}
		}
		return this.state;
	}

	private async write(state: ExchangeState): Promise<void> {
		await fs.mkdir(path.dirname(this.file), { recursive: true });
		await writeFileAtomic(this.file, `${JSON.stringify(state, null, 2)}\n`);
	}

	async listInvites(): Promise<InviteRecord[]> {
		return await this.enqueue(async () => {
			const state = await this.read();
			if (pruneRetainedInvites(state, Date.now())) {
				await this.write(state);
			}
			// Callers must not be able to mutate the cached durable state outside
			// this store's serial queue.
			return state.invites.map(copyInvite);
		});
	}

	/** Register an invite the Host must honour. Idempotent on nonce. */
	async registerInvite(record: InviteRecord): Promise<void> {
		await this.enqueue(async () => {
			const state = await this.read();
			pruneRetainedInvites(state, Date.now());
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
			pruneRetainedInvites(state, now);
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

function copyInvite(invite: InviteRecord): InviteRecord {
	return {
		...invite,
		redeemer: invite.redeemer === null ? null : { ...invite.redeemer },
		redeemerSignature: invite.redeemerSignature === null ? null : { ...invite.redeemerSignature },
	};
}

function pruneRetainedInvites(state: ExchangeState, now: number): boolean {
	const cutoff = now - INVITE_RETENTION_MS;
	const retained = state.invites.filter((invite) => (invite.redeemedAt ?? invite.expiresAt) > cutoff);
	if (retained.length === state.invites.length) {
		return false;
	}
	state.invites = retained;
	return true;
}
