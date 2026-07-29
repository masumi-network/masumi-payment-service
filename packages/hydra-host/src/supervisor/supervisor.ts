/**
 * The reconciler: drives each node's actual state toward its desired state.
 *
 * Decisions live in `plan.ts` so they can be asserted directly; this file only
 * executes them. Restart policy belongs here rather than to Docker, because a
 * stop must drain a snapshot round first and a container runtime cannot know to
 * do that.
 */

import path from 'node:path';
import type { HostConfig } from '../config.js';
import { NodeClient } from '../node-client.js';
import { PortAllocator } from '../registry/ports.js';
import type { NodeRegistryStore } from '../registry/store.js';
import type { NodeRecord } from '../registry/types.js';
import { buildHydraNodeArgs } from './args.js';
import { waitForDrain } from './drain.js';
import { classifyDrift, measureDrift, type SlotConfig } from './drift.js';
import { planNodeAction, type NodeObservation, type PlanLimits } from './plan.js';
import { NodeProcessManager } from './process.js';
import { unwedgeNode } from './unwedge.js';

const MAX_CONSECUTIVE_RESTARTS = 5;
const STRANDED_SETTLE_WAIT_MS = 30_000;

export type SupervisorLogger = {
	info: (message: string) => void;
	warn: (message: string) => void;
	error: (message: string) => void;
};

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});

export class Supervisor {
	private readonly processes = new NodeProcessManager();
	private readonly clients = new Map<string, NodeClient>();
	private readonly responsive = new Set<string>();
	private ticking = false;
	private stopped = false;

	constructor(
		private readonly config: HostConfig,
		private readonly store: NodeRegistryStore,
		private readonly ports: PortAllocator,
		private readonly slotConfig: SlotConfig,
		private readonly logger: SupervisorLogger,
	) {}

	private get limits(): PlanLimits {
		return { maxConsecutiveRestarts: MAX_CONSECUTIVE_RESTARTS, escrowTtlSeconds: this.config.escrowTtlSeconds };
	}

	private client(record: NodeRecord): NodeClient {
		let client = this.clients.get(record.nodeId);
		if (client === undefined) {
			client = new NodeClient(record.apiPort);
			this.clients.set(record.nodeId, client);
		}
		return client;
	}

	/**
	 * Rebuild in-memory state from the volume and start everything that should be
	 * running. This is what makes a container restart recover on its own.
	 */
	async boot(): Promise<void> {
		const records = await this.store.list();
		this.logger.info(`[supervisor] loaded ${records.length} node record(s) from ${this.config.dataDir}`);
		for (const record of records) {
			// A node that was running before the restart is still marked Running on
			// disk; the process is gone, so reset it to a state the planner will act on.
			if (record.state === 'Running' || record.state === 'Starting' || record.state === 'Draining') {
				await this.store.write({ ...record, state: 'Stopped' });
			}
		}
		await this.tick();
	}

	async tick(): Promise<void> {
		if (this.ticking || this.stopped) {
			return;
		}
		this.ticking = true;
		try {
			for (const record of await this.store.list()) {
				await this.reconcile(record);
			}
		} catch (error) {
			this.logger.error(`[supervisor] tick failed: ${(error as Error).message}`);
		} finally {
			this.ticking = false;
		}
	}

	private async observe(record: NodeRecord): Promise<NodeObservation> {
		const processRunning = this.processes.isRunning(record.nodeId);
		if (!processRunning) {
			this.responsive.delete(record.nodeId);
			return { processRunning: false, drift: null, responsive: false, nowMs: Date.now() };
		}

		const client = this.client(record);
		const responsive = await client.isResponsive();
		if (!responsive) {
			return { processRunning: true, drift: null, responsive: false, nowMs: Date.now() };
		}
		this.responsive.add(record.nodeId);

		const slot = await client.probeCurrentSlot();
		const drift =
			slot === null ? null : classifyDrift(measureDrift(slot, this.slotConfig, Date.now()), this.config.drift);

		return { processRunning: true, drift, responsive: true, nowMs: Date.now() };
	}

	private async reconcile(record: NodeRecord): Promise<void> {
		const observation = await this.observe(record);
		const action = planNodeAction(record, observation, this.limits);

		switch (action.kind) {
			case 'Idle':
				return;
			case 'Start':
				await this.start(record);
				return;
			case 'Stop':
				await this.stop(record, action.reason);
				return;
			case 'Restart':
				this.logger.warn(`[supervisor] restarting ${record.nodeId}: ${action.reason}`);
				await this.stop(record, action.reason);
				await this.start(record);
				return;
			case 'Unwedge':
				await this.unwedge(record, action.reason);
				return;
			case 'Fail':
				this.logger.error(`[supervisor] ${record.nodeId} failed: ${action.reason}`);
				await this.store.write({ ...record, state: 'Failed', failureReason: action.reason });
				return;
			case 'Remove':
				await this.remove(record, action.reason);
				return;
		}
	}

	private async start(record: NodeRecord): Promise<void> {
		const nodeDir = this.store.nodeDir(record.nodeId);
		const peersDir = path.join(nodeDir, 'peers');

		const args = buildHydraNodeArgs({
			nodeId: record.nodeId,
			nodeDir,
			network: record.network,
			apiPort: record.apiPort,
			peerPort: record.peerPort,
			monitoringPort: record.monitoringPort,
			advertise: record.advertise,
			peers: record.peers.map((peer) => peer.advertise),
			peerHydraVerificationKeyFiles: record.peers.map((_, i) => path.join(peersDir, `${i}-hydra.vk`)),
			peerCardanoVerificationKeyFiles: record.peers.map((_, i) => path.join(peersDir, `${i}-cardano.vk`)),
			ledgerProtocolParametersFile: this.config.ledgerProtocolParametersFile,
			blockfrostProjectFile: this.config.blockfrostProjectFile,
			contestationPeriodSeconds: record.contestationPeriodSeconds,
			depositPeriodSeconds: record.depositPeriodSeconds,
			unsyncedPeriodSeconds: record.unsyncedPeriodSeconds,
		});

		await this.store.write({ ...record, state: 'Starting' });
		this.logger.info(`[supervisor] starting ${record.nodeId} (peer ${record.peerPort}, api ${record.apiPort})`);

		this.processes.start(
			{ nodeId: record.nodeId, binary: this.config.hydraNodeBin, args, nodeDir },
			(nodeId, code, signal) => {
				void this.onExit(nodeId, code, signal);
			},
		);

		await this.store.write({ ...record, state: 'Running', restartCount: record.restartCount + 1 });
	}

	private async onExit(nodeId: string, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
		this.responsive.delete(nodeId);
		this.logger.warn(`[supervisor] ${nodeId} exited (code=${String(code)} signal=${String(signal)})`);
		const record = await this.store.read(nodeId);
		if (record === null || record.state === 'Removing') {
			return;
		}
		if (record.state === 'Running' || record.state === 'Starting') {
			// An exit we did not ask for. Mark it stopped so the next tick restarts
			// it, and remember that the stop was not drained.
			await this.store.write({ ...record, state: 'Stopped', lastStopUndrained: true });
		}
	}

	private async stop(record: NodeRecord, reason: string): Promise<void> {
		if (!this.processes.isRunning(record.nodeId)) {
			return;
		}
		this.logger.info(`[supervisor] draining ${record.nodeId} before stop: ${reason}`);
		await this.store.write({ ...record, state: 'Draining' });

		const client = this.client(record);
		const outcome = await waitForDrain({
			fetchLastSeen: () => client.fetchLastSeen(),
			timeoutMs: this.config.drainTimeoutMs,
			pollIntervalMs: 2_000,
			sleep,
			now: () => Date.now(),
		});

		if (!outcome.drained) {
			this.logger.warn(
				`[supervisor] ${record.nodeId} did not drain within ${this.config.drainTimeoutMs}ms ` +
					`(last tag ${String(outcome.lastTag)}); stopping anyway and will check for a stranded round on restart`,
			);
		}

		const stopResult = await this.processes.stop(record.nodeId, 30_000);
		if (!stopResult.graceful) {
			this.logger.warn(`[supervisor] ${record.nodeId} required SIGKILL`);
		}

		await this.store.write({
			...record,
			state: 'Stopped',
			lastStopUndrained: !outcome.drained || !stopResult.graceful,
		});
	}

	private async unwedge(record: NodeRecord, reason: string): Promise<void> {
		this.logger.info(`[supervisor] checking ${record.nodeId} for a stranded round: ${reason}`);
		const client = this.client(record);

		const outcome = await unwedgeNode({
			fetchLastSeen: () => client.fetchLastSeen(),
			fetchConfirmedSnapshot: () => client.fetchConfirmedSnapshot(),
			sideLoadSnapshot: (snapshot) => client.sideLoadSnapshot(snapshot),
			settleWaitMs: STRANDED_SETTLE_WAIT_MS,
			sleep,
		});

		switch (outcome.kind) {
			case 'Healthy':
			case 'Progressing':
				await this.store.write({ ...record, lastStopUndrained: false, restartCount: 0 });
				return;
			case 'Recovered':
				this.logger.info(`[supervisor] ${record.nodeId} recovered a stranded round by side-loading`);
				await this.store.write({ ...record, lastStopUndrained: false, restartCount: 0 });
				return;
			case 'Unrecovered':
				this.logger.error(`[supervisor] ${record.nodeId} could not be unwedged: ${outcome.reason}`);
				await this.store.write({ ...record, state: 'Failed', failureReason: outcome.reason });
				return;
		}
	}

	private async remove(record: NodeRecord, reason: string): Promise<void> {
		this.logger.info(`[supervisor] removing ${record.nodeId}: ${reason}`);
		if (this.processes.isRunning(record.nodeId)) {
			await this.stop(record, reason);
		}
		await this.store.remove(record.nodeId);
		this.ports.release(record.peerPort);
		this.clients.delete(record.nodeId);
		this.responsive.delete(record.nodeId);
	}

	/** Drain and stop every node. Called on SIGTERM. */
	async shutdown(): Promise<void> {
		this.stopped = true;
		this.logger.info('[supervisor] shutting down; draining all nodes');
		for (const record of await this.store.list()) {
			if (this.processes.isRunning(record.nodeId)) {
				await this.stop(record, 'host shutting down');
			}
		}
	}
}
