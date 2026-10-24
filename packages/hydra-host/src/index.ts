/**
 * Hydra Host entrypoint.
 *
 * The container's PID 1 is this supervisor, not hydra-node. SIGTERM therefore
 * reaches code that knows to drain each node's snapshot round before stopping —
 * something a container runtime's restart policy could never do, which is why
 * the image ships with no restart policy of its own.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { createControlPlane } from './api/server.js';
import { createExchangePlane } from './api/exchange-server.js';
import { redemptionNetwork, verifyRedemptionSignature } from './registry/redemption-signature.js';
import { createRedemptionRecovery } from './api/redemption-recovery.js';
import { advertiseAddress, loadHostConfig } from './config.js';
import { assertStoredPeerEgressCompatibility, peerTargetRejection } from './peer-target-policy.js';
import { createBoundedPeerResolver } from './peer-dns.js';
import { assertPeerEgressAttestation } from './peer-egress-attestation.js';
import { describeUnsettleableLedgerParams } from './ledger-params.js';
import { assertExecutablesAvailable } from './preflight.js';
import { HostLock } from './registry/host-lock.js';
import { PortAllocator } from './registry/ports.js';
import { ExchangeStore } from './registry/exchange-store.js';
import { NodeRegistryStore } from './registry/store.js';
import { resolveSlotConfig } from './slot-config.js';
import { Supervisor, type SupervisorLogger } from './supervisor/supervisor.js';

const TICK_INTERVAL_MS = 15_000;
const SHUTDOWN_GRACE_MS = 240_000;

const logger: SupervisorLogger = {
	info: (message) => console.log(`${new Date().toISOString()} [info] ${message}`),
	warn: (message) => console.warn(`${new Date().toISOString()} [warn] ${message}`),
	error: (message) => console.error(`${new Date().toISOString()} [error] ${message}`),
};

/** Published before startup I/O so every fatal exit uses the same bounded cleanup. */
const cleanup: { shutdown: ((reason: string, exitCode?: 0 | 1) => void) | null } = { shutdown: null };

/** Start the Host with bounded shutdown handlers registered before startup I/O. */
async function main(): Promise<void> {
	// Shutdown requests before acquisition and the registry read finish must wait:
	// cleanup needs the lease and a supervisor that can find surviving children.
	// Once those exist, the same handler starts bounded cleanup immediately.
	const startup: {
		shutdownReason: string | null;
		supervisor: Supervisor | null;
		lock?: HostLock;
		server?: ReturnType<typeof createControlPlane>;
		exchangePlane?: ReturnType<typeof createExchangePlane>;
		timer?: ReturnType<typeof setInterval>;
	} = { shutdownReason: null, supervisor: null };
	let startupWork: Promise<void> | undefined;
	let shuttingDown = false;
	let shutdownExitCode: 0 | 1 = 0;
	const shutdown = (reason: string, exitCode: 0 | 1 = 0): void => {
		// A failure remains fatal even if a signal already started the drain.
		if (exitCode === 1) shutdownExitCode = 1;
		if (shuttingDown) {
			return;
		}
		shuttingDown = true;
		logger.info(`[host] received ${reason}`);
		startup.supervisor?.beginShutdown();
		clearInterval(startup.timer);
		startup.server?.close();
		startup.exchangePlane?.close();

		// Bound the drain so a stuck node cannot hold the container open past the
		// platform's own kill timeout; losing the race just means the next boot
		// checks for a stranded round.
		// Assigned so the intent is readable, then deliberately left alone.
		const _guard = setTimeout(() => {
			logger.error('[host] shutdown exceeded its grace period; exiting');
			// The lease goes back before the forced exit.
			// Without it the restarted container cannot acquire the data volume
			// until HEARTBEAT_STALE_AFTER_MS, so it crash-loops through
			// `main().catch -> exit(1)` for the whole of that window — a minute of
			// no supervisor on top of a shutdown that already failed to drain.
			void Promise.resolve()
				.then(() => startup.lock?.release())
				.catch(() => undefined)
				.finally(() => process.exit(1));
		}, SHUTDOWN_GRACE_MS);
		// Deliberately NOT unref'd. This timer's only job is to force a non-zero
		// exit, and an unref'd one lets an otherwise-idle loop exit 0 first — which
		// reports a shutdown that never drained as a clean one.

		// Boot can still be adopting a process, and recovery can still be writing
		// its peer files. Stop new work now, then let that work settle before
		// taking the final drain list. The referenced guard bounds this wait too.
		const drain = () => startup.supervisor?.shutdown() ?? Promise.resolve();
		void (startupWork ? startupWork.catch(() => undefined).then(drain) : drain())
			.then(async () => {
				await startup.lock?.release();
				logger.info('[host] shutdown cleanup complete; exiting');
				process.exit(shutdownExitCode);
			})
			.catch((error: unknown) => {
				logger.error(`[host] shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
				return Promise.resolve()
					.then(() => startup.lock?.release())
					.catch((releaseError: unknown) => {
						const detail = releaseError instanceof Error ? releaseError.message : String(releaseError);
						logger.error(`[host] lease release failed after shutdown error: ${detail}`);
					})
					.finally(() => process.exit(1));
			});
	};
	cleanup.shutdown = shutdown;
	const requestShutdown = (reason: string, exitCode: 0 | 1 = 0): void => {
		if (exitCode === 1) shutdownExitCode = 1;
		startup.shutdownReason ??= reason;
		if (startup.supervisor !== null) shutdown(reason, exitCode);
	};
	process.on('SIGTERM', () => requestShutdown('SIGTERM'));
	process.on('SIGINT', () => requestShutdown('SIGINT'));

	const config = loadHostConfig();
	// The host process cannot read its machine's nft table from the container.
	// The root-owned bind mount records a rule verified just before Docker start.
	if (config.requirePeerEgressFirewall) assertPeerEgressAttestation(config.ports);

	// Fail fast on a missing ledger params file. Only networks with a reviewed
	// base are generated, so a network we have not validated surfaces here with a
	// clear message rather than as an opaque hydra-node startup failure — or,
	// worse, a head running on someone else's chain parameters.
	if (!existsSync(config.ledgerProtocolParametersFile)) {
		throw new Error(
			`no ledger protocol parameters for network "${config.network}" at ${config.ledgerProtocolParametersFile}. ` +
				'Generate them with: pnpm --filter @masumi/payment-source-v2 run generate:hydra-params ' +
				'(a network needs a reviewed base file in packages/hydra-host/params/base first)',
		);
	}
	// Logged here and enforced on every node not yet acked and peered (see
	// `ledger-params.ts`): refusing the boot would also stop the nodes of heads
	// already open on this file.
	const ledgerParamsRefusal = describeUnsettleableLedgerParams(config.ledgerProtocolParametersFile);
	if (ledgerParamsRefusal !== null) {
		logger.error(
			`[host] ${ledgerParamsRefusal}. Running nodes keep running; nodes not yet acked and peered are refused`,
		);
	}

	// Same reasoning for the two executables every node needs. Neither is used
	// until a node is provisioned, and a node that cannot find them dies seconds
	// after start with the reason buried in its own log — the supervisor retries
	// five times, gives up with "a restart is unlikely to fix it", and the
	// operator is left with a Failed node and no cause. Checked once, at boot,
	// where the fix is a single environment variable.
	assertExecutablesAvailable(config);

	// Refuse to boot if another Host already owns this volume: both would spawn a
	// process per node, giving duplicate hydra-nodes and two etcd members
	// claiming one participant identity.
	startup.lock = new HostLock(config.dataDir, os.hostname(), Date.now, (reason) => {
		logger.error(`[host] data-volume lease lost: ${reason}`);
		requestShutdown('LOCK_LOST', 1);
	});
	await startup.lock.acquire();
	if (shuttingDown) return;

	const store = new NodeRegistryStore(config.dataDir);
	const exchange = new ExchangeStore(config.dataDir);

	// Port allocation is rebuilt from the durable registry rather than kept in
	// memory, so a restart cannot reissue a live node's peer port.
	const existing = await store.list();
	if (shuttingDown) return;
	if (config.requirePeerEgressFirewall) {
		assertStoredPeerEgressCompatibility(existing, config.ports);
	}
	const allocator = new PortAllocator(
		config.ports,
		existing.map((record) => record.peerPort),
		{ requirePeerFirewallRefresh: config.requirePeerFirewallRefresh },
	);
	for (const { peerPort, reason } of allocator.unclaimablePorts) {
		// Loud, because the node holding it keeps running and keeps that port
		// bound: nothing here will hand the number out again, but an operator who
		// narrowed the range is now running a node the layout cannot describe.
		logger.error(
			`[host] peer port ${peerPort} ${reason}; the node holding it still runs, but this layout cannot account for it. ` +
				'Restore the previous HYDRA_HOST_PEER_PORT_START / _COUNT, or remove that node',
		);
	}
	logger.info(`[host] ${allocator.used} of ${config.ports.capacity} node slots in use`);
	if (config.requirePeerFirewallRefresh) {
		logger.info('[host] provisioning waits for the first acknowledged hydra-peer-firewall refresh');
	}
	if (config.acceptHostWideUserToken) {
		logger.warn(
			'[host] the Host-wide user token still opens every node on this Host; set HYDRA_HOST_ACCEPT_HOST_WIDE_USER_TOKEN=false once every payment service presents node tokens',
		);
	}

	const supervisor = new Supervisor(config, store, allocator, resolveSlotConfig(config.network), logger);
	startup.supervisor = supervisor;
	// Drain surviving children without entering boot after an earlier request.
	if (startup.shutdownReason !== null) {
		shutdown(startup.shutdownReason, shutdownExitCode);
		return;
	}
	// A ref'd handle for the length of the boot. Every wait the supervisor and
	// the process manager use is unref'd on purpose (a stray timer must never
	// hold the host open at exit), the HostLock heartbeat is unref'd too, and the
	// HTTP listeners are not bound until after this returns — so during boot the
	// process can hold NO ref'd handle at all. A boot that ends up stopping an
	// adopted node then polls for its exit on unref'd sleeps against a process
	// that is not a child handle, the loop drains, and node exits 0 mid-stop:
	// hydra-node SIGTERMed, the record left saying Draining, and no log line.
	const bootKeepAlive = setInterval(() => {}, 60_000);
	try {
		startupWork = supervisor.boot({ reconcile: false });
		await startupWork;
		startupWork = undefined;
		// Shutdown already waits for the supervisor's tick and drains other nodes
		// in parallel. Holding it behind boot's first tick adds two drain rounds.
		if (!shuttingDown) await supervisor.tick();
	} finally {
		startupWork = undefined;
		clearInterval(bootKeepAlive);
	}
	if (shuttingDown) return;

	const resolvePeerHostname = createBoundedPeerResolver();
	const checkPeerTarget = async (advertise: string, signal?: AbortSignal, owner?: string): Promise<string | null> =>
		await peerTargetRejection(advertise, {
			allowPrivate: config.allowPrivatePeers,
			egressPortLayout: config.requirePeerEgressFirewall ? config.ports : undefined,
			resolve: resolvePeerHostname,
			signal,
			owner,
		});

	const provisionDeps = {
		store,
		ports: allocator,
		advertiseFor: (peerPort: number) => advertiseAddress(config, peerPort),
		newNodeId: () => randomUUID(),
		now: () => new Date(),
		checkPeerTarget,
		// Passed, or the one report that must never be silent is: a provision that
		// fails after writing signing keys and then fails to clean them up leaves
		// key material on the volume for a node no record mentions. Without this,
		// that rollback failure was logged to an optional logger nothing supplied.
		logger,
		ledgerParamsRefusal,
	};

	const recoverRedemptions = createRedemptionRecovery(exchange, provisionDeps, logger);
	const tickSupervisor = (source: string): void => {
		void recoverRedemptions()
			.then(() => supervisor.tick())
			.catch((error: unknown) => {
				logger.error(`[host] supervisor tick from ${source} failed: ${(error as Error).message}`);
			});
	};
	try {
		startupWork = recoverRedemptions();
		await startupWork;
	} finally {
		startupWork = undefined;
	}
	if (shuttingDown) return;

	startup.server = createControlPlane({
		config,
		store,
		exchange,
		ports: allocator,
		supervisor,
		provision: provisionDeps,
		logger,
	});
	// A second listener, not a second path. Redeeming an invite configures and
	// starts the node that invite reserved — the only thing a counterparty can
	// cause here, and the reason the node existed at all.
	startup.exchangePlane = createExchangePlane({
		store: exchange,
		logger,
		trustProxy: config.exchangeTrustProxy,
		checkPeerTarget,
		verifyRedemption: async (nonce, redeemer, signature) =>
			await verifyRedemptionSignature(nonce, redemptionNetwork(config.network), redeemer, signature),
		isNodeStopped: async (hostNodeId) => (await store.read(hostNodeId))?.desired === 'Stopped',
		ledgerParamsRefusal,
		onRedeemed: async () => {
			await recoverRedemptions();
			tickSupervisor('exchange redemption');
		},
	});
	startup.timer = setInterval(() => tickSupervisor('interval'), TICK_INTERVAL_MS);

	// Install the common drain path before either listener can fail. Supervisor
	// boot has adopted or started nodes that must stop before the lease is released.
	startup.server.on('error', (error: NodeJS.ErrnoException) => {
		const detail =
			error.code === 'EADDRINUSE'
				? `port ${config.listenPort} is already in use; another Hydra Host may still be running`
				: error.message;
		logger.error(`[host] control plane could not listen: ${detail}`);
		shutdown('CONTROL_LISTEN_ERROR', 1);
	});
	startup.exchangePlane.on('error', (error: NodeJS.ErrnoException) => {
		const detail = error.code === 'EADDRINUSE' ? `port ${config.exchangePort} is already in use` : error.message;
		logger.error(`[host] exchange plane could not listen: ${detail}`);
		shutdown('EXCHANGE_LISTEN_ERROR', 1);
	});
	startup.server.listen(config.listenPort, () => {
		logger.info(`[host] control plane listening on :${config.listenPort}`);
	});
	startup.exchangePlane.listen(config.exchangePort, () => {
		logger.info(`[host] exchange plane listening on :${config.exchangePort}`);
	});
}

main().catch((error: unknown) => {
	logger.error(`[host] failed to start: ${error instanceof Error ? error.message : String(error)}`);
	if (cleanup.shutdown === null) {
		process.exit(1);
	} else {
		cleanup.shutdown('STARTUP_ERROR', 1);
	}
});
