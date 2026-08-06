/**
 * The reconciler: drives each node's actual state toward its desired state.
 *
 * Decisions live in `plan.ts` so they can be asserted directly; this file only
 * executes them. Restart policy belongs here rather than to Docker, because a
 * stop must drain a snapshot round first and a container runtime cannot know to
 * do that.
 *
 * Every mutation goes through `store.update`, never `store.write`: the record
 * on disk is the source of truth, and a caller that persisted a snapshot
 * captured earlier would silently discard concurrent updates — notably the
 * process-exit handler's, which is the one that remembers a stop was undrained.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { HostConfig } from '../config.js';
import { NodeClient } from '../node-client.js';
import { PortAllocator } from '../registry/ports.js';
import type { NodeRegistryStore } from '../registry/store.js';
import type { NodeRecord } from '../registry/types.js';
import { buildHydraNodeArgs } from './args.js';
import { waitForDrain } from './drain.js';
import { classifyDrift, measureDrift, validateDriftThresholds, type SlotConfig } from './drift.js';
import { planNodeAction, shouldAdoptAsRunning, type NodeObservation, type PlanLimits } from './plan.js';
import { NodeProcessManager } from './process.js';
import { unwedgeNode } from './unwedge.js';

/** One initial start plus four retries before a node is declared Failed. */
const MAX_START_ATTEMPTS = 5;
const STRANDED_SETTLE_WAIT_MS = 30_000;
const SIGKILL_GRACE_MS = 30_000;
/**
 * Nodes are reconciled concurrently because a single stop can block for the
 * whole drain timeout plus the SIGKILL grace. Serialising would let one
 * draining node delay drift observation for every other node by minutes — and
 * drift is precisely what makes a node reject all client input.
 */
const RECONCILE_CONCURRENCY = 8;

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

async function mapWithConcurrency<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
	let cursor = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (;;) {
			const index = cursor++;
			if (index >= items.length) {
				return;
			}
			await run(items[index]);
		}
	});
	await Promise.all(workers);
}

export class Supervisor {
	private readonly processes = new NodeProcessManager();
	private readonly clients = new Map<string, NodeClient>();
	/** Nodes currently being reconciled, so overlapping ticks cannot double-act. */
	private readonly inFlight = new Set<string>();
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
		return { maxStartAttempts: MAX_START_ATTEMPTS, escrowTtlSeconds: this.config.escrowTtlSeconds };
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
			if (record.state === 'Running' || record.state === 'Starting' || record.state === 'Draining') {
				// A node outlives the host that supervises it: the host is an ordinary
				// process and restarting it — a deploy, a crash, a developer — does not
				// take the hydra-nodes with it. Assuming it did marked a node that was
				// still serving on its own port as Stopped, and nothing ever corrected
				// it: the record said down, so the payment service refused to connect,
				// the admin UI reported "the node is not running", and every operation
				// needing a live session failed against a perfectly healthy node.
				//
				// So ask it. A node that answers is adopted as Running; only silence
				// means the host really did take it down, which is the case the unwedge
				// check exists for.
				if (await this.client(record).isResponsive()) {
					this.logger.info(
						`[supervisor] ${record.nodeId} was ${record.state} at shutdown and is still answering; adopting it`,
					);
					await this.store.update(record.nodeId, (current) => ({ ...current, state: 'Running' }));
					continue;
				}
				// The process is gone but the record still says it was up, so the host
				// died without draining — an OOM kill, host failure or eviction. That
				// is exactly the case the unwedge check exists for, so flag it;
				// otherwise a round stranded by the kill is never detected.
				this.logger.warn(
					`[supervisor] ${record.nodeId} was ${record.state} at shutdown; treating as an undrained stop`,
				);
				await this.store.update(record.nodeId, (current) => ({
					...current,
					state: 'Stopped',
					lastStopUndrained: true,
				}));
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
			const records = await this.store.list();
			await mapWithConcurrency(records, RECONCILE_CONCURRENCY, async (record) => {
				if (this.inFlight.has(record.nodeId)) {
					return;
				}
				this.inFlight.add(record.nodeId);
				try {
					await this.reconcile(record);
				} catch (error) {
					// Isolated per node: one node's failure must not skip the rest.
					this.logger.error(`[supervisor] reconciling ${record.nodeId} failed: ${(error as Error).message}`);
				} finally {
					this.inFlight.delete(record.nodeId);
				}
			});
		} catch (error) {
			this.logger.error(`[supervisor] tick failed: ${(error as Error).message}`);
		} finally {
			this.ticking = false;
		}
	}

	private async observe(record: NodeRecord): Promise<NodeObservation> {
		const client = this.client(record);
		if (!this.processes.isRunning(record.nodeId)) {
			// Not a child of THIS host does not mean not running. A host restart
			// leaves its nodes serving but loses the handles to them, so judging by
			// the child table alone would mark a live node dead one tick after boot
			// adopted it — and keep doing so on every tick after that.
			if (!(await client.isResponsive())) {
				return {
					processRunning: false,
					drift: null,
					driftSeconds: null,
					responsive: false,
					chainSynced: false,
					nowMs: Date.now(),
				};
			}
		} else if (!(await client.isResponsive())) {
			return {
				processRunning: true,
				drift: null,
				driftSeconds: null,
				responsive: false,
				chainSynced: false,
				nowMs: Date.now(),
			};
		}

		const chain = await client.probeChain();
		// Measured whenever the node reports a slot, in sync or not. Drift on a
		// synced node is a warning; drift on a catching-up node is the whole
		// diagnosis, and computing it only for the former left operators staring
		// at "still catching up" with no way to tell minutes from days.
		const slot = chain.slot;
		let drift: NodeObservation['drift'] = null;
		let driftSeconds: number | null = null;
		if (slot !== null) {
			// Validate against THIS node's unsynced period, not the host default: a
			// node provisioned with a shorter period needs a guard that still fires
			// before the node starts refusing input.
			const thresholds = this.config.drift;
			try {
				validateDriftThresholds(thresholds, record.unsyncedPeriodSeconds * 1000);
			} catch (error) {
				this.logger.warn(`[supervisor] ${record.nodeId}: ${(error as Error).message}`);
			}
			const sample = measureDrift(slot, this.slotConfig, Date.now());
			drift = classifyDrift(sample, thresholds);
			driftSeconds = Math.round(sample.driftMs / 1000);
		}

		return {
			processRunning: true,
			drift,
			driftSeconds,
			responsive: true,
			chainSynced: chain.synced,
			nowMs: Date.now(),
		};
	}

	/**
	 * Persist what the probe saw, and promote a node that has come up.
	 *
	 * Three things depend on this being durable rather than in-memory:
	 *
	 *  - the health endpoint, which is the payment service's only way to ask
	 *    whether a node is usable, and which otherwise reports a record that
	 *    says `Running` for a node whose API is dead;
	 *  - `Starting` → `Running`, so `Running` means "answering" rather than
	 *    "spawned" — with two participants a node legitimately sits in
	 *    `Starting` for minutes, since etcd has no quorum until both are up;
	 *  - the restart budget, which must be refunded once a node proves it can
	 *    stay up, or routine drift restarts accumulate until a healthy node is
	 *    marked Failed.
	 *
	 * Written every tick, including when only the timestamp changed: a stale
	 * `checkedAt` is itself the signal that the supervisor has stopped ticking,
	 * and that is worth more than the write it saves.
	 */
	private async recordObservation(record: NodeRecord, observation: NodeObservation): Promise<NodeRecord> {
		const healthy = observation.responsive && observation.drift === 'Healthy';
		const promote = shouldAdoptAsRunning(record, observation);

		const updated = await this.store.update(record.nodeId, (current) => ({
			...current,
			lastObservation: {
				checkedAt: new Date(observation.nowMs).toISOString(),
				responsive: observation.responsive,
				chainSynced: observation.chainSynced,
				drift: observation.drift,
				driftSeconds: observation.driftSeconds,
			},
			...(promote && shouldAdoptAsRunning(current, observation) ? { state: 'Running' as const } : {}),
			...(healthy && current.startAttempts !== 0 ? { startAttempts: 0 } : {}),
		}));

		if (promote && updated?.state === 'Running' && record.state !== 'Running') {
			this.logger.info(
				`[supervisor] ${record.nodeId} is answering its API${record.state === 'Stopped' ? ' despite being recorded as stopped; adopting it' : ''}`,
			);
		}
		return updated ?? record;
	}

	private async reconcile(record: NodeRecord): Promise<void> {
		const observation = await this.observe(record);
		record = await this.recordObservation(record, observation);

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
				// Clear the request before starting, so a restart that fails partway
				// is retried by the normal Start path rather than looping here.
				await this.store.update(record.nodeId, (current) => ({ ...current, restartRequested: false }));
				await this.start(record);
				return;
			case 'Unwedge':
				await this.unwedge(record, action.reason);
				return;
			case 'Fail':
				this.logger.error(`[supervisor] ${record.nodeId} failed: ${action.reason}`);
				await this.store.update(record.nodeId, (current) => ({
					...current,
					state: 'Failed',
					failureReason: action.reason,
				}));
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
			// Null unless explicitly enabled: the Prometheus server binds every
			// interface and hydra-node offers no way to confine it.
			monitoringPort: this.config.monitoringEnabled ? record.monitoringPort : null,
			advertise: record.advertise,
			peers: record.peers.map((peer) => peer.advertise),
			peerHydraVerificationKeyFiles: record.peers.map((_, i) => path.join(peersDir, `${i}-hydra.vk`)),
			peerCardanoVerificationKeyFiles: record.peers.map((_, i) => path.join(peersDir, `${i}-cardano.vk`)),
			ledgerProtocolParametersFile: this.config.ledgerProtocolParametersFile,
			blockfrostProjectFile: this.config.blockfrostProjectFile,
			contestationPeriodSeconds: record.contestationPeriodSeconds,
			depositPeriodSeconds: record.depositPeriodSeconds,
			unsyncedPeriodSeconds: record.unsyncedPeriodSeconds,
			useSystemEtcd: this.config.useSystemEtcd,
		});

		if (!this.config.useSystemEtcd) {
			// hydra-node re-extracts its embedded etcd on every boot. Rewriting the
			// binary in place while the previous one is still exiting gets the new
			// process killed by macOS's code-signature cache, so the stale copy is
			// removed first — the same guard the native launcher uses.
			await fs.rm(path.join(nodeDir, 'persistence', 'bin', 'etcd'), { force: true }).catch(() => undefined);
		}

		// Count the attempt and mark it starting BEFORE spawning. Writing after the
		// spawn would race the exit handler for a node that dies immediately, and
		// the later write would clobber the undrained flag the handler just set.
		//
		// `Starting`, not `Running`: nothing has answered yet, and with two
		// participants nothing can until the peer is up too. The next probe
		// promotes it.
		await this.store.update(record.nodeId, (current) => ({
			...current,
			state: 'Starting',
			startAttempts: current.startAttempts + 1,
		}));

		this.logger.info(`[supervisor] starting ${record.nodeId} (peer ${record.peerPort}, api ${record.apiPort})`);
		await this.processes.start(
			{ nodeId: record.nodeId, binary: this.config.hydraNodeBin, args, nodeDir },
			(nodeId, code, signal) => {
				void this.onExit(nodeId, code, signal);
			},
		);
	}

	private async onExit(nodeId: string, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
		this.logger.warn(`[supervisor] ${nodeId} exited (code=${String(code)} signal=${String(signal)})`);
		await this.store.update(nodeId, (current) => {
			if (current.state !== 'Running' && current.state !== 'Starting') {
				// A stop we asked for already recorded the outcome.
				return current;
			}
			// An exit we did not ask for: nothing drained it, so the next tick must
			// check for a stranded round before trusting this node.
			return { ...current, state: 'Stopped', lastStopUndrained: true };
		});
	}

	private async stop(record: NodeRecord, reason: string): Promise<void> {
		if (!this.processes.isRunning(record.nodeId)) {
			return;
		}
		this.logger.info(`[supervisor] draining ${record.nodeId} before stop: ${reason}`);
		await this.store.update(record.nodeId, (current) => ({ ...current, state: 'Draining' }));

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

		const stopResult = await this.processes.stop(record.nodeId, SIGKILL_GRACE_MS);
		if (!stopResult.graceful) {
			this.logger.warn(`[supervisor] ${record.nodeId} required SIGKILL`);
		}

		const undrained = !outcome.drained || !stopResult.graceful;
		await this.store.update(record.nodeId, (current) => ({
			...current,
			state: 'Stopped',
			lastStopUndrained: undrained,
		}));
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
			case 'Recovered':
				if (outcome.kind === 'Recovered') {
					this.logger.info(`[supervisor] ${record.nodeId} recovered a stranded round by side-loading`);
				}
				await this.store.update(record.nodeId, (current) => ({
					...current,
					lastStopUndrained: false,
					startAttempts: 0,
				}));
				return;
			case 'Unrecovered':
				this.logger.error(`[supervisor] ${record.nodeId} could not be unwedged: ${outcome.reason}`);
				await this.store.update(record.nodeId, (current) => ({
					...current,
					state: 'Failed',
					failureReason: outcome.reason,
				}));
				return;
		}
	}

	private async remove(record: NodeRecord, reason: string): Promise<void> {
		this.logger.info(`[supervisor] removing ${record.nodeId}: ${reason}`);
		if (this.processes.isRunning(record.nodeId)) {
			await this.stop(record, reason);
		}
		try {
			await this.store.remove(record.nodeId);
		} finally {
			// Release the slot even if the directory could not be deleted; a leaked
			// port would otherwise persist until the next boot rebuilds from disk.
			this.ports.release(record.peerPort);
			this.clients.delete(record.nodeId);
		}
	}

	/** Drain and stop every node. Called on SIGTERM. */
	async shutdown(): Promise<void> {
		this.stopped = true;
		this.logger.info('[supervisor] shutting down; draining all nodes');
		const records = await this.store.list();
		await mapWithConcurrency(records, RECONCILE_CONCURRENCY, async (record) => {
			if (!this.processes.isRunning(record.nodeId)) {
				return;
			}
			try {
				await this.stop(record, 'host shutting down');
			} catch (error) {
				this.logger.error(`[supervisor] stopping ${record.nodeId} failed: ${(error as Error).message}`);
			}
		});
	}
}
