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
import type { NodeRegistryStore } from './store.js';

const EXCHANGE_FILE = 'exchange.json';
const EXCHANGE_FILE_MODE = 0o600;
/**
 * How long an unredeemed invite is kept after it expires.
 *
 * Only unredeemed invites age out. A redeemed invite holds the counterparty's
 * signed redemption, the one copy the owning service needs to adopt the head,
 * so it stays until the service forgets it: after adoption, or when it cancels
 * the invite. Ageing it out on a timer let a service that was down, or whose
 * adoption kept failing, lose the evidence for good, and left a reserved node
 * and an `Issued` invite that only manual repair could clear.
 */
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

/**
 * Why a redemption was refused.
 *
 * `redeemed-by-other` is the one refusal that proves the nonce was spent by a
 * different redemption than the one being asked about. The plain text stays
 * `invite already redeemed`, so a client that predates the code reads the same
 * answer it always did.
 */
export type RedeemRefusalCode = 'redeemed-by-other';

export type RedeemResult =
	| { ok: true; invite: InviteRecord; replayed: boolean }
	| { ok: false; reason: string; status: 404 | 409 | 410; code?: RedeemRefusalCode };

function sameMaterial(a: ExchangeMaterial, b: ExchangeMaterial): boolean {
	return (
		a.walletAddress === b.walletAddress &&
		a.hydraVerificationKey === b.hydraVerificationKey &&
		a.cardanoVerificationKey === b.cardanoVerificationKey &&
		a.advertise === b.advertise &&
		a.exchangeUrl === b.exchangeUrl
	);
}

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
			return { invites: this.state.invites.map(copyInvite) };
		}
		try {
			// Older native Host runs could leave open invite nonces in a 0644 file.
			await fs.chmod(this.file, EXCHANGE_FILE_MODE);
			this.state = parseState(await fs.readFile(this.file, 'utf8'));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				this.state = emptyState();
			} else {
				throw error;
			}
		}
		return { invites: this.state.invites.map(copyInvite) };
	}

	private async write(state: ExchangeState): Promise<void> {
		await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
		await writeFileAtomic(this.file, `${JSON.stringify(state, null, 2)}\n`, { mode: EXCHANGE_FILE_MODE });
		// Publish only durable changes. Copies also keep caller-owned records
		// and redemption results from changing the cache after the write.
		this.state = { invites: state.invites.map(copyInvite) };
	}

	async listInvites(): Promise<InviteRecord[]> {
		return (await this.listInvitesWithWatermark()).invites;
	}

	/**
	 * The invites, and the instant a later redemption is guaranteed to beat.
	 *
	 * The watermark has to be read inside this task, not around it. The poller
	 * stores what it gets back and asks for `redeemedAt > since` next time, so a
	 * redemption stamped earlier than the watermark but written later is invisible
	 * for good: its invite stays `Issued` with no head, holding a node, its port
	 * and its fuel, and blocking deletion of the Host until a process restart
	 * falls back to the cold-start watermark. Taking it after `await listInvites()`
	 * resolved was exactly that window — the queue is FIFO, so a redemption
	 * enqueued behind this read has its own timestamp taken behind it too, and
	 * only a clock read from inside the queue orders the two.
	 */
	async listInvitesWithWatermark(): Promise<{ invites: InviteRecord[]; now: number }> {
		return await this.enqueue(async () => {
			const now = Date.now();
			const state = await this.read();
			if (pruneRetainedInvites(state, now)) {
				await this.write(state);
			}
			// One millisecond behind the read, because the poller's filter is
			// strict: a redemption enqueued behind this task can read the very same
			// millisecond off the clock, and `redeemedAt > since` would then step
			// over it forever. Reporting a millisecond earlier can at worst repeat
			// a redemption this response already carried, which the owning service
			// resolves idempotently.
			return { invites: state.invites.filter(isListed).map(copyInvite), now: now - 1 };
		});
	}

	/** Register an invite the Host must honour. Idempotent on nonce. */
	async registerInvite(record: InviteRecord, assertNodeAvailable?: () => Promise<void>): Promise<void> {
		await this.enqueue(async () => {
			const state = await this.read();
			pruneRetainedInvites(state, Date.now());
			// Orphan cleanup uses this same queue. Recheck the node here, after any
			// removal that won the queue and before this invite becomes redeemable.
			if (assertNodeAvailable) await assertNodeAvailable();
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

	/** Hold the invite queue through a node removal so register and redeem cannot claim it meanwhile. */
	async removeUnclaimedNode<T>(nodeId: string, remove: () => Promise<T>): Promise<T | null> {
		return await this.enqueue(async () => {
			const state = await this.read();
			const now = Date.now();
			if (
				state.invites.some(
					(invite) =>
						invite.hostNodeId === nodeId &&
						invite.forgottenAt === undefined &&
						(invite.redeemedAt !== null || invite.expiresAt > now),
				)
			) {
				return null;
			}
			return await remove();
		});
	}

	/**
	 * Record a redemption, or report why it was refused.
	 *
	 * The check and the write happen inside one queued task, so two callers
	 * racing on the same nonce cannot both be told they won.
	 */
	async redeem(nonce: string, redeemer: ExchangeMaterial, signature: ExchangeSignature): Promise<RedeemResult> {
		return await this.enqueue(async () => {
			// Read here rather than passed in from the handler. The stamp is what
			// the owning service's watermark is compared against, and a timestamp
			// taken before the queue wait can predate a poll that ran during it —
			// which loses the redemption for good. See `listInvitesWithWatermark`.
			const now = Date.now();
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
				// Checked before expiry: a redemption that landed stays answerable after
				// the invite lapses, or a redeemer whose answer was lost could never learn
				// it succeeded. The caller's signature was verified before this point and
				// covers the nonce and every field below, so equal material is the same
				// signer repeating itself, and nothing is written.
				if (invite.redeemer !== null && sameMaterial(invite.redeemer, redeemer)) {
					return { ok: true as const, invite, replayed: true };
				}
				return {
					ok: false as const,
					reason: 'invite already redeemed',
					status: 409 as const,
					code: 'redeemed-by-other' as const,
				};
			}
			if (invite.expiresAt <= now) {
				return { ok: false as const, reason: 'invite expired', status: 410 as const };
			}

			invite.redeemedAt = now;
			invite.redeemer = redeemer;
			invite.redeemerSignature = signature;
			await this.write(state);
			return { ok: true as const, invite, replayed: false };
		});
	}

	/** Note that starting the node after a redemption failed, so the poll can surface it. */
	async recordStartError(nonce: string, message: string | null): Promise<void> {
		await this.enqueue(async () => {
			const state = await this.read();
			const invite = state.invites.find((candidate) => candidate.nonce === nonce);
			if (invite === undefined || invite.forgottenAt !== undefined) {
				return;
			}
			invite.startError = message;
			await this.write(state);
		});
	}

	/**
	 * Forget an invite.
	 *
	 * `keepReplay` is for a redemption the service adopted: the record is reduced
	 * to the redeemer's public material, so an identical replay is still answered
	 * after the service no longer needs the signed redemption. Without it, or for
	 * an invite nobody redeemed, the record is removed, which is what a cancelled
	 * or revoked invite needs.
	 */
	async forgetInvite(
		nonce: string,
		nodes?: NodeRegistryStore,
		options: { keepReplay?: boolean } = {},
	): Promise<boolean> {
		return await this.enqueue(async () => {
			const state = await this.read();
			const invite = state.invites.find((candidate) => candidate.nonce === nonce);
			const keepReplay = options.keepReplay === true;
			if (keepReplay && invite?.forgottenAt !== undefined) {
				return true;
			}
			// Adoption can arrive before the exchange handler configures peers.
			// Keep the durable material until setup no longer needs a retry.
			if (
				nodes !== undefined &&
				invite !== undefined &&
				invite.redeemedAt !== null &&
				invite.forgottenAt === undefined
			) {
				const node = await nodes.read(invite.hostNodeId);
				if (node !== null && !node.removalRequested && node.state !== 'Removing' && node.peers.length === 0) {
					return false;
				}
			}
			if (keepReplay && invite !== undefined && invite.redeemedAt !== null && invite.redeemer !== null) {
				invite.forgottenAt = Date.now();
				invite.redeemerSignature = null;
				invite.startError = null;
			} else {
				state.invites = state.invites.filter((candidate) => candidate.nonce !== nonce);
			}
			await this.write(state);
			return true;
		});
	}
}

function pickRedemption(invite: InviteRecord) {
	return {
		redeemedAt: invite.redeemedAt,
		redeemer: invite.redeemer,
		redeemerSignature: invite.redeemerSignature,
		startError: invite.startError,
		forgottenAt: invite.forgottenAt,
	};
}

/** A kept replay record is answered by `redeem` only; every listing skips it. */
function isListed(invite: InviteRecord): boolean {
	return invite.forgottenAt === undefined;
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
	const retained = state.invites.filter((invite) =>
		// A kept replay record lives seven days from when the service forgot it, not
		// from the redemption: a service that was down for a month adopts late, and
		// its redeemer still needs the week after that. Every other redeemed record
		// stays until forgotten.
		invite.forgottenAt !== undefined
			? invite.forgottenAt > cutoff
			: invite.redeemedAt !== null || invite.expiresAt > cutoff,
	);
	if (retained.length === state.invites.length) {
		return false;
	}
	state.invites = retained;
	return true;
}
