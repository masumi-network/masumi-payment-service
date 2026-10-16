import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExchangeStore } from '../registry/exchange-store.js';
import { NodeRegistryStore } from '../registry/store.js';
import { PortAllocator } from '../registry/ports.js';
import { acknowledgeEscrow, provisionNode, type ProvisionDeps } from './provision.js';
import { createRedemptionRecovery } from './redemption-recovery.js';

const material = {
	walletAddress: 'addr_test1them',
	hydraVerificationKey: `5820${'11'.repeat(32)}`,
	cardanoVerificationKey: `5820${'22'.repeat(32)}`,
	advertise: 'them.example.com:5101',
	exchangeUrl: 'https://them.example.com/exchange',
};
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
let dataDir: string;
let deps: ProvisionDeps;
let exchange: ExchangeStore;

beforeEach(async () => {
	dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hydra-redemption-recovery-'));
	deps = {
		store: new NodeRegistryStore(dataDir),
		ports: new PortAllocator({ peerStart: 5001, apiStart: 4001, monitoringStart: 6001, capacity: 4 }),
		advertiseFor: (port) => `ours.example.com:${port}`,
		newNodeId: () => 'node-1',
		now: () => new Date(),
	};
	await provisionNode(
		{
			idempotencyKey: 'idem-1',
			network: 'preprod',
			contestationPeriodSeconds: 220,
			depositPeriodSeconds: 300,
			depositActivationSeconds: 300,
			unsyncedPeriodSeconds: 1800,
		},
		deps,
	);
	await acknowledgeEscrow('node-1', deps);
	exchange = new ExchangeStore(dataDir);
	await exchange.registerInvite({
		nonce: 'nonce-pending',
		hostNodeId: 'node-1',
		issuedAt: Date.now(),
		expiresAt: Date.now() + 60_000,
		redeemedAt: null,
		redeemer: null,
		redeemerSignature: null,
		startError: null,
	});
	await exchange.redeem('nonce-pending', material, { signature: 'sig', key: 'key' });
});
afterEach(async () => {
	jest.restoreAllMocks();
	await fs.rm(dataDir, { recursive: true, force: true });
});

describe('durable redemption recovery', () => {
	it('logs a failed exchange read without blocking supervision and permits the next retry', async () => {
		jest.spyOn(exchange, 'listInvites').mockRejectedValueOnce(new Error('exchange is temporarily unreadable'));
		const recover = createRedemptionRecovery(exchange, deps, logger);
		await expect(recover()).resolves.toBeUndefined();
		expect(logger.error).toHaveBeenCalledWith(
			'[exchange] redemption recovery failed: exchange is temporarily unreadable',
		);
		await recover();
		expect((await deps.store.read('node-1'))?.peers).toHaveLength(1);
	});
	it('configures a persisted redemption after the host restarts before setup', async () => {
		const restarted = new ExchangeStore(dataDir);
		await createRedemptionRecovery(restarted, deps, logger)();
		const node = await deps.store.read('node-1');
		expect(node?.peers).toEqual([
			{
				advertise: material.advertise,
				hydraVerificationKey: material.hydraVerificationKey,
				cardanoVerificationKey: material.cardanoVerificationKey,
			},
		]);
		expect(node?.desired).toBe('Running');
		expect(await fs.readFile(path.join(deps.store.nodeDir('node-1'), 'peers/0-hydra.vk'), 'utf8')).toContain(
			material.hydraVerificationKey,
		);
		expect(await restarted.forgetInvite('nonce-pending', deps.store)).toBe(true);
	});

	it('retries a transient setup failure and clears the recorded error', async () => {
		const write = jest
			.spyOn(deps.store, 'updateAsync')
			.mockRejectedValueOnce(new Error('disk temporarily unavailable'));
		const recover = createRedemptionRecovery(exchange, deps, logger);
		await recover();
		expect((await exchange.listInvites())[0].startError).toBe('disk temporarily unavailable');
		expect((await deps.store.read('node-1'))?.peers).toEqual([]);
		expect(await exchange.forgetInvite('nonce-pending', deps.store)).toBe(false);
		await recover();
		expect(write).toHaveBeenCalledTimes(2);
		expect((await exchange.listInvites())[0].startError).toBeNull();
		expect((await deps.store.read('node-1'))?.peers).toHaveLength(1);
	});

	it('does not touch peer files or restart a node after setup already completed', async () => {
		await createRedemptionRecovery(exchange, deps, logger)();
		await deps.store.update('node-1', (node) => ({ ...node, state: 'Running', desired: 'Stopped', pid: 123 }));
		const update = jest.spyOn(deps.store, 'updateAsync');
		await createRedemptionRecovery(new ExchangeStore(dataDir), deps, logger)();
		expect(update).not.toHaveBeenCalled();
		expect((await deps.store.read('node-1'))?.desired).toBe('Stopped');
	});

	it('preserves a stop requested before recovery and ignores removal requests', async () => {
		await deps.store.update('node-1', (node) => ({ ...node, desired: 'Stopped' }));
		await createRedemptionRecovery(exchange, deps, logger)();
		expect((await deps.store.read('node-1'))?.desired).toBe('Stopped');
		await deps.store.update('node-1', (node) => ({ ...node, peers: [], state: 'Removing', removalRequested: true }));
		const update = jest.spyOn(deps.store, 'updateAsync');
		await createRedemptionRecovery(exchange, deps, logger)();
		expect(update).not.toHaveBeenCalled();
	});

	it('shares one recovery attempt when redemption and interval ticks overlap', async () => {
		const update = jest.spyOn(deps.store, 'updateAsync');
		const recover = createRedemptionRecovery(exchange, deps, logger);
		await Promise.all([recover(), recover(), recover()]);
		expect(update).toHaveBeenCalledTimes(1);
	});

	it('preserves peers configured after recovery reads the reservation', async () => {
		const manualPeers = [
			{
				advertise: 'manual.example.com:5102',
				hydraVerificationKey: material.hydraVerificationKey,
				cardanoVerificationKey: material.cardanoVerificationKey,
			},
		];
		const update = deps.store.updateAsync.bind(deps.store);
		jest.spyOn(deps.store, 'updateAsync').mockImplementationOnce(async (nodeId, mutate) => {
			await update(nodeId, async (node) => ({ ...node, peers: manualPeers }));
			return update(nodeId, mutate);
		});
		await createRedemptionRecovery(exchange, deps, logger)();
		expect((await deps.store.read('node-1'))?.peers).toEqual(manualPeers);
	});
});
