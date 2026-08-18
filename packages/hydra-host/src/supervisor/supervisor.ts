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
import { classifyDrift, driftBreachFields, measureDrift, resolveDriftThresholds, type SlotConfig } from './drift.js';
import { planNodeAction, shouldAdoptAsRunning, type NodeObservation, type PlanLimits } from './plan.js';
import { findProcessRunningNode, isProcessRunningNode, NodeProcessManager } from './process.js';
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
	/** The tick in flight, so a shutdown can wait for it instead of racing it. */
	private currentTick: Promise<void> | null = null;

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
					// Adopting the record is not enough. Without the process too, the
					// node is visible but untouchable: stop, restart and remove all
					// checked the child table, found nothing, and returned as if they
					// had succeeded — so after any host restart the operator could see
					// a node and ask it to stop, and nothing would ever happen.
					await this.adoptProcess(record);
					await this.store.update(record.nodeId, (current) => ({ ...current, state: 'Running' }));
					continue;
				}
				// Silence is not death. A node opens its API only once etcd has quorum
				// and its chain follower has synced, which with two participants takes
				// minutes — and the record itself says so by being `Starting`. Writing
				// it off here erased the pid, which is the only evidence left that the
				// process survived the host: the next tick then saw nothing running,
				// started a second hydra-node over the same persistence directory, api
				// port and etcd data dir, and burned the restart budget watching it die
				// on the peer-port bind. The node that was serving all along ended up
				// recorded as `Failed`.
				//
				// So ask the operating system before concluding anything: a pid that is
				// still running THIS node's process settles it.
				if (await this.adoptProcess(record)) {
					this.logger.info(
						`[supervisor] ${record.nodeId} is not answering yet, but pid ${record.pid} is still running it; keeping it`,
					);
					// `Starting` rather than the state it had: nothing has answered, and
					// the first successful probe promotes it. A drain the host did not
					// finish carries its undrained flag forward, because nothing else
					// records that the round was left in flight.
					await this.store.update(record.nodeId, (current) => ({
						...current,
						state: 'Starting',
						lastStopUndrained: current.state === 'Draining' ? true : current.lastStopUndrained,
					}));
					continue;
				}
				// The process really is gone but the record still says it was up, so the
				// host died without draining — an OOM kill, host failure or eviction.
				// That is exactly the case the unwedge check exists for, so flag it;
				// otherwise a round stranded by the kill is never detected.
				this.logger.warn(
					`[supervisor] ${record.nodeId} was ${record.state} at shutdown; treating as an undrained stop`,
				);
				await this.store.update(record.nodeId, (current) => ({
					...current,
					state: 'Stopped',
					lastStopUndrained: true,
					pid: undefined,
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
		// Held so `shutdown` can wait for it. A tick blocks for minutes — a drain
		// runs to `drainTimeoutMs`, an unwedge waits out a settle — and SIGTERM
		// arriving mid-tick used to walk a node list in which the node being
		// reconciled still looked stopped, skip it, and then watch that same
		// reconcile spawn a fresh hydra-node on the way out. Nothing drains that
		// one, and outside a container it outlives the host holding its peer port,
		// so the next boot cannot start the node at all.
		this.currentTick = this.runTick();
		try {
			await this.currentTick;
		} finally {
			this.ticking = false;
			this.currentTick = null;
		}
	}

	private async runTick(): Promise<void> {
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

	/**
	 * Take back a node this host started but no longer holds a handle to.
	 *
	 * The pid is checked against the hydra-node binary before it is adopted,
	 * because pids are reused and everything this manager does with one is send
	 * it a signal. A node that cannot be verified is left unadopted and said so
	 * out loud: the supervisor can still observe it, but an operator who asks it
	 * to stop needs to know the request will not reach it.
	 */
	private async adoptProcess(record: NodeRecord): Promise<boolean> {
		if (this.processes.isRunning(record.nodeId)) {
			return true;
		}
		const nodeDir = this.store.nodeDir(record.nodeId);
		if (record.pid !== undefined) {
			const adopted = await this.processes.adopt(record.nodeId, record.pid, this.config.hydraNodeBin, nodeDir);
			if (adopted) {
				this.logger.info(`[supervisor] took back ${record.nodeId} (pid ${record.pid}); it can be stopped again`);
				return true;
			}
			this.logger.warn(
				`[supervisor] ${record.nodeId} recorded pid ${record.pid}, which is not a live ${this.config.hydraNodeBin}`,
			);
		}

		// No usable pid is not the same as no process. The pid can only be written
		// once the spawn has returned, so a host that died in that window left a
		// node running with nothing naming it — and the next boot, seeing no pid,
		// started a second hydra-node over the first one's persistence directory,
		// api port and etcd data dir. The node's own directory identifies it just
		// as well as a pid does, so ask the machine what is running.
		const found = await findProcessRunningNode(this.config.hydraNodeBin, nodeDir);
		if (found === null) {
			if (record.pid !== undefined) {
				this.logger.warn(`[supervisor] ${record.nodeId} is not running here; this host cannot stop or restart it`);
			}
			return false;
		}
		const adopted = await this.processes.adopt(record.nodeId, found, this.config.hydraNodeBin, nodeDir);
		if (!adopted) {
			return false;
		}
		this.logger.warn(
			`[supervisor] found ${record.nodeId} running as pid ${found}, which no record named; taking it back`,
		);
		await this.store.update(record.nodeId, (current) => ({ ...current, pid: found }));
		return true;
	}

	private async observe(record: NodeRecord): Promise<NodeObservation> {
		const client = this.client(record);
		if (!this.processes.isRunning(record.nodeId)) {
			// Not a child of THIS host does not mean not running. A host restart
			// leaves its nodes serving but loses the handles to them, so judging by
			// the child table alone would mark a live node dead one tick after boot
			// adopted it — and keep doing so on every tick after that.
			if (!(await client.isResponsive())) {
				// One slow probe is not evidence that the process is gone, and the
				// action taken on that evidence is a spawn: a second hydra-node over
				// the first one's persistence directory, api port and etcd data dir.
				// A recorded pid that is still running hydra-node settles it — the
				// node is up and merely busy, which is exactly how an owned child is
				// already treated one branch below.
				const alive =
					record.pid !== undefined &&
					(await isProcessRunningNode(record.pid, this.config.hydraNodeBin, this.store.nodeDir(record.nodeId)));
				return {
					processRunning: alive,
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
			const thresholds = resolveDriftThresholds(record.unsyncedPeriodSeconds * 1000, this.config.drift);
			const sample = measureDrift(slot, this.slotConfig, Date.now());
			driftSeconds = Math.round(sample.driftMs / 1000);
			// Judged whether or not the node says it is in sync.
			//
			// It used to be judged only when the node reported InSync, to avoid
			// restarting one that was legitimately catching up. That reasoning
			// assumed catching up always ends. With the Blockfrost backend it does
			// not: the delay-free catch-up loop runs once at startup, and the poll
			// loop it then enters sleeps a whole average block time before every
			// block, so a node that falls behind reports `CatchingUp` forever and
			// was never judged, never restarted, and never recovered.
			//
			// Telling "catching up" from "stuck" is not this verdict's job — both
			// look identical in one sample. The plan decides, on whether the gap is
			// closing across ticks.
			drift = classifyDrift(sample, thresholds);
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
		// Refunded for a node that is answering and not stalled, rather than only
		// for one whose drift is `Healthy`. Degraded drift is a node that is behind
		// and closing the gap — the catch-up loop working, not a fault, and the
		// plan does not restart for it. Withholding the refund there left a node
		// that had been serving for hours carrying the attempts from whatever
		// brought it up, so its next single crash met the exhausted budget and was
		// marked `Failed` — "failed to stay up after 5 attempts" about a node that
		// had just been up all afternoon.
		const earnedBudget =
			observation.responsive && (observation.drift === 'Healthy' || observation.drift === 'Degraded');
		const promote = shouldAdoptAsRunning(record, observation);
		// A node this host did not spawn has no exit handler, so its death is not
		// reported by anything — it simply stops being in `processes`. Left at
		// that, the next tick starts it again with `lastStopUndrained` false and
		// the unwedge check is skipped for exactly the nodes that survived a host
		// restart, which are the ones most likely to be carrying a stranded round.
		// This is the same conclusion `onExit` draws for an owned child.
		const diedUnobserved =
			!observation.processRunning &&
			!observation.responsive &&
			(record.state === 'Running' || record.state === 'Starting');

		const updated = await this.store.update(record.nodeId, (current) => ({
			...current,
			lastObservation: {
				checkedAt: new Date(observation.nowMs).toISOString(),
				responsive: observation.responsive,
				chainSynced: observation.chainSynced,
				drift: observation.drift,
				driftSeconds: observation.driftSeconds,
			},
			...driftBreachFields(current, observation),
			...(promote && shouldAdoptAsRunning(current, observation) ? { state: 'Running' as const } : {}),
			...(earnedBudget && current.startAttempts !== 0 ? { startAttempts: 0 } : {}),
			...(diedUnobserved && (current.state === 'Running' || current.state === 'Starting')
				? { state: 'Stopped' as const, lastStopUndrained: true, pid: undefined }
				: {}),
		}));

		if (diedUnobserved && updated?.state === 'Stopped') {
			this.logger.warn(
				`[supervisor] ${record.nodeId} is gone and nothing recorded its exit; treating as an undrained stop`,
			);
		}

		if (promote && updated?.state === 'Running' && record.state !== 'Running') {
			this.logger.info(
				`[supervisor] ${record.nodeId} is answering its API${record.state === 'Stopped' ? ' despite being recorded as stopped; adopting it' : ''}`,
			);
		}
		return updated ?? record;
	}

	private async reconcile(record: NodeRecord): Promise<void> {
		if (this.stopped) {
			// SIGTERM landed while this tick was still walking the list. Whatever
			// this node needed, starting or restarting it now produces a process the
			// shutdown has already decided not to drain.
			return;
		}
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
			case 'Restart': {
				this.logger.warn(`[supervisor] restarting ${record.nodeId}: ${action.reason}`);
				const stopped = await this.stop(record, action.reason);
				// Clear the request before starting, so a restart that fails partway
				// is retried by the normal Start path rather than looping here.
				//
				// The breach is cleared and stamped in the same write: the node is
				// about to re-run its catch-up, so the stall that justified this
				// restart is answered, and the stamp is what stops a node that cannot
				// catch up from restarting every couple of minutes forever.
				await this.store.update(record.nodeId, (current) => ({
					...current,
					restartRequested: false,
					driftBreachSince: undefined,
					driftBreachSeconds: undefined,
					lastDriftRestartAt: new Date().toISOString(),
				}));
				// Only ever the half of a restart that follows a stop that worked.
				// The stop above records `Failed` with an actionable reason when the
				// node is answering but unreachable by signal; starting anyway both
				// buried that message under `Starting` and spawned a second
				// hydra-node onto the live one's persistence directory, api port and
				// etcd data dir. `remove` already refuses on the same evidence.
				if (!stopped) {
					this.logger.error(
						`[supervisor] not restarting ${record.nodeId}: it could not be stopped, and starting a second one ` +
							'would run two nodes over the same persistence directory',
					);
					return;
				}
				await this.start(record);
				return;
			}
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
		if (this.stopped) {
			// Last gate before the spawn: the shutdown may have begun during the
			// awaits above (the args build touches the disk), and a node spawned
			// after the shutdown has taken its list of what to drain is a node
			// nothing will ever stop.
			return;
		}
		const nodeDir = this.store.nodeDir(record.nodeId);
		const peersDir = path.join(nodeDir, 'peers');

		// Claimed before argv is built, not after. A peer change is refused unless
		// the node is quiescent, and it read that from a record this start had
		// already decided to act on: the change could pass its check and rewrite
		// the key files while argv was being assembled from the old peer list,
		// leaving the process bootstrapping an etcd cluster that matches neither
		// its own record nor the files on disk. Claiming first makes that window
		// answer 409, and re-reading afterwards picks up any change that beat it.
		const claimed = await this.store.update(record.nodeId, (current) => ({
			...current,
			state: 'Starting',
			startAttempts: current.startAttempts + 1,
		}));
		if (claimed === null) {
			this.logger.warn(`[supervisor] ${record.nodeId} disappeared before it could be started`);
			return;
		}
		const starting = claimed;

		const args = buildHydraNodeArgs({
			nodeId: starting.nodeId,
			nodeDir,
			network: starting.network,
			apiPort: starting.apiPort,
			startChainFrom: starting.startChainFrom,
			peerPort: starting.peerPort,
			// Null unless explicitly enabled: the Prometheus server binds every
			// interface and hydra-node offers no way to confine it.
			monitoringPort: this.config.monitoringEnabled ? starting.monitoringPort : null,
			advertise: starting.advertise,
			peers: starting.peers.map((peer) => peer.advertise),
			peerHydraVerificationKeyFiles: starting.peers.map((_, i) => path.join(peersDir, `${i}-hydra.vk`)),
			peerCardanoVerificationKeyFiles: starting.peers.map((_, i) => path.join(peersDir, `${i}-cardano.vk`)),
			ledgerProtocolParametersFile: this.config.ledgerProtocolParametersFile,
			blockfrostProjectFile: this.config.blockfrostProjectFile,
			contestationPeriodSeconds: starting.contestationPeriodSeconds,
			depositPeriodSeconds: starting.depositPeriodSeconds,
			unsyncedPeriodSeconds: starting.unsyncedPeriodSeconds,
			useSystemEtcd: this.config.useSystemEtcd,
		});

		if (!this.config.useSystemEtcd) {
			// hydra-node re-extracts its embedded etcd on every boot. Rewriting the
			// binary in place while the previous one is still exiting gets the new
			// process killed by macOS's code-signature cache, so the stale copy is
			// removed first — the same guard the native launcher uses.
			await fs.rm(path.join(nodeDir, 'persistence', 'bin', 'etcd'), { force: true }).catch(() => undefined);
		}

		this.logger.info(`[supervisor] starting ${starting.nodeId} (peer ${starting.peerPort}, api ${starting.apiPort})`);
		const started = await this.processes.start(
			{ nodeId: starting.nodeId, binary: this.config.hydraNodeBin, args, nodeDir },
			(nodeId, code, signal) => {
				void this.onExit(nodeId, code, signal).catch((error: unknown) => {
					this.logger.error(`[supervisor] recording exit for ${nodeId} failed: ${(error as Error).message}`);
				});
			},
		);

		// Persisted after the spawn, because only then is there a pid. This is what
		// the next host gets instead of a handle: without it, a node started here
		// and surviving a host restart can be observed but never signalled again.
		if (started.pid !== undefined) {
			await this.store.update(record.nodeId, (current) => ({ ...current, pid: started.pid }));
		}
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
			//
			// The pid goes with it. Kept, it outlives the process that owned it and
			// the operating system hands the number to something else — on a fresh
			// container, quite possibly to a sibling hydra-node — and a stale pid
			// is not an inert field here: it is what stop and restart signal.
			return { ...current, state: 'Stopped', lastStopUndrained: true, pid: undefined };
		});
	}

	/**
	 * Take a node down.
	 *
	 * Returns whether it is actually down afterwards. A stop can fail — a node
	 * that answers but that this host cannot signal is recorded `Failed` and left
	 * running — and a caller that goes on to start it spawns a second hydra-node
	 * over the first one's persistence directory, api port and etcd data dir.
	 */
	private async stop(record: NodeRecord, reason: string): Promise<boolean> {
		if (!this.processes.isRunning(record.nodeId)) {
			// A node this host restarted away from is still stoppable by pid.
			await this.adoptProcess(record);
		}
		if (!this.processes.isRunning(record.nodeId)) {
			// Nothing to signal. This used to return as though the stop had
			// succeeded, which left `desired: Stopped` permanently unreachable: the
			// plan asked for a stop every tick, the stop did nothing, and the record
			// went on saying Running while the payment service kept routing work to
			// a node the operator had asked to take down.
			if (await this.client(record).isResponsive()) {
				const failureReason =
					'the node is answering but this host holds no way to signal it, so it cannot be stopped or restarted here; ' +
					'stop the process on the machine, then start or remove the node again';
				this.logger.error(`[supervisor] cannot stop ${record.nodeId} (${reason}): ${failureReason}`);
				await this.store.update(record.nodeId, (current) => ({ ...current, state: 'Failed', failureReason }));
				return false;
			}
			// Genuinely down, and nothing drained it.
			await this.store.update(record.nodeId, (current) => ({
				...current,
				state: 'Stopped',
				lastStopUndrained: true,
				pid: undefined,
			}));
			return true;
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

		// The drain is only reached with a live process — checked above — so an
		// unreachable node here is not a node that has exited, it is a node that
		// has stopped answering while still running: a wedged event loop, a hung
		// etcd client, a round left in flight. That is the exact case the unwedge
		// check exists for, and taking `drained` at face value recorded it as a
		// clean stop and skipped the check on the way back up.
		const wedged = outcome.reason === 'unreachable';
		if (wedged) {
			this.logger.warn(
				`[supervisor] ${record.nodeId} stopped answering while its process was still running; ` +
					'stopping it as an undrained stop and will check for a stranded round on restart',
			);
		} else if (!outcome.drained) {
			this.logger.warn(
				`[supervisor] ${record.nodeId} did not drain within ${this.config.drainTimeoutMs}ms ` +
					`(last tag ${String(outcome.lastTag)}); stopping anyway and will check for a stranded round on restart`,
			);
		}

		const stopResult = await this.processes.stop(record.nodeId, SIGKILL_GRACE_MS);
		if (!stopResult.graceful) {
			this.logger.warn(`[supervisor] ${record.nodeId} required SIGKILL`);
		}

		// A process that outlived SIGKILL is still holding this node's persistence
		// directory, its api port and its peer port. Reporting it stopped is what
		// let `remove` delete those files and hand the port to the next provision
		// while the orphan kept writing to both. The pid is kept for the same
		// reason: it is the only handle anything has on it.
		if (!stopResult.stopped) {
			const failureReason = `the process (pid ${String(record.pid ?? 'unknown')}) did not exit on SIGKILL, so its files and ports are still in use`;
			this.logger.error(`[supervisor] ${record.nodeId} could not be stopped: ${failureReason}`);
			await this.store.update(record.nodeId, (current) => ({
				...current,
				state: 'Failed',
				lastStopUndrained: true,
				failureReason,
			}));
			return false;
		}

		const undrained = !outcome.drained || wedged || !stopResult.graceful;
		await this.store.update(record.nodeId, (current) => ({
			...current,
			state: 'Stopped',
			lastStopUndrained: undrained,
			pid: undefined,
		}));
		return true;
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
		// Unconditionally, because "not a child of this host" is not the same as
		// "not running": `stop` takes the process back by pid when it can, and says
		// so when it cannot.
		const stopped = await this.stop(record, reason);

		// A node that still answers is one the stop could not reach. Deleting its
		// persistence directory out from under it and handing its peer port to the
		// next node turns one stuck node into two: the orphan keeps writing and
		// keeps the port bound, and the node that inherits the port cannot start.
		//
		// The stop's own answer is checked alongside the probe, because the case
		// this guard exists for is precisely a node that has stopped answering
		// while its process runs on: a wedged node fails `isResponsive` and would
		// have passed straight through.
		if (!stopped || (await this.client(record).isResponsive())) {
			const failureReason = stopped
				? 'the node is still answering after a stop attempt, so its files and peer port are still in use; ' +
					'stop the process on the machine, then remove the node again'
				: 'the process did not exit on SIGKILL, so its files and peer port are still in use; ' +
					'stop the process on the machine, then remove the node again';
			this.logger.error(`[supervisor] refusing to remove ${record.nodeId}: ${failureReason}`);
			// The intent is cleared with the failure. Left set, the plan asks for the
			// same removal on every tick, it is refused for the same reason every
			// time, and the log fills with a failure nobody is being asked to act on.
			await this.store.update(record.nodeId, (current) => ({
				...current,
				state: 'Failed',
				removalRequested: false,
				failureReason,
			}));
			return;
		}

		try {
			await this.store.remove(record.nodeId);
		} catch (error) {
			// The record is still on disk, and it still carries this peer port. So
			// the port is NOT free: releasing it hands the same number to the next
			// provision, and the next boot — which rebuilds the allocator from the
			// records on disk — claims it twice and throws `PortLayoutError` out of
			// `main()`, crash-looping a host that supervises nothing until someone
			// deletes the directory by hand.
			const failureReason =
				`the node directory could not be deleted (${(error as Error).message}), so its port and files are still in use; ` +
				'remove the node again once the volume is writable';
			this.logger.error(`[supervisor] removing ${record.nodeId} failed: ${failureReason}`);
			await this.store.update(record.nodeId, (current) => ({
				...current,
				state: 'Failed',
				removalRequested: false,
				failureReason,
			}));
			return;
		}
		this.ports.release(record.peerPort);
		this.clients.delete(record.nodeId);
	}

	/** Drain and stop every node. Called on SIGTERM. */
	async shutdown(): Promise<void> {
		this.stopped = true;
		this.logger.info('[supervisor] shutting down; draining all nodes');
		// Waited for before the list is taken, so the list cannot miss a node the
		// tick was in the middle of starting. `runTick` handles its own errors, so
		// there is nothing here to catch.
		await this.currentTick;
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
