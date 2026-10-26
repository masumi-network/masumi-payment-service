import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
	HEARTBEAT_STALE_AFTER_MS,
	HEARTBEAT_INTERVAL_MS,
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
		acquiredAt: new Date(NOW - 180_000).toISOString(),
		heartbeatAt: new Date(NOW - 1_000).toISOString(),
		...overrides,
	};
}

let dataDir: string;

beforeEach(async () => {
	dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hydra-host-lock-'));
});

afterEach(async () => {
	jest.restoreAllMocks();
	jest.useRealTimers();
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

	// The two-contender case above only *sometimes* interleaved so that the
	// loser renamed the winner's fresh lease out of the way and installed its
	// own — which is two hosts writing one volume, i.e. a duplicate hydra-node
	// for every node on it. A crowd makes that interleaving reliable.
	it('lets exactly one of a crowd of contenders reclaim a stale lease', async () => {
		await new HostLock(dataDir, 'host-a').acquire();
		const muchLater = () => Date.now() + HEARTBEAT_STALE_AFTER_MS + 10_000;
		const contenders = ['b', 'c', 'd', 'e', 'f', 'g'].map(
			(suffix) => new HostLock(dataDir, `host-${suffix}`, muchLater),
		);

		const results = await Promise.allSettled(contenders.map((lock) => lock.acquire()));

		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		const holder = await currentHolder();
		expect(holder?.hostId).not.toBe('host-a');
	});

	it('refuses a corrupted legacy file instead of assuming its owner is dead', async () => {
		await fs.writeFile(path.join(dataDir, 'host.lock'), 'garbage', 'utf8');
		await expect(new HostLock(dataDir, 'host-b').acquire()).rejects.toThrow(HostLockError);
		expect(await fs.readFile(path.join(dataDir, 'host.lock'), 'utf8')).toBe('garbage');
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

describe('takeover gate exclusion', () => {
	it('does not reclaim a paused contender gate and replace the successor lease', async () => {
		const lockPath = path.join(dataDir, 'host.lock');
		const gatePath = path.join(dataDir, 'host.lock.takeover');
		await fs.writeFile(
			lockPath,
			JSON.stringify(holder({ heartbeatAt: new Date(NOW - HEARTBEAT_STALE_AFTER_MS - 1).toISOString() })),
		);
		let entered!: () => void;
		let resume!: () => void;
		const paused = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const resumed = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const rename = fs.rename.bind(fs);
		let didPause = false;
		jest.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
			if (!didPause && source === lockPath && String(destination).startsWith(lockPath + '.stale.')) {
				didPause = true;
				entered();
				await resumed;
			}
			await rename(source, destination);
		});
		const first = new HostLock(dataDir, 'paused-host', () => NOW);
		const second = new HostLock(dataDir, 'contender-host', () => NOW);
		const firstAcquisition = first.acquire();
		try {
			await paused;
			const old = new Date(Date.now() - 60_000);
			await fs.utimes(gatePath, old, old);
			const secondOutcome = await second.acquire().then(
				() => 'acquired',
				(error: unknown) => error,
			);
			resume();
			await firstAcquisition;
			expect(secondOutcome).toBeInstanceOf(HostLockError);
			expect((await currentHolder())?.hostId).toBe('paused-host');
		} finally {
			resume();
			await firstAcquisition.catch(() => undefined);
			await first.release();
			await second.release();
		}
	});

	it('fails closed for a crash-left gate and names the manual recovery precondition', async () => {
		const gatePath = path.join(dataDir, 'host.lock.takeover');
		await fs.mkdir(gatePath);
		const old = new Date(Date.now() - 60_000);
		await fs.utimes(gatePath, old, old);
		const lock = new HostLock(dataDir, 'host-a');
		try {
			await expect(lock.acquire()).rejects.toThrow(/stop all.*Host.*contender/i);
			expect((await fs.stat(gatePath)).isDirectory()).toBe(true);
			expect(await fs.readdir(dataDir)).toEqual(['host.lock.takeover']);
		} finally {
			await lock.release();
		}
	});
});

describe('unreadable lease evidence', () => {
	const TOKEN = 'existing-owner';
	async function directoryLease() {
		const directory = path.join(dataDir, 'host.lock');
		await fs.mkdir(directory);
		const ownerPath = path.join(directory, 'owner.json');
		const heartbeatPath = path.join(directory, `heartbeat.${TOKEN}`);
		await fs.writeFile(
			ownerPath,
			JSON.stringify(holder({ ownerToken: TOKEN, acquiredAt: new Date(NOW - 120_000).toISOString() })),
		);
		await fs.writeFile(heartbeatPath, new Date(NOW).toISOString());
		return { directory, ownerPath, heartbeatPath };
	}

	it.each(['ownerPath', 'heartbeatPath'] as const)(
		'retains an existing owner when %s fails with real EACCES',
		async (file) => {
			const fixture = await directoryLease();
			await fs.chmod(fixture[file], 0);
			try {
				await expect(fs.readFile(fixture[file], 'utf8')).rejects.toMatchObject({ code: 'EACCES' });
				await expect(new HostLock(dataDir, 'contender', () => NOW).acquire()).rejects.toThrow(HostLockError);
			} finally {
				await fs.chmod(fixture[file], 0o600).catch(() => undefined);
			}
			expect(parseLockHolder(await fs.readFile(fixture.ownerPath, 'utf8'))?.hostId).toBe('container-a');
		},
	);

	it.each(['owner', 'heartbeat', 'release-marker'] as const)(
		'blocks takeover on an injected %s EIO without moving the lease',
		async (file) => {
			const fixture = await directoryLease();
			const read = fs.readFile.bind(fs);
			const access = fs.access.bind(fs);
			if (file === 'release-marker') {
				await fs.writeFile(fixture.heartbeatPath, new Date(NOW - 120_000).toISOString());
				jest.spyOn(fs, 'access').mockImplementation(async (target, mode) => {
					if (target === path.join(fixture.directory, `released.${TOKEN}`))
						throw Object.assign(new Error('I/O failure'), { code: 'EIO' });
					await access(target, mode);
				});
			} else {
				const targetPath = file === 'owner' ? fixture.ownerPath : fixture.heartbeatPath;
				jest.spyOn(fs, 'readFile').mockImplementation(((
					target: Parameters<typeof fs.readFile>[0],
					options: Parameters<typeof fs.readFile>[1],
				) => {
					if (target === targetPath) return Promise.reject(Object.assign(new Error('I/O failure'), { code: 'EIO' }));
					return read(target, options);
				}) as typeof fs.readFile);
			}
			await expect(new HostLock(dataDir, 'contender', () => NOW).acquire()).rejects.toThrow(HostLockError);
			expect(JSON.parse(await read(fixture.ownerPath, 'utf8')).hostId).toBe('container-a');
		},
	);

	it.each([
		'missing owner',
		'malformed owner',
		'missing heartbeat',
		'empty heartbeat',
		'malformed heartbeat',
		'truncated heartbeat',
	])('blocks takeover with %s', async (scenario) => {
		const fixture = await directoryLease();
		if (scenario === 'missing owner') await fs.rm(fixture.ownerPath);
		if (scenario === 'malformed owner') await fs.writeFile(fixture.ownerPath, '{');
		if (scenario === 'missing heartbeat') await fs.rm(fixture.heartbeatPath);
		if (scenario === 'empty heartbeat') await fs.writeFile(fixture.heartbeatPath, '');
		if (scenario === 'malformed heartbeat') await fs.writeFile(fixture.heartbeatPath, 'not a date');
		if (scenario === 'truncated heartbeat') await fs.writeFile(fixture.heartbeatPath, '2026');
		await expect(new HostLock(dataDir, 'contender', () => NOW).acquire()).rejects.toThrow(HostLockError);
		expect(await fs.readdir(dataDir)).toEqual(['host.lock']);
	});

	it('rejects malformed legacy dates but preserves valid stale legacy takeover', async () => {
		const lockPath = path.join(dataDir, 'host.lock');
		await fs.writeFile(lockPath, JSON.stringify(holder({ acquiredAt: 'invalid', heartbeatAt: 'invalid' })));
		await expect(new HostLock(dataDir, 'contender', () => NOW).acquire()).rejects.toThrow(HostLockError);
		await fs.writeFile(lockPath, JSON.stringify(holder({ heartbeatAt: new Date(NOW - 120_000).toISOString() })));
		const replacement = new HostLock(dataDir, 'contender', () => NOW);
		try {
			await replacement.acquire();
			expect((await currentHolder())?.hostId).toBe('contender');
		} finally {
			await replacement.release();
		}
	});

	it('does not treat future acquisition time with an older heartbeat as a stale lease', async () => {
		await fs.writeFile(
			path.join(dataDir, 'host.lock'),
			JSON.stringify(
				holder({
					acquiredAt: new Date(NOW + 120_000).toISOString(),
					heartbeatAt: new Date(NOW - 120_000).toISOString(),
				}),
			),
		);
		await expect(new HostLock(dataDir, 'contender', () => NOW).acquire()).rejects.toThrow(HostLockError);
	});
});

it('does not confuse an I/O failure during the second lease stat with disappearance', async () => {
	const lockPath = path.join(dataDir, 'host.lock');
	await fs.writeFile(lockPath, JSON.stringify(holder()));
	const lstat = fs.lstat.bind(fs);
	let reads = 0;
	jest.spyOn(fs, 'lstat').mockImplementation(((
		target: Parameters<typeof fs.lstat>[0],
		options: Parameters<typeof fs.lstat>[1],
	) => {
		if (target === lockPath && ++reads === 2)
			return Promise.reject(Object.assign(new Error('I/O failure'), { code: 'EIO' }));
		return lstat(target, options);
	}) as typeof fs.lstat);
	await expect(new HostLock(dataDir, 'contender', () => NOW).acquire()).rejects.toThrow(HostLockError);
	expect(parseLockHolder(await fs.readFile(lockPath, 'utf8'))?.hostId).toBe('container-a');
});

it('fences the holder when its ownership evidence becomes unreadable', async () => {
	jest.useFakeTimers();
	let signalLost!: () => void;
	const lost = new Promise<void>((resolve) => {
		signalLost = resolve;
	});
	const onLeaseLost = jest.fn(() => signalLost());
	const lock = new HostLock(dataDir, 'host-a', () => NOW, onLeaseLost);
	await lock.acquire();
	const ownerPath = path.join(dataDir, 'host.lock', 'owner.json');
	await fs.chmod(ownerPath, 0);
	try {
		await jest.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
		await lost;
		expect(onLeaseLost).toHaveBeenCalledTimes(1);
	} finally {
		await fs.chmod(ownerPath, 0o600);
		await lock.release();
	}
});

it.each([
	['heartbeatAt', 42],
	['heartbeatAt', null],
	['heartbeatAt', {}],
	['heartbeatAt', []],
	['heartbeatAt', false],
	['ownerToken', 42],
	['ownerToken', null],
	['ownerToken', {}],
	['ownerToken', ''],
	['ownerToken', '..'],
	['ownerToken', 'bad/token'],
])('refuses a legacy lease with a present malformed %s value %p', async (field, value) => {
	const lockPath = path.join(dataDir, 'host.lock');
	const raw = JSON.stringify({
		...holder({ heartbeatAt: new Date(NOW - 120_000).toISOString() }),
		[field as string]: value,
	});
	await fs.writeFile(lockPath, raw);
	await expect(new HostLock(dataDir, 'contender', () => NOW).acquire()).rejects.toThrow(HostLockError);
	expect(await fs.readFile(lockPath, 'utf8')).toBe(raw);
});

it('accepts a valid stale legacy lease with genuinely absent optional fields', async () => {
	await fs.writeFile(
		path.join(dataDir, 'host.lock'),
		JSON.stringify({ pid: 1, hostId: 'legacy', acquiredAt: new Date(NOW - 180_000).toISOString() }),
	);
	const lock = new HostLock(dataDir, 'contender', () => NOW);
	try {
		await lock.acquire();
		expect((await currentHolder())?.hostId).toBe('contender');
	} finally {
		await lock.release();
	}
});
