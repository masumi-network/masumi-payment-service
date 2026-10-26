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
import { peerKeyDirectory } from '../registry/peer-key-directory.js';
import type { NodeRegistryStore } from '../registry/store.js';
import type { NodeRecord } from '../registry/types.js';
import { buildHydraNodeArgs } from './args.js';
import { mapWithConcurrency, sleep } from './concurrency.js';
import type { SlotConfig } from './drift.js';
import { observeNode, recordObservation } from './observe.js';
import { planNodeAction, shouldAdoptAsRunning, type NodeObservation, type PlanLimits } from './plan.js';
import { findProcessRunningNode, NodeProcessManager } from './process.js';
import { drainRunningNodes } from './shutdown-drain.js';
import { removeNode, stopNode } from './teardown.js';
import { unwedgeRecord } from './unwedge.js';

/** One initial start plus four retries before a node is declared Failed. */
const MAX_START_ATTEMPTS = 5;
const STRANDED_SETTLE_WAIT_MS = 30_000;
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

export class Supervisor {
	private readonly processes: NodeProcessManager;
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
	) {
		this.processes = new NodeProcessManager((nodeId, error) =>
			this.logger.error(`[supervisor] could not rotate diagnostic log for ${nodeId}: ${String(error)}`),
		);
	}

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
	 * Stop taking on new work, without draining.
	 *
	 * `shutdown` sets the same flag, but it can only run once the host has finished
	 * starting — and `boot` is the slowest thing here: it probes every record in
	 * turn at 5s each and then runs a full tick, which at the default capacity of
	 * 32 nodes is minutes. A signal arriving in that window used to do nothing at
	 * all, so the platform sat through its whole stop grace and then SIGKILLed
	 * every node undrained. Calling this makes `boot` stop where it is, and
	 * `tick`/`reconcile`/`start` already refuse on the same flag.
	 */
	beginShutdown(): void {
		this.stopped = true;
	}

	/**
	 * Adopt persisted node processes, then reconcile unless the caller disables it.
	 * @param options.reconcile Set false to let the caller start the first tick separately.
	 */
	async boot(options: { reconcile?: boolean } = {}): Promise<void> {
		const records = await this.store.list();
		this.logger.info(`[supervisor] loaded ${records.length} node record(s) from ${this.config.dataDir}`);
		for (const record of records) {
			if (this.stopped) {
				this.logger.info('[supervisor] shutdown began during boot; leaving the remaining records to the next one');
				return;
			}
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
					// The process is adopted either way — without it the node is visible
					// but untouchable — but the RECORD is only promoted when the node is
					// genuinely wanted running. `shouldAdoptAsRunning` is the one place
					// that decision lives, and bypassing it here promoted a node the
					// operator had already asked to stop or remove: it was mid-`Draining`
					// when the host restarted, `lastObservation` still said responsive and
					// synced, so `isUsable()` answered true and /health advertised it for
					// the whole of boot plus its wait in the reconcile queue — long enough
					// for the payment service to open a head or lock funds into a node
					// that is being taken down. Left as it is, the tick replans the stop.
					// `state: 'Stopped'` is deliberate rather than the record's own: what
					// is being asked is "the process survived a host that thought it
					// hadn't", so the stale state is exactly what must not decide it.
					// `desired` and `removalRequested` carry the intent, and the removal
					// flag has to be passed because a teardown never touches `desired` —
					// without it a node mid-`remove()` answered, was promoted, and was
					// advertised as usable until the next tick deleted its directory.
					const intent = {
						state: 'Stopped' as const,
						desired: record.desired,
						removalRequested: record.removalRequested,
					};
					if (shouldAdoptAsRunning(intent, { responsive: true })) {
						await this.store.update(record.nodeId, (current) => ({ ...current, state: 'Running' }));
					} else {
						this.logger.info(
							`[supervisor] ${record.nodeId} is answering but is wanted ${record.desired}${
								record.removalRequested === true ? ' and is marked for removal' : ''
							}; adopting the process without advertising it as usable`,
						);
					}
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
						`[supervisor] ${record.nodeId} is not answering yet; pid ${record.pid} remains live or unverified, so ownership is retained`,
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
		if (options.reconcile !== false) await this.tick();
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
			// Before anything is judged running. An adopted node has no exit event,
			// so its entry outlives it, and a reused pid makes it read as alive for
			// good — the supervisor would then never restart a node it has actually
			// lost. Nothing to do on a host that has not been restarted: only
			// adopted entries are checked, and there are none.
			for (const nodeId of await this.processes.revalidateAdopted()) {
				this.logger.warn(`[supervisor] ${nodeId} is no longer at the pid it was adopted at; treating it as stopped`);
			}
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
		}
		// The flag is cleared by `tick`, together with `currentTick`, and only
		// there. Clearing it here as well opened a microtask-wide window in which a
		// second `tick` could start before the first had nulled `currentTick` — and
		// the first one then nulled the second one's handle, leaving `shutdown()`
		// with nothing to await.
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
				this.logger.info(
					`[supervisor] tracking ${record.nodeId} (pid ${record.pid}); signals still require a verified identity`,
				);
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
		return observeNode(record, {
			client: this.client(record),
			processes: this.processes,
			store: this.store,
			config: this.config,
			slotConfig: this.slotConfig,
		});
	}

	private async recordObservation(record: NodeRecord, observation: NodeObservation): Promise<NodeRecord> {
		return recordObservation(record, observation, { store: this.store, logger: this.logger });
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
					// Same reasoning for silence: the node is about to be replaced by a
					// fresh process, so the silence that justified this restart is
					// answered, and the stamp is what stops one that comes back mute
					// from restarting every few minutes forever.
					muteSince: undefined,
					lastMuteRestartAt: new Date().toISOString(),
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
			// A start IS the restart an operator asked for on a node that was down,
			// so the request is answered here. Left set, it survived into the boot:
			// the next tick sees a running-but-not-yet-answering node — the normal
			// way up, since hydra-node opens its API only once etcd has quorum and
			// the follower has synced — reads the stale flag, and SIGTERMs a node
			// 15s into a multi-minute startup, which then comes back
			// `lastStopUndrained` having never been wedged.
			restartRequested: false,
			// The node is being tried again, so whatever it last failed with is no
			// longer what it is doing. Leaving it made a recovered node advertise a
			// failure it had recovered from.
			failureReason: undefined,
		}));
		if (claimed === null) {
			this.logger.warn(`[supervisor] ${record.nodeId} disappeared before it could be started`);
			return;
		}
		const starting = claimed;
		const peersDir = peerKeyDirectory(nodeDir, starting.peerKeysGeneration);

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
			hydraScriptsTxIds: this.config.hydraScriptsTxIds,
			contestationPeriodSeconds: starting.contestationPeriodSeconds,
			depositPeriodSeconds: starting.depositPeriodSeconds,
			depositActivationSeconds: starting.depositActivationSeconds,
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

	private async stop(record: NodeRecord, reason: string): Promise<boolean> {
		return stopNode(record, reason, {
			client: this.client(record),
			processes: this.processes,
			store: this.store,
			config: this.config,
			logger: this.logger,
			adoptProcess: (target) => this.adoptProcess(target),
		});
	}

	private async unwedge(record: NodeRecord, reason: string): Promise<void> {
		await unwedgeRecord(record, reason, {
			client: this.client(record),
			store: this.store,
			logger: this.logger,
			allowAutoSideLoad: this.config.allowAutoSideLoad,
			settleWaitMs: STRANDED_SETTLE_WAIT_MS,
			sleep,
			isAborted: () => this.stopped,
		});
	}

	private async remove(record: NodeRecord, reason: string): Promise<void> {
		await removeNode(record, reason, {
			client: this.client(record),
			clients: this.clients,
			store: this.store,
			ports: this.ports,
			logger: this.logger,
			stop: (target, why) => this.stop(target, why),
		});
	}

	/** Drain and stop every node. Called on SIGTERM. */
	async shutdown(): Promise<void> {
		this.stopped = true;
		this.logger.info('[supervisor] shutting down; draining all nodes');
		// The in-flight tick is captured, NOT awaited first. Waiting for it up
		// front made shutdown cost two drain rounds rather than one: a tick that
		// was already stopping a node held the whole fan-out behind it, so the
		// remaining nodes only began draining once that one had finished. Measured
		// at 8.4s against a 3s per-node drain budget — against the real 155s budget
		// that is 310s, past the 240s `SHUTDOWN_GRACE_MS` in index.ts, which is the
		// exact outcome the fan-out below exists to avoid.
		//
		// Nothing the tick is still doing can spawn a node: `reconcile` bails on
		// `stopped` before it plans, and `start` gates on it again before the spawn
		// (including the second half of a Restart). So the tick can only be
		// finishing work already begun, and that work drains on the same clock this
		// does.
		const pendingTick = this.currentTick;
		const attempted = new Set<string>();
		await this.drainRunningNodes(attempted);
		// Then the tick, and a second pass for anything that appeared after the
		// first list — a provision that was already in flight when the control
		// plane closed. Nodes the first pass drained are `isRunning === false`
		// here and nodes it tried and failed to stop are in `attempted`, so this is
		// a cheap re-list on every normal shutdown.
		await pendingTick;
		await this.drainRunningNodes(attempted);
	}

	private async drainRunningNodes(attempted: Set<string>): Promise<void> {
		await drainRunningNodes(attempted, {
			store: this.store,
			processes: this.processes,
			inFlight: this.inFlight,
			logger: this.logger,
			stop: (target, why) => this.stop(target, why),
		});
	}
}
