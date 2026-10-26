/**
 * Single-writer lease on the data volume.
 *
 * The lock is a directory containing an immutable owner token and a heartbeat
 * named for that token. A candidate directory is fully prepared and atomically
 * renamed into place.
 *
 * Taking a stale lease empties the path and then fills it, and the gap between
 * those two renames is long enough for another contender to walk into — so the
 * whole attempt runs behind a second `mkdir` gate. Renames alone are not
 * enough: they are atomic, but they address a path rather than the object that
 * was inspected at it.
 *
 * The random token is the fence. An old process checks it before every
 * heartbeat and release, so it cannot refresh or delete a replacement lease.
 * Hostname equality grants no shortcut: two containers on one machine are
 * still two writers.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write.js';
import { getOwnInteger, getOwnString, isPlainObject } from './json.js';

const LOCK_DIRECTORY = 'host.lock';
const TAKEOVER_DIRECTORY = 'host.lock.takeover';
const OWNER_FILE = 'owner.json';

/** A takeover is a handful of file operations, so contenders wait it out. */
const TAKEOVER_RETRY_MS = 25;

/** How often the holder refreshes its heartbeat. */
export const HEARTBEAT_INTERVAL_MS = 10_000;
/** Generous relative to the interval so a short process pause is tolerated. */
export const HEARTBEAT_STALE_AFTER_MS = 60_000;

export class HostLockError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'HostLockError';
	}
}

export type LockHolder = {
	pid: number;
	hostId: string;
	acquiredAt: string;
	heartbeatAt: string;
	ownerToken?: string;
};

type LeaseOwner = LockHolder & { ownerToken: string };

function leaseTimestamp(value: string): number | null {
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value ? timestamp : null;
}

export function parseLockHolder(raw: string): LockHolder | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isPlainObject(parsed)) {
		return null;
	}
	const pid = getOwnInteger(parsed, 'pid');
	const hostId = getOwnString(parsed, 'hostId');
	const acquiredAt = getOwnString(parsed, 'acquiredAt');
	if (pid === undefined || pid <= 0 || hostId === undefined || hostId.length === 0 || acquiredAt === undefined) {
		return null;
	}
	const storedHeartbeat = getOwnString(parsed, 'heartbeatAt');
	if (Object.prototype.hasOwnProperty.call(parsed, 'heartbeatAt') && storedHeartbeat === undefined) return null;
	const heartbeatAt = storedHeartbeat ?? acquiredAt;
	const ownerToken = getOwnString(parsed, 'ownerToken');
	if (
		Object.prototype.hasOwnProperty.call(parsed, 'ownerToken') &&
		(ownerToken === undefined || !/^[a-zA-Z0-9_-]+$/.test(ownerToken))
	)
		return null;
	if (leaseTimestamp(acquiredAt) === null || leaseTimestamp(heartbeatAt) === null) return null;
	return { pid, hostId, acquiredAt, heartbeatAt, ...(ownerToken === undefined ? {} : { ownerToken }) };
}

export type LockLiveness = { live: true } | { live: false; reason: string };

export function assessHolder(holder: LockHolder, _ourHostId: string, nowMs: number): LockLiveness {
	if (holder.heartbeatAt === 'released') return { live: false, reason: 'the holder explicitly released its lease' };
	const heartbeat = leaseTimestamp(holder.heartbeatAt);
	const acquired = leaseTimestamp(holder.acquiredAt);
	if (heartbeat === null || acquired === null) {
		throw new HostLockError('the existing lease has malformed acquisition or heartbeat dates');
	}
	// A future timestamp can reflect clock skew. It cannot establish a dead owner.
	const age = nowMs - Math.max(acquired, heartbeat);
	if (age > HEARTBEAT_STALE_AFTER_MS) {
		return { live: false, reason: `the holder's heartbeat is ${Math.round(age / 1000)}s stale` };
	}
	return { live: true };
}

function isAlreadyExists(error: unknown): boolean {
	return ['EEXIST', 'ENOTEMPTY', 'EISDIR', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
}

export class HostLock {
	private readonly lockPath: string;
	private readonly takeoverPath: string;
	private readonly ownerToken = randomUUID();
	private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	private acquiredAt: string | undefined;
	private held = false;
	private leaseLost = false;

	constructor(
		dataDir: string,
		private readonly hostId: string,
		private readonly now: () => number = Date.now,
		private readonly onLeaseLost: (reason: string) => void = () => undefined,
	) {
		this.lockPath = path.join(dataDir, LOCK_DIRECTORY);
		this.takeoverPath = path.join(dataDir, TAKEOVER_DIRECTORY);
	}

	private owner(acquiredAt: string): LeaseOwner {
		return {
			pid: process.pid,
			hostId: this.hostId,
			ownerToken: this.ownerToken,
			acquiredAt,
			heartbeatAt: acquiredAt,
		};
	}

	private heartbeatPath(directory = this.lockPath): string {
		return path.join(directory, `heartbeat.${this.ownerToken}`);
	}

	private async prepareCandidate(acquiredAt: string): Promise<string> {
		const candidate = `${this.lockPath}.candidate.${this.ownerToken}`;
		await fs.mkdir(candidate);
		await fs.writeFile(path.join(candidate, OWNER_FILE), `${JSON.stringify(this.owner(acquiredAt))}\n`, { flag: 'wx' });
		await fs.writeFile(this.heartbeatPath(candidate), `${acquiredAt}\n`, { flag: 'wx' });
		return candidate;
	}

	private async leaseStat() {
		try {
			return await fs.lstat(this.lockPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw new HostLockError(
				`cannot inspect existing lease ${this.lockPath}; repair its filesystem access before retrying`,
			);
		}
	}

	private async readHolder(): Promise<LockHolder | null> {
		const stat = await this.leaseStat();
		if (stat === null) return null;
		try {
			if (stat.isFile()) {
				// A valid earlier single-file lease can still expire by heartbeat age.
				const legacy = parseLockHolder(await fs.readFile(this.lockPath, 'utf8'));
				if (legacy === null) throw new HostLockError('existing legacy lease metadata is malformed');
				return legacy;
			}
			if (!stat.isDirectory()) throw new HostLockError('existing lease is neither a file nor a directory');
			const owner = parseLockHolder(await fs.readFile(path.join(this.lockPath, OWNER_FILE), 'utf8'));
			if (owner?.ownerToken === undefined) {
				throw new HostLockError('existing lease owner metadata is malformed');
			}
			try {
				await fs.access(path.join(this.lockPath, `released.${owner.ownerToken}`));
				return { ...owner, heartbeatAt: 'released' };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			}
			const heartbeat = (await fs.readFile(path.join(this.lockPath, `heartbeat.${owner.ownerToken}`), 'utf8')).trim();
			if (leaseTimestamp(heartbeat) === null) throw new HostLockError('existing lease heartbeat is malformed');
			return { ...owner, heartbeatAt: heartbeat };
		} catch {
			throw new HostLockError(
				`cannot verify existing lease ${this.lockPath}; its owner, heartbeat, or release marker is unreadable or malformed. ` +
					'Stop all Hosts using this volume and repair the lease evidence before retrying',
			);
		}
	}

	private async ownsCurrentLease(): Promise<boolean> {
		return (await this.readHolder())?.ownerToken === this.ownerToken;
	}

	/**
	 * Run one acquisition attempt with every other contender excluded.
	 *
	 * Taking over a stale lease means emptying the lock path and then filling it,
	 * and between those two renames the path is briefly free. Without this gate
	 * any other contender's plain rename lands in that gap and succeeds — so a
	 * crowd starting together against one stale lease produced several hosts that
	 * each believed they held the volume, which is a duplicate hydra-node for
	 * every node on it until a heartbeat notices, up to ten seconds later.
	 *
	 * `mkdir` is the mutex because it is atomic and fails with EEXIST rather than
	 * clobbering. Returns null when someone else holds it.
	 */
	private async withTakeover<T>(action: () => Promise<T>): Promise<T | null> {
		const taken = await fs.mkdir(this.takeoverPath).then(
			() => true,
			(error: unknown) => {
				if (!isAlreadyExists(error)) {
					throw error;
				}
				return false;
			},
		);
		if (!taken) {
			// Age cannot distinguish a dead contender from a paused one. Removing
			// its gate would let both run this critical section, and its finally
			// could remove a successor's gate. Only the creator removes this gate.
			return null;
		}
		try {
			return await action();
		} finally {
			await fs.rm(this.takeoverPath, { recursive: true, force: true });
		}
	}

	async acquire(): Promise<void> {
		await fs.mkdir(path.dirname(this.lockPath), { recursive: true });
		const acquiredAt = new Date(this.now()).toISOString();
		let candidate = await this.prepareCandidate(acquiredAt);

		try {
			for (let attempt = 0; attempt < 8; attempt += 1) {
				const installed = await this.withTakeover(async () => {
					const stat = await this.leaseStat();
					if (stat !== null) {
						const existing = await this.readHolder();
						if (existing !== null) {
							const liveness = assessHolder(existing, this.hostId, this.now());
							if (liveness.live) {
								throw new HostLockError(
									`another Hydra Host (host ${existing.hostId}, heartbeat ${existing.heartbeatAt}) already holds ` +
										`${this.lockPath}; two hosts on one volume would spawn duplicate nodes`,
								);
							}
						}
						// Proven stale or explicitly released. Unreadable evidence above
						// refuses takeover. Moved aside rather than deleted in place, so nothing
						// half-removed can be mistaken for a lease, and dropped only once
						// it is out of the way.
						const quarantine = `${this.lockPath}.stale.${randomUUID()}`;
						await fs.rename(this.lockPath, quarantine).catch((error: unknown) => {
							if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
								throw error;
							}
						});
						await fs.rm(quarantine, { recursive: true, force: true });
					}
					await fs.rename(candidate, this.lockPath);
					return true;
				});

				if (installed === true) {
					candidate = '';
					this.finishAcquisition(acquiredAt);
					return;
				}
				// Another contender is mid-takeover. Its whole turn is a handful of
				// file operations, so this waits rather than races it.
				await new Promise((resolve) => setTimeout(resolve, TAKEOVER_RETRY_MS));
			}
			throw new HostLockError(
				`could not acquire ${this.lockPath}; takeover gate ${this.takeoverPath} remained held. ` +
					'If a crashed startup left it behind, stop all Hydra Host processes and startup contenders using this volume, ' +
					'disable their automatic restarts, and verify that none remain before manually removing only the takeover gate. ' +
					'Never remove it while a Host or contender may still be running',
			);
		} finally {
			if (candidate.length > 0) {
				await fs.rm(candidate, { recursive: true, force: true });
			}
		}
	}

	private finishAcquisition(acquiredAt: string): void {
		this.acquiredAt = acquiredAt;
		this.held = true;
		this.leaseLost = false;
		this.startHeartbeat();
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();
		const timer = setInterval(() => {
			void this.refreshHeartbeat().catch((error: unknown) => {
				this.loseLease(`heartbeat failed: ${(error as Error).message}`);
			});
		}, HEARTBEAT_INTERVAL_MS);
		timer.unref?.();
		this.heartbeatTimer = timer;
	}

	private async refreshHeartbeat(): Promise<void> {
		if (!this.held || this.acquiredAt === undefined) {
			return;
		}
		if (!(await this.ownsCurrentLease())) {
			this.loseLease('the data-volume lease was replaced by another Host');
			return;
		}
		await writeFileAtomic(this.heartbeatPath(), `${new Date(this.now()).toISOString()}\n`);
	}

	private loseLease(reason: string): void {
		if (this.leaseLost) {
			return;
		}
		this.leaseLost = true;
		this.held = false;
		this.stopHeartbeat();
		this.onLeaseLost(reason);
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer !== undefined) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
	}

	async release(): Promise<void> {
		this.stopHeartbeat();
		if (!this.held || !(await this.ownsCurrentLease())) {
			this.held = false;
			return;
		}

		// Mark only this fencing token as released. If takeover happens between
		// the ownership check and this write, the marker lands in the new
		// directory under the old token and is ignored by the new owner. Deleting
		// or renaming the shared path here would have a release-time TOCTOU.
		await fs
			.writeFile(path.join(this.lockPath, `released.${this.ownerToken}`), `${new Date(this.now()).toISOString()}\n`, {
				flag: 'wx',
			})
			.catch((error: unknown) => {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
					throw error;
				}
			});
		this.held = false;
	}
}
