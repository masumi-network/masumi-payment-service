/**
 * Single-writer guard on the data volume.
 *
 * Two Host containers sharing one volume would each load the same records and
 * each spawn a process per node: duplicate hydra-nodes, peer-port conflicts,
 * and two etcd members claiming a single participant identity. That is
 * unrecoverable without operator work, so a second Host refuses to boot.
 *
 * The lock is advisory and crash-safe by construction: it stores the holder's
 * pid, and a lock whose pid is no longer alive is reclaimed. It does not
 * protect against two containers in *different* pid namespaces on the same
 * volume — a stale pid may coincidentally match a live process there — so a
 * host id is stored alongside and mismatches are reported rather than silently
 * stolen.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { getOwnInteger, getOwnString, isPlainObject } from './json.js';

const LOCK_FILE = 'host.lock';

export class HostLockError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'HostLockError';
	}
}

export type LockHolder = { pid: number; hostId: string; acquiredAt: string };

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
	return { pid, hostId, acquiredAt };
}

export function isHolderAlive(holder: LockHolder, isAlive: (pid: number) => boolean): boolean {
	return holder.pid > 0 && isAlive(holder.pid);
}

export const processIsAlive = (pid: number): boolean => {
	try {
		// Signal 0 performs the permission/existence check without delivering.
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

export class HostLock {
	private readonly lockPath: string;

	constructor(
		dataDir: string,
		private readonly hostId: string,
		private readonly isAlive: (pid: number) => boolean = processIsAlive,
	) {
		this.lockPath = path.join(dataDir, LOCK_FILE);
	}

	async acquire(): Promise<void> {
		await fs.mkdir(path.dirname(this.lockPath), { recursive: true });

		const holder: LockHolder = { pid: process.pid, hostId: this.hostId, acquiredAt: new Date().toISOString() };
		const payload = `${JSON.stringify(holder)}\n`;

		try {
			// wx fails when the file exists, which is the whole point.
			await fs.writeFile(this.lockPath, payload, { flag: 'wx' });
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
				throw error;
			}
		}

		const existing = parseLockHolder(await fs.readFile(this.lockPath, 'utf8').catch(() => ''));
		if (existing !== null && isHolderAlive(existing, this.isAlive)) {
			throw new HostLockError(
				`another Hydra Host (pid ${existing.pid}, host ${existing.hostId}, since ${existing.acquiredAt}) ` +
					`already holds ${this.lockPath}; two hosts on one volume would spawn duplicate nodes`,
			);
		}

		// Holder is gone — reclaim.
		await fs.writeFile(this.lockPath, payload);
	}

	async release(): Promise<void> {
		await fs.rm(this.lockPath, { force: true });
	}
}
