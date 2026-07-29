/**
 * Single-writer guard on the data volume.
 *
 * Two Host containers sharing one volume would each load the same records and
 * each spawn a process per node: duplicate hydra-nodes, peer-port conflicts,
 * and two etcd members claiming a single participant identity. That is
 * unrecoverable without operator work, so a second Host refuses to boot.
 *
 * Liveness is a **heartbeat**, not a pid check. An earlier version compared the
 * recorded pid against the local process table, which is wrong in a container:
 * the holder is almost always pid 1, and pid 1 always exists in the reader's
 * own namespace. A host killed ungracefully therefore left a lock that every
 * later container read as live, and the Host could never boot again without
 * someone deleting the file by hand — turning the guard into a worse outage
 * than the one it prevents, in exactly the ungraceful-kill case the rest of the
 * recovery design is built around.
 *
 * The holder refreshes its heartbeat while it runs; a lock whose heartbeat has
 * gone stale is reclaimed.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { getOwnInteger, getOwnString, isPlainObject } from './json.js';

const LOCK_FILE = 'host.lock';

/** How often the holder refreshes its heartbeat. */
export const HEARTBEAT_INTERVAL_MS = 10_000;
/**
 * How long a heartbeat may go unrefreshed before the lock is considered stale.
 * Generous relative to the interval so a slow or paused host is not evicted
 * while it is still running.
 */
export const HEARTBEAT_STALE_AFTER_MS = 60_000;

export class HostLockError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'HostLockError';
	}
}

export type LockHolder = { pid: number; hostId: string; acquiredAt: string; heartbeatAt: string };

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
	if (pid === undefined || hostId === undefined || acquiredAt === undefined) {
		return null;
	}
	// Locks written before heartbeats existed fall back to their acquisition
	// time, so they age out rather than being treated as fresh forever.
	const heartbeatAt = getOwnString(parsed, 'heartbeatAt') ?? acquiredAt;
	return { pid, hostId, acquiredAt, heartbeatAt };
}

export type LockLiveness = { live: true } | { live: false; reason: string };

/**
 * Whether a recorded holder should still be respected.
 *
 * A lock held by *our own* host identity is always reclaimable: that is a
 * restart of the same deployment, not a competing writer.
 */
export function assessHolder(holder: LockHolder, ourHostId: string, nowMs: number): LockLiveness {
	if (holder.hostId === ourHostId) {
		return { live: false, reason: 'the lock belongs to this host id, so this is a restart' };
	}
	const heartbeat = Date.parse(holder.heartbeatAt);
	if (!Number.isFinite(heartbeat)) {
		return { live: false, reason: 'the lock has no usable heartbeat' };
	}
	const age = nowMs - heartbeat;
	if (age > HEARTBEAT_STALE_AFTER_MS) {
		return { live: false, reason: `the holder's heartbeat is ${Math.round(age / 1000)}s stale` };
	}
	return { live: true };
}

export class HostLock {
	private readonly lockPath: string;
	private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

	constructor(
		dataDir: string,
		private readonly hostId: string,
		private readonly now: () => number = Date.now,
	) {
		this.lockPath = path.join(dataDir, LOCK_FILE);
	}

	private payload(acquiredAt: string): string {
		const holder: LockHolder = {
			pid: process.pid,
			hostId: this.hostId,
			acquiredAt,
			heartbeatAt: new Date(this.now()).toISOString(),
		};
		return `${JSON.stringify(holder)}\n`;
	}

	async acquire(): Promise<void> {
		await fs.mkdir(path.dirname(this.lockPath), { recursive: true });
		const acquiredAt = new Date(this.now()).toISOString();

		try {
			// wx fails when the file exists, which is the whole point.
			await fs.writeFile(this.lockPath, this.payload(acquiredAt), { flag: 'wx' });
			this.startHeartbeat(acquiredAt);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
				throw error;
			}
		}

		const existing = parseLockHolder(await fs.readFile(this.lockPath, 'utf8').catch(() => ''));
		if (existing !== null) {
			const liveness = assessHolder(existing, this.hostId, this.now());
			if (liveness.live) {
				throw new HostLockError(
					`another Hydra Host (host ${existing.hostId}, heartbeat ${existing.heartbeatAt}) already holds ` +
						`${this.lockPath}; two hosts on one volume would spawn duplicate nodes`,
				);
			}
		}

		await fs.writeFile(this.lockPath, this.payload(acquiredAt));
		this.startHeartbeat(acquiredAt);
	}

	private startHeartbeat(acquiredAt: string): void {
		this.stopHeartbeat();
		const timer = setInterval(() => {
			void fs.writeFile(this.lockPath, this.payload(acquiredAt)).catch(() => undefined);
		}, HEARTBEAT_INTERVAL_MS);
		timer.unref?.();
		this.heartbeatTimer = timer;
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer !== undefined) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
	}

	async release(): Promise<void> {
		this.stopHeartbeat();
		await fs.rm(this.lockPath, { force: true });
	}
}
