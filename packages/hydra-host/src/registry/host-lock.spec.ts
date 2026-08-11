import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
	HEARTBEAT_STALE_AFTER_MS,
	HostLock,
	HostLockError,
	assessHolder,
	parseLockHolder,
	type LockHolder,
} from './host-lock.js';

const NOW = Date.parse('2026-07-29T12:00:00.000Z');

function holder(overrides: Partial<LockHolder> = {}): LockHolder {
	return {
		pid: 1,
		hostId: 'container-a',
		acquiredAt: new Date(NOW - 60_000).toISOString(),
		heartbeatAt: new Date(NOW - 1_000).toISOString(),
		...overrides,
	};
}

let dataDir: string;

beforeEach(async () => {
	dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hydra-host-lock-'));
});

afterEach(async () => {
	await fs.rm(dataDir, { recursive: true, force: true });
});

async function currentHolder(): Promise<LockHolder | null> {
	const lockDirectory = path.join(dataDir, 'host.lock');
	const owner = parseLockHolder(await fs.readFile(path.join(lockDirectory, 'owner.json'), 'utf8'));
	if (owner?.ownerToken === undefined) {
		return owner;
	}
	const heartbeatAt = (await fs.readFile(path.join(lockDirectory, `heartbeat.${owner.ownerToken}`), 'utf8')).trim();
	return { ...owner, heartbeatAt };
}

describe('parseLockHolder', () => {
	it('reads a well-formed holder', () => {
		expect(parseLockHolder(JSON.stringify(holder()))?.hostId).toBe('container-a');
	});

	it('falls back to acquiredAt when a legacy lock predates heartbeats', () => {
		const legacy = { pid: 1, hostId: 'old', acquiredAt: '2026-07-29T11:00:00.000Z' };
		expect(parseLockHolder(JSON.stringify(legacy))?.heartbeatAt).toBe('2026-07-29T11:00:00.000Z');
	});

	it('returns null for junk or incomplete content', () => {
		expect(parseLockHolder('not json')).toBeNull();
		expect(parseLockHolder('{"pid":42}')).toBeNull();
	});
});

describe('assessHolder', () => {
	it('respects a fresh lock even when the hostname is the same', () => {
		expect(assessHolder(holder({ hostId: 'container-b' }), 'container-b', NOW)).toEqual({ live: true });
	});

	it('reclaims a lock after its heartbeat lease expires', () => {
		const killed = holder({ heartbeatAt: new Date(NOW - HEARTBEAT_STALE_AFTER_MS - 1).toISOString() });
		expect(assessHolder(killed, 'container-b', NOW)).toMatchObject({ live: false });
	});

	it('holds the boundary just under the staleness threshold', () => {
		const fresh = holder({ heartbeatAt: new Date(NOW - HEARTBEAT_STALE_AFTER_MS + 1_000).toISOString() });
		expect(assessHolder(fresh, 'container-b', NOW)).toEqual({ live: true });
	});
});

describe('HostLock', () => {
	it('acquires a fresh volume with an owner token and token-specific heartbeat', async () => {
		await new HostLock(dataDir, 'host-a').acquire();
		const parsed = await currentHolder();
		expect(parsed?.hostId).toBe('host-a');
		expect(parsed?.ownerToken).toBeDefined();
		expect(parsed?.heartbeatAt).toBeDefined();
	});

	it('refuses a second host while the heartbeat is fresh', async () => {
		await new HostLock(dataDir, 'host-a').acquire();
		await expect(new HostLock(dataDir, 'host-b').acquire()).rejects.toThrow(HostLockError);
	});

	it('refuses a second process even when it reports the same hostname', async () => {
		await new HostLock(dataDir, 'host-a').acquire();
		await expect(new HostLock(dataDir, 'host-a').acquire()).rejects.toThrow(HostLockError);
	});

	it('atomically lets one contender reclaim a stale lease', async () => {
		await new HostLock(dataDir, 'host-a').acquire();
		const muchLater = () => Date.now() + HEARTBEAT_STALE_AFTER_MS + 10_000;
		const results = await Promise.allSettled([
			new HostLock(dataDir, 'host-b', muchLater).acquire(),
			new HostLock(dataDir, 'host-c', muchLater).acquire(),
		]);
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(['host-b', 'host-c']).toContain((await currentHolder())?.hostId);
	});

	it('migrates a corrupted legacy file without overwriting a live directory lease', async () => {
		await fs.writeFile(path.join(dataDir, 'host.lock'), 'garbage', 'utf8');
		await expect(new HostLock(dataDir, 'host-b').acquire()).resolves.toBeUndefined();
		expect((await currentHolder())?.hostId).toBe('host-b');
	});

	it('an old holder cannot release a replacement lease', async () => {
		const old = new HostLock(dataDir, 'host-a');
		await old.acquire();
		const muchLater = () => Date.now() + HEARTBEAT_STALE_AFTER_MS + 10_000;
		const replacement = new HostLock(dataDir, 'host-b', muchLater);
		await replacement.acquire();
		await old.release();
		expect((await currentHolder())?.hostId).toBe('host-b');
	});

	it('releases so a later host can acquire', async () => {
		const lock = new HostLock(dataDir, 'host-a');
		await lock.acquire();
		await lock.release();
		await expect(new HostLock(dataDir, 'host-b').acquire()).resolves.toBeUndefined();
	});

	it('is safe to release when not held', async () => {
		await expect(new HostLock(dataDir, 'host-a').release()).resolves.toBeUndefined();
	});
});
