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

describe('parseLockHolder', () => {
	it('reads a well-formed holder', () => {
		const parsed = parseLockHolder(JSON.stringify(holder()));
		expect(parsed?.hostId).toBe('container-a');
		expect(parsed?.heartbeatAt).toBeDefined();
	});

	// Locks written before heartbeats existed must age out rather than read as
	// permanently fresh.
	it('falls back to acquiredAt when a lock predates heartbeats', () => {
		const legacy = { pid: 1, hostId: 'old', acquiredAt: '2026-07-29T11:00:00.000Z' };
		expect(parseLockHolder(JSON.stringify(legacy))?.heartbeatAt).toBe('2026-07-29T11:00:00.000Z');
	});

	it('returns null for junk or incomplete content', () => {
		expect(parseLockHolder('not json')).toBeNull();
		expect(parseLockHolder('{"pid":42}')).toBeNull();
		expect(parseLockHolder('[]')).toBeNull();
	});
});

describe('assessHolder', () => {
	it('respects a lock whose heartbeat is fresh', () => {
		expect(assessHolder(holder(), 'container-b', NOW)).toEqual({ live: true });
	});

	/**
	 * The regression this exists for: liveness used to be a pid check. In a
	 * container the holder is pid 1 and pid 1 always exists in the reader's own
	 * namespace, so a host killed ungracefully left a lock that every later
	 * container read as live — and the Host could never boot again without
	 * someone deleting the file by hand. Reproduced against a real container
	 * before this changed.
	 */
	it('reclaims a lock left by a killed host, even though its pid looks alive', () => {
		const killed = holder({ pid: 1, heartbeatAt: new Date(NOW - HEARTBEAT_STALE_AFTER_MS - 1).toISOString() });
		expect(assessHolder(killed, 'container-b', NOW)).toMatchObject({ live: false });
	});

	// A restart of the same deployment is not a competing writer.
	it('reclaims a lock belonging to our own host id', () => {
		expect(assessHolder(holder({ hostId: 'container-b' }), 'container-b', NOW)).toMatchObject({ live: false });
	});

	it('reclaims a lock with an unusable heartbeat', () => {
		expect(assessHolder(holder({ heartbeatAt: 'not-a-date' }), 'container-b', NOW)).toMatchObject({ live: false });
	});

	it('holds the boundary just under the staleness threshold', () => {
		const justFresh = holder({ heartbeatAt: new Date(NOW - HEARTBEAT_STALE_AFTER_MS + 1_000).toISOString() });
		expect(assessHolder(justFresh, 'container-b', NOW)).toEqual({ live: true });
	});
});

describe('HostLock', () => {
	it('acquires on a fresh volume and writes a heartbeat', async () => {
		await new HostLock(dataDir, 'host-a').acquire();
		const parsed = parseLockHolder(await fs.readFile(path.join(dataDir, 'host.lock'), 'utf8'));
		expect(parsed?.hostId).toBe('host-a');
		expect(parsed?.heartbeatAt).toBeDefined();
	});

	it('refuses a second host while the heartbeat is fresh', async () => {
		await new HostLock(dataDir, 'host-a').acquire();
		await expect(new HostLock(dataDir, 'host-b').acquire()).rejects.toThrow(HostLockError);
	});

	// The ungraceful-kill path: the previous holder never released.
	it('lets a new host reclaim once the heartbeat goes stale', async () => {
		await new HostLock(dataDir, 'host-a').acquire();
		const muchLater = () => Date.now() + HEARTBEAT_STALE_AFTER_MS + 10_000;
		await expect(new HostLock(dataDir, 'host-b', muchLater).acquire()).resolves.toBeUndefined();
	});

	it('lets the same host id reclaim immediately after an unclean exit', async () => {
		await new HostLock(dataDir, 'host-a').acquire();
		await expect(new HostLock(dataDir, 'host-a').acquire()).resolves.toBeUndefined();
	});

	it('reclaims a corrupted lock rather than deadlocking the host', async () => {
		await fs.writeFile(path.join(dataDir, 'host.lock'), 'garbage', 'utf8');
		await expect(new HostLock(dataDir, 'host-b').acquire()).resolves.toBeUndefined();
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
