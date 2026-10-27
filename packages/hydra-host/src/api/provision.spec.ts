import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isPeerKeyGeneration, peerKeyDirectory } from '../registry/peer-key-directory.js';
import { PortAllocator } from '../registry/ports.js';
import { NodeRegistryStore } from '../registry/store.js';
import { peerTargetRejection } from '../peer-target-policy.js';
import { acknowledgeEscrow, mayDiscloseSecrets, provisionNode, setPeers, type ProvisionDeps } from './provision.js';

const LAYOUT = { peerStart: 5001, apiStart: 4001, monitoringStart: 6001, capacity: 4 };
const REQUEST = {
	idempotencyKey: 'idem-1',
	network: 'preprod' as const,
	contestationPeriodSeconds: 220,
	depositPeriodSeconds: 300,
	unsyncedPeriodSeconds: 1800,
	depositActivationSeconds: 300,
};

let dataDir: string;
let deps: ProvisionDeps;
let counter: number;

beforeEach(async () => {
	dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hydra-host-provision-'));
	counter = 0;
	deps = {
		store: new NodeRegistryStore(dataDir),
		ports: new PortAllocator(LAYOUT),
		advertiseFor: (peerPort) => `hydra1.example.com:${peerPort}`,
		checkPeerTarget: async () => null,
		newNodeId: () => `node-${++counter}`,
		now: () => new Date('2026-07-28T12:00:00.000Z'),
	};
});

afterEach(async () => {
	jest.restoreAllMocks();
	await fs.rm(dataDir, { recursive: true, force: true });
});

describe('provisionNode', () => {
	it('creates an un-started node and discloses its keys once', async () => {
		const result = await provisionNode(REQUEST, deps);

		expect(result.record.state).toBe('PendingEscrow');
		// Must not be running: the payment service has not confirmed it holds the keys.
		expect(result.record.desired).toBe('Stopped');
		expect(result.record.peers).toEqual([]);
		expect(result.secrets?.hydraSigningKey).toContain('HydraSigningKey_ed25519');
		expect(result.secrets?.cardanoSigningKey).toContain('PaymentSigningKeyShelley_ed25519');
		expect(result.replayed).toBe(false);
	});

	it('allocates an aligned port triple and derives the advertise address', async () => {
		const result = await provisionNode(REQUEST, deps);
		expect(result.record.peerPort).toBe(5001);
		expect(result.record.advertise).toBe('hydra1.example.com:5001');
	});

	it('writes key files with owner-only permissions', async () => {
		const result = await provisionNode(REQUEST, deps);
		const keysDir = path.join(deps.store.nodeDir(result.record.nodeId), 'keys');
		for (const file of ['hydra.sk', 'cardano.sk', 'hydra.vk', 'cardano.vk']) {
			const stat = await fs.stat(path.join(keysDir, file));
			expect(stat.mode & 0o077).toBe(0);
		}
	});

	it('returns public material on the record but keeps signing keys out of it', async () => {
		const { record } = await provisionNode(REQUEST, deps);
		expect(record.hydraVerificationKey).toMatch(/^5820[0-9a-f]{64}$/);
		expect(record.cardanoVerificationKey).toMatch(/^5820[0-9a-f]{64}$/);
		expect(JSON.stringify(record)).not.toContain('SigningKey');
	});

	// The lost-response case: without this, a dropped reply would leave a node
	// whose keys exist only on the Host.
	it('replays the same node and the same secrets for a repeated idempotency key', async () => {
		const first = await provisionNode(REQUEST, deps);
		const second = await provisionNode(REQUEST, deps);

		expect(second.replayed).toBe(true);
		expect(second.record.nodeId).toBe(first.record.nodeId);
		expect(second.secrets).toEqual(first.secrets);
		expect(deps.ports.used).toBe(1);
	});

	it('allocates a distinct node for a distinct idempotency key', async () => {
		const first = await provisionNode(REQUEST, deps);
		const second = await provisionNode({ ...REQUEST, idempotencyKey: 'idem-2' }, deps);

		expect(second.record.nodeId).not.toBe(first.record.nodeId);
		expect(second.record.peerPort).toBe(5002);
	});

	// The caller retries a provision whose response was lost, and it does not wait
	// for a response that may still be in flight — so the retry routinely overlaps
	// the original. Two nodes under one key means two ports and two key pairs, of
	// which the caller stores one; the other holds signing keys on disk for a node
	// nobody will ever acknowledge.
	it('provisions once when the same idempotency key arrives concurrently', async () => {
		const [first, second] = await Promise.all([provisionNode(REQUEST, deps), provisionNode(REQUEST, deps)]);

		expect(second.record.nodeId).toBe(first.record.nodeId);
		expect(second.record.peerPort).toBe(first.record.peerPort);
		expect(await deps.store.list()).toHaveLength(1);
		// Both callers are handed key material, and it is the same material.
		expect(second.secrets).toEqual(first.secrets);
		expect([first.replayed, second.replayed]).toEqual([false, true]);
	});

	it('requires an idempotency key', async () => {
		await expect(provisionNode({ ...REQUEST, idempotencyKey: '  ' }, deps)).rejects.toThrow(/Idempotency-Key/);
	});

	it('does not leak a port when provisioning fails', async () => {
		const failing: ProvisionDeps = {
			...deps,
			checkPeerTarget: async () => null,
			newNodeId: () => {
				throw new Error('boom');
			},
		};
		// newNodeId throws before allocation, so nothing is taken.
		await expect(provisionNode(REQUEST, failing)).rejects.toThrow('boom');
		expect(deps.ports.used).toBe(0);
	});

	it('frees the port of a failed provision at once when released ports wait for the firewall', async () => {
		const ports = new PortAllocator(LAYOUT, [], { requirePeerFirewallRefresh: true });
		ports.acknowledgePeerFirewall(ports.peerFirewallGeneration());
		const store = new NodeRegistryStore(dataDir);
		jest.spyOn(store, 'write').mockRejectedValueOnce(new Error('disk full'));

		await expect(provisionNode(REQUEST, { ...deps, store, ports })).rejects.toThrow('disk full');
		// The node never had peers, so the port must not wait for a refresh.
		expect(ports.allocate().peerPort).toBe(LAYOUT.peerStart);
	});

	it('waits for every key write before removing a failed provision', async () => {
		let releaseSlowRename: () => void = () => undefined;
		let announceSlowRename: () => void = () => undefined;
		const slowRenameGate = new Promise<void>((resolve) => {
			releaseSlowRename = resolve;
		});
		const slowRenameStarted = new Promise<void>((resolve) => {
			announceSlowRename = resolve;
		});
		let slowWriterSettled = false;
		let removedBeforeWriterSettled = false;
		const originalRename = fs.rename;
		jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
			if (to.toString().endsWith('/hydra.sk')) {
				announceSlowRename();
				await slowRenameGate;
				try {
					return await originalRename(from, to);
				} finally {
					slowWriterSettled = true;
				}
			}
			if (to.toString().endsWith('/cardano.sk')) {
				await slowRenameStarted;
				throw new Error('injected cardano key write failure');
			}
			return await originalRename(from, to);
		});
		const store = new NodeRegistryStore(dataDir);
		const originalRemove = store.remove.bind(store);
		jest.spyOn(store, 'remove').mockImplementation(async (nodeId) => {
			removedBeforeWriterSettled = !slowWriterSettled;
			return await originalRemove(nodeId);
		});

		const failed = provisionNode(REQUEST, { ...deps, store });
		await slowRenameStarted;
		await new Promise<void>((resolve) => setImmediate(resolve));
		releaseSlowRename();
		await expect(failed).rejects.toThrow('injected cardano key write failure');
		expect(removedBeforeWriterSettled).toBe(false);
		expect(await fs.readdir(path.join(dataDir, 'nodes'))).toEqual([]);
	});

	it('removes signing keys even when removing the whole failed node directory fails', async () => {
		const store = new NodeRegistryStore(dataDir);
		jest.spyOn(store, 'write').mockRejectedValueOnce(new Error('disk full'));
		jest.spyOn(store, 'remove').mockRejectedValueOnce(new Error('registry cleanup failed'));

		await expect(provisionNode(REQUEST, { ...deps, store })).rejects.toThrow('disk full');
		await expect(fs.access(path.join(store.nodeDir('node-1'), 'keys'))).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('refuses once every slot is in use', async () => {
		for (let i = 0; i < LAYOUT.capacity; i++) {
			await provisionNode({ ...REQUEST, idempotencyKey: `idem-${i}` }, deps);
		}
		await expect(provisionNode({ ...REQUEST, idempotencyKey: 'one-too-many' }, deps)).rejects.toThrow(
			/add another host/,
		);
	});

	// A replay must be a replay of the SAME request. Silently returning a node
	// provisioned with a different deposit-activation window would leave the
	// caller believing it configured something it did not — same reasoning as
	// the other three periods, extended to this one.
	it('409s a replayed idempotency key carrying a different depositActivationSeconds', async () => {
		await provisionNode(REQUEST, deps);
		await expect(
			provisionNode({ ...REQUEST, depositActivationSeconds: REQUEST.depositActivationSeconds + 1 }, deps),
		).rejects.toThrow(/depositActivationSeconds/);
	});

	// I-1 regression: a node record persisted by a Host build from before
	// depositActivationSeconds existed has none on disk. Without normalizing it
	// at read time, the mismatch check above would compare `undefined` against
	// the concrete number every request always carries and 409 EVERY replay of
	// such a record — and for a redeem-invite retry the idempotency key is the
	// invite nonce itself (fixed by the invite, not chosen per attempt), so a
	// downstream failure after a successful-but-legacy provision could never be
	// retried: it would burn the nonce and strand a funded node on both sides.
	it('replays successfully against a legacy record persisted without depositActivationSeconds', async () => {
		const { record } = await provisionNode(REQUEST, deps);

		// Simulate a record written before this field existed.
		const nodeFile = path.join(deps.store.nodeDir(record.nodeId), 'node.json');
		const raw = JSON.parse(await fs.readFile(nodeFile, 'utf8')) as Record<string, unknown>;
		delete raw.depositActivationSeconds;
		await fs.writeFile(nodeFile, JSON.stringify(raw), 'utf8');

		const replay = await provisionNode(REQUEST, deps);

		expect(replay.replayed).toBe(true);
		expect(replay.record.nodeId).toBe(record.nodeId);
		expect(replay.record.depositActivationSeconds).toBe(REQUEST.depositActivationSeconds);
	});
});

describe('acknowledgeEscrow', () => {
	it('seals disclosure and hands the node to the supervisor', async () => {
		const { record } = await provisionNode(REQUEST, deps);
		const acked = await acknowledgeEscrow(record.nodeId, deps);

		expect(acked.escrowAckedAt).not.toBeNull();
		expect(acked.state).toBe('Stopped');
		expect(acked.desired).toBe('Running');
		expect(mayDiscloseSecrets(acked)).toBe(false);
	});

	// After acknowledgement the keys are sealed: a replayed provision returns the
	// node but never the material again.
	it('stops a replayed provision from returning secrets', async () => {
		const { record } = await provisionNode(REQUEST, deps);
		await acknowledgeEscrow(record.nodeId, deps);

		const replay = await provisionNode(REQUEST, deps);
		expect(replay.replayed).toBe(true);
		expect(replay.secrets).toBeNull();
	});

	it('is idempotent', async () => {
		const { record } = await provisionNode(REQUEST, deps);
		const first = await acknowledgeEscrow(record.nodeId, deps);
		const second = await acknowledgeEscrow(record.nodeId, deps);
		expect(second.escrowAckedAt).toBe(first.escrowAckedAt);
	});

	it('preserves a live node when an acknowledgment completes before a queued duplicate', async () => {
		const { record } = await provisionNode(REQUEST, deps);
		const update = deps.store.update.bind(deps.store);
		const acknowledgedAt = '2026-07-28T12:00:01.000Z';
		jest.spyOn(deps.store, 'update').mockImplementationOnce(async (nodeId, mutate) => {
			// Another acknowledgment and the supervisor claim land before this mutation.
			await update(nodeId, (current) => ({
				...current,
				escrowAckedAt: acknowledgedAt,
				state: 'Starting',
				desired: 'Running',
				pid: 1234,
			}));
			return update(nodeId, mutate);
		});

		const duplicate = await acknowledgeEscrow(record.nodeId, deps);
		expect(duplicate).toMatchObject({ state: 'Starting', pid: 1234, escrowAckedAt: acknowledgedAt });
		await expect(
			setPeers(
				record.nodeId,
				[{ advertise: 'other.example.com:5001', hydraVerificationKey: '5820aa', cardanoVerificationKey: '5820bb' }],
				deps,
			),
		).rejects.toMatchObject({ status: 409 });
	});

	it.each([
		['127.0.0.1', /non-public address/],
		['2606:4700:4700::1111', /does not resolve to an IPv4 address/],
	])('refuses peer DNS result %s before persisting peers or key files', async (address, reason) => {
		const { record } = await provisionNode(REQUEST, deps);
		const policyDeps = {
			...deps,
			checkPeerTarget: async (advertise: string) =>
				await peerTargetRejection(advertise, {
					allowPrivate: false,
					resolve: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
				}),
		};

		await expect(
			setPeers(
				record.nodeId,
				[{ advertise: 'peer.example.com:5001', hydraVerificationKey: '5820aa', cardanoVerificationKey: '5820bb' }],
				policyDeps,
			),
		).rejects.toMatchObject({
			status: 400,
			message: expect.stringMatching(reason),
		});
		expect((await deps.store.read(record.nodeId))?.peers).toEqual([]);
		expect(await fs.readdir(path.join(deps.store.nodeDir(record.nodeId), 'peers'))).toEqual([]);
	});

	it('404s for an unknown node', async () => {
		await expect(acknowledgeEscrow('missing', deps)).rejects.toMatchObject({ status: 404 });
	});
});

describe('setPeers', () => {
	const peer = {
		advertise: 'hydra2.example.com:5001',
		hydraVerificationKey: `5820${'ab'.repeat(32)}`,
		cardanoVerificationKey: `5820${'cd'.repeat(32)}`,
	};

	it('records peers and writes their verification key files', async () => {
		const { record } = await provisionNode(REQUEST, deps);
		const updated = await setPeers(record.nodeId, [peer], deps);

		expect(updated.peers).toEqual([peer]);
		const peersDir = peerKeyDirectory(deps.store.nodeDir(record.nodeId), updated.peerKeysGeneration);
		await expect(fs.readFile(path.join(peersDir, '0-hydra.vk'), 'utf8')).resolves.toContain(
			'HydraVerificationKey_ed25519',
		);
		await expect(fs.readFile(path.join(peersDir, '0-cardano.vk'), 'utf8')).resolves.toContain(
			'PaymentVerificationKeyShelley_ed25519',
		);
	});

	it('preserves the recorded peer keys when the node record write fails', async () => {
		const { record } = await provisionNode(REQUEST, deps);
		await setPeers(record.nodeId, [peer], deps);
		const previous = await deps.store.read(record.nodeId);
		const peersDir = peerKeyDirectory(deps.store.nodeDir(record.nodeId), previous?.peerKeysGeneration);
		const hydraKeyFile = path.join(peersDir, '0-hydra.vk');
		const cardanoKeyFile = path.join(peersDir, '0-cardano.vk');
		const oldHydraKey = await fs.readFile(hydraKeyFile, 'utf8');
		const oldCardanoKey = await fs.readFile(cardanoKeyFile, 'utf8');
		const replacement = {
			advertise: 'hydra3.example.com:5001',
			hydraVerificationKey: `5820${'ef'.repeat(32)}`,
			cardanoVerificationKey: `5820${'12'.repeat(32)}`,
		};

		const rename = fs.rename;
		let rejected = false;
		jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
			if (!rejected && String(to).endsWith('/node.json')) {
				rejected = true;
				throw new Error('injected node record write failure');
			}
			await rename(from, to);
		});

		await expect(setPeers(record.nodeId, [replacement], deps)).rejects.toThrow('injected node record write failure');
		expect(rejected).toBe(true);
		const persisted = await deps.store.read(record.nodeId);
		expect(persisted?.peers).toEqual([peer]);
		expect(persisted?.peerKeysGeneration).toBe(previous?.peerKeysGeneration);
		await expect(fs.readFile(hydraKeyFile, 'utf8')).resolves.toBe(oldHydraKey);
		await expect(fs.readFile(cardanoKeyFile, 'utf8')).resolves.toBe(oldCardanoKey);
		const generationNames = (await fs.readdir(path.join(deps.store.nodeDir(record.nodeId), 'peers'))).filter(
			isPeerKeyGeneration,
		);
		const failedGeneration = generationNames.find((name) => name !== previous?.peerKeysGeneration);
		expect(failedGeneration).toBeDefined();
		jest.restoreAllMocks();
		await setPeers(record.nodeId, [replacement], deps);
		const remaining = (await fs.readdir(path.join(deps.store.nodeDir(record.nodeId), 'peers'))).filter(
			isPeerKeyGeneration,
		);
		expect(remaining).not.toContain(failedGeneration);
		expect(remaining).toHaveLength(2);
	});

	it('waits for every peer key write to finish when one peer key write fails', async () => {
		const { record } = await provisionNode(REQUEST, deps);
		await setPeers(record.nodeId, [peer], deps);
		const replacement = { ...peer, advertise: 'hydra3.example.com:5001' };
		const second = {
			advertise: 'hydra4.example.com:5001',
			hydraVerificationKey: `5820${'ef'.repeat(32)}`,
			cardanoVerificationKey: `5820${'12'.repeat(32)}`,
		};
		let releaseBlockedRename: () => void = () => undefined;
		let announceBlockedRename: () => void = () => undefined;
		let announceFailedRename: () => void = () => undefined;
		const blockedRename = new Promise<void>((resolve) => {
			releaseBlockedRename = resolve;
		});
		const blockedRenameStarted = new Promise<void>((resolve) => {
			announceBlockedRename = resolve;
		});
		const failedRenameStarted = new Promise<void>((resolve) => {
			announceFailedRename = resolve;
		});
		let announceAllKeyRenames: () => void = () => undefined;
		const allKeyRenamesStarted = new Promise<void>((resolve) => {
			announceAllKeyRenames = resolve;
		});
		let keyRenameCount = 0;
		const pendingKeyRenames: Promise<void>[] = [];
		const rename = fs.rename;
		jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
			const destination = String(to);
			if (/[01]-(hydra|cardano)\.vk$/.test(destination)) {
				keyRenameCount += 1;
				if (keyRenameCount === 4) announceAllKeyRenames();
			}
			const operation = (async () => {
				if (destination.endsWith('/0-hydra.vk')) {
					announceBlockedRename();
					await blockedRename;
				}
				if (destination.endsWith('/1-hydra.vk')) {
					await blockedRenameStarted;
					announceFailedRename();
					throw new Error('injected peer key write failure');
				}
				await rename(from, to);
			})();
			if (/[01]-(hydra|cardano)\.vk$/.test(destination)) pendingKeyRenames.push(operation);
			await operation;
		});

		let hasSettled = false;
		const result = setPeers(record.nodeId, [replacement, second], deps).then(
			() => new Error('peer update unexpectedly succeeded'),
			(error: unknown) => error,
		);
		void result.then(() => {
			hasSettled = true;
		});
		try {
			await blockedRenameStarted;
			await failedRenameStarted;
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(hasSettled).toBe(false);
		} finally {
			releaseBlockedRename();
			await allKeyRenamesStarted;
			await Promise.allSettled(pendingKeyRenames);
		}
		expect(await result).toMatchObject({ message: 'injected peer key write failure' });
		expect((await deps.store.read(record.nodeId))?.peers).toEqual([peer]);
	});

	it('does not follow a legacy peer key symlink when writing a new generation', async () => {
		const { record } = await provisionNode(REQUEST, deps);
		const legacyPeersDir = path.join(deps.store.nodeDir(record.nodeId), 'peers');
		const target = path.join(dataDir, 'outside-peer-key.txt');
		await fs.writeFile(target, 'unchanged');
		await fs.symlink(target, path.join(legacyPeersDir, '0-hydra.vk'));

		const updated = await setPeers(record.nodeId, [peer], deps);
		const peersDir = peerKeyDirectory(deps.store.nodeDir(record.nodeId), updated.peerKeysGeneration);

		await expect(fs.readFile(target, 'utf8')).resolves.toBe('unchanged');
		await expect(fs.readFile(path.join(peersDir, '0-hydra.vk'), 'utf8')).resolves.toContain(peer.hydraVerificationKey);
		expect((await fs.lstat(path.join(peersDir, '0-hydra.vk'))).isSymbolicLink()).toBe(false);
	});

	it('rejects a symlinked parent peer directory before writing keys', async () => {
		const { record } = await provisionNode(REQUEST, deps);
		const peersDir = path.join(deps.store.nodeDir(record.nodeId), 'peers');
		const outside = path.join(dataDir, 'outside');
		await fs.mkdir(outside);
		await fs.rmdir(peersDir);
		await fs.symlink(outside, peersDir);

		await expect(setPeers(record.nodeId, [peer], deps)).rejects.toThrow(/symlink/);
		expect((await deps.store.read(record.nodeId))?.peers).toEqual([]);
		expect(await fs.readdir(outside)).toEqual([]);
	});

	it('bounds retained peer key generations across repeated updates', async () => {
		const { record } = await provisionNode(REQUEST, deps);
		const peersDir = path.join(deps.store.nodeDir(record.nodeId), 'peers');
		let firstGeneration: string | undefined;
		for (let index = 0; index < 4; index++) {
			const updated = await setPeers(
				record.nodeId,
				[{ ...peer, advertise: `hydra${index + 2}.example.com:5001` }],
				deps,
			);
			if (index === 0) firstGeneration = updated.peerKeysGeneration;
			const generations = (await fs.readdir(peersDir)).filter(isPeerKeyGeneration);
			expect(generations).toContain(updated.peerKeysGeneration);
			expect(generations).toHaveLength(Math.min(index + 1, 2));
		}
		expect((await fs.readdir(peersDir)).filter(isPeerKeyGeneration)).not.toContain(firstGeneration);
	});

	it('refuses an empty peer set, self-peering and duplicates', async () => {
		const { record } = await provisionNode(REQUEST, deps);

		await expect(setPeers(record.nodeId, [], deps)).rejects.toThrow(/at least one peer/);
		await expect(setPeers(record.nodeId, [{ ...peer, advertise: record.advertise }], deps)).rejects.toThrow(
			/its own advertise address/,
		);
		await expect(setPeers(record.nodeId, [peer, peer], deps)).rejects.toThrow(/duplicate/);
	});

	it('refuses a peer address containing nftables syntax before persisting it', async () => {
		const { record } = await provisionNode(REQUEST, deps);
		const injected = { ...peer, advertise: 'peer.example:5001 } accept\n}\nflush ruleset\n# :5101' };

		await expect(setPeers(record.nodeId, [injected], deps)).rejects.toThrow(/valid host:port/);
		expect((await deps.store.read(record.nodeId))?.peers).toEqual([]);
	});

	it('404s for an unknown node', async () => {
		await expect(setPeers('missing', [peer], deps)).rejects.toMatchObject({ status: 404 });
	});

	// Two peer changes can overlap. The node queue must publish one complete
	// generation at a time, so the final record selects files from one update.
	it('leaves the directory agreeing with the record when two peer changes overlap', async () => {
		const { record } = await provisionNode(REQUEST, deps);
		const second = {
			advertise: 'hydra3.example.com:5001',
			hydraVerificationKey: `5820${'ef'.repeat(32)}`,
			cardanoVerificationKey: `5820${'12'.repeat(32)}`,
		};

		const [a, b] = await Promise.all([
			setPeers(record.nodeId, [peer, second], deps),
			setPeers(record.nodeId, [peer], deps),
		]);

		const stored = await deps.store.read(record.nodeId);
		const peersDir = peerKeyDirectory(deps.store.nodeDir(record.nodeId), stored?.peerKeysGeneration);
		const files = (await fs.readdir(peersDir)).sort();
		// Whichever landed last, the files present are exactly the ones its peer
		// list names — no orphan index, no missing one.
		const expected =
			stored?.peers.length === 2
				? ['0-cardano.vk', '0-hydra.vk', '1-cardano.vk', '1-hydra.vk']
				: ['0-cardano.vk', '0-hydra.vk'];
		expect(files).toEqual(expected);
		expect([a.peers.length, b.peers.length].sort()).toEqual([1, 2]);
	});
});
