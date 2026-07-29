import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HostLock, HostLockError, isHolderAlive, parseLockHolder } from './host-lock.js';

let dataDir: string;

beforeEach(async () => {
	dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hydra-host-lock-'));
});

afterEach(async () => {
	await fs.rm(dataDir, { recursive: true, force: true });
});

const alive = () => true;
const dead = () => false;

describe('parseLockHolder', () => {
	it('reads a well-formed holder', () => {
		expect(parseLockHolder('{"pid":42,"hostId":"h1","acquiredAt":"2026-07-28T00:00:00.000Z"}')).toEqual({
			pid: 42,
			hostId: 'h1',
			acquiredAt: '2026-07-28T00:00:00.000Z',
		});
	});

	it('returns null for junk or incomplete content', () => {
		expect(parseLockHolder('not json')).toBeNull();
		expect(parseLockHolder('{"pid":42}')).toBeNull();
		expect(parseLockHolder('[]')).toBeNull();
	});
});

describe('isHolderAlive', () => {
	it('treats a non-positive pid as dead regardless of the probe', () => {
		expect(isHolderAlive({ pid: 0, hostId: 'h', acquiredAt: 'x' }, alive)).toBe(false);
	});
});

describe('HostLock', () => {
	it('acquires on a fresh volume', async () => {
		await new HostLock(dataDir, 'host-a', dead).acquire();
		await expect(fs.stat(path.join(dataDir, 'host.lock'))).resolves.toBeDefined();
	});

	// The failure this prevents is two hosts spawning duplicate hydra-nodes for
	// the same records, which cannot be untangled without operator work.
	it('refuses to boot while a live host holds the lock', async () => {
		await new HostLock(dataDir, 'host-a', alive).acquire();
		await expect(new HostLock(dataDir, 'host-b', alive).acquire()).rejects.toThrow(HostLockError);
		await expect(new HostLock(dataDir, 'host-b', alive).acquire()).rejects.toThrow(/already holds/);
	});

	it('reclaims a lock whose holder is gone', async () => {
		await new HostLock(dataDir, 'host-a', alive).acquire();
		// Same file, but the previous pid no longer exists.
		await expect(new HostLock(dataDir, 'host-b', dead).acquire()).resolves.toBeUndefined();
	});

	it('reclaims a corrupted lock file rather than deadlocking the host', async () => {
		await fs.writeFile(path.join(dataDir, 'host.lock'), 'garbage', 'utf8');
		await expect(new HostLock(dataDir, 'host-b', alive).acquire()).resolves.toBeUndefined();
	});

	it('releases so a later host can acquire', async () => {
		const lock = new HostLock(dataDir, 'host-a', alive);
		await lock.acquire();
		await lock.release();
		await expect(new HostLock(dataDir, 'host-b', alive).acquire()).resolves.toBeUndefined();
	});

	it('is safe to release when not held', async () => {
		await expect(new HostLock(dataDir, 'host-a', alive).release()).resolves.toBeUndefined();
	});
});
