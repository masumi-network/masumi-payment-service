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
import { setPeers } from './api/provision.js';
import { requestStart } from './api/transitions.js';
import { advertiseAddress, loadHostConfig } from './config.js';
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

async function main(): Promise<void> {
	// Installed before anything can spawn a hydra-node. `supervisor.boot()` below
	// adopts and starts nodes, and until the real handlers exist a signal there
	// took the default disposition: the host died instantly and whatever boot had
	// just spawned kept running undrained, holding its peer port past the only
	// process that knew how to drain it. Recorded rather than acted on, because
	// there is no supervisor to drain through yet; the real handler replays it.
	// Held on an object rather than in a `let`, so the read after the handlers are
	// swapped is not narrowed to `never` by flow analysis that cannot see the
	// closures below run.
	// `supervisor` is filled in as soon as it exists, so a signal arriving during
	// the long part of startup stops the boot where it is rather than being merely
	// recorded and waited out.
	const startup: { signal: string | null; supervisor: Supervisor | null } = { signal: null, supervisor: null };
	const recordSignal = (signal: string): void => {
		startup.signal ??= signal;
		startup.supervisor?.beginShutdown();
	};
	const deferSigterm = (): void => recordSignal('SIGTERM');
	const deferSigint = (): void => recordSignal('SIGINT');
	process.on('SIGTERM', deferSigterm);
	process.on('SIGINT', deferSigint);

	const config = loadHostConfig();

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
	let handleLeaseLoss = (reason: string): void => {
		logger.error(`[host] data-volume lease lost during startup: ${reason}`);
		process.exit(1);
	};
	const lock = new HostLock(config.dataDir, os.hostname(), Date.now, (reason) => handleLeaseLoss(reason));
	await lock.acquire();

	const store = new NodeRegistryStore(config.dataDir);
	const exchange = new ExchangeStore(config.dataDir);

	// Port allocation is rebuilt from the durable registry rather than kept in
	// memory, so a restart cannot reissue a live node's peer port.
	const existing = await store.list();
	const allocator = new PortAllocator(
		config.ports,
		existing.map((record) => record.peerPort),
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

	const supervisor = new Supervisor(config, store, allocator, resolveSlotConfig(config.network), logger);
	startup.supervisor = supervisor;
	// A signal that landed before the supervisor existed still has to reach it.
	if (startup.signal !== null) {
		supervisor.beginShutdown();
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
		await supervisor.boot();
	} finally {
		clearInterval(bootKeepAlive);
	}
	const tickSupervisor = (source: string): void => {
		void supervisor.tick().catch((error: unknown) => {
			logger.error(`[host] supervisor tick from ${source} failed: ${(error as Error).message}`);
		});
	};

	const provisionDeps = {
		store,
		ports: allocator,
		advertiseFor: (peerPort: number) => advertiseAddress(config, peerPort),
		newNodeId: () => randomUUID(),
		now: () => new Date(),
		// Passed, or the one report that must never be silent is: a provision that
		// fails after writing signing keys and then fails to clean them up leaves
		// key material on the volume for a node no record mentions. Without this,
		// that rollback failure was logged to an optional logger nothing supplied.
		logger,
	};

	const server = createControlPlane({
		config,
		store,
		exchange,
		ports: allocator,
		supervisor,
		provision: provisionDeps,
		logger,
	});
	// Without this the listen failure surfaces as an unhandled 'error' event and
	// a raw stack trace. The two ways this fails in production — the port is
	// taken, or the port is privileged — both have one-line explanations, and a
	// Host that cannot serve its control plane must exit rather than sit there
	// supervising nodes nobody can reach.
	server.on('error', (error: NodeJS.ErrnoException) => {
		const detail =
			error.code === 'EADDRINUSE'
				? `port ${config.listenPort} is already in use; another Hydra Host may still be running`
				: error.message;
		logger.error(`[host] control plane could not listen: ${detail}`);
		void lock.release().finally(() => process.exit(1));
	});
	server.listen(config.listenPort, () => {
		logger.info(`[host] control plane listening on :${config.listenPort}`);
	});

	// A second listener, not a second path. Redeeming an invite configures and
	// starts the node that invite reserved — the only thing a counterparty can
	// cause here, and the reason the node existed at all.
	const exchangePlane = createExchangePlane({
		store: exchange,
		logger,
		onRedeemed: async (nonce, hostNodeId) => {
			const invite = (await exchange.listInvites()).find((candidate) => candidate.nonce === nonce);
			if (invite?.redeemer == null) {
				throw new Error(`invite ${nonce} has no redeemer material`);
			}
			// Same path the control plane uses: record the peers, express the
			// intent to run, and let the supervisor do the work. Driving the
			// process directly from here would bypass the guarded transitions
			// that keep `state` and `desired` honest.
			await setPeers(
				hostNodeId,
				[
					{
						advertise: invite.redeemer.advertise,
						hydraVerificationKey: invite.redeemer.hydraVerificationKey,
						cardanoVerificationKey: invite.redeemer.cardanoVerificationKey,
					},
				],
				provisionDeps,
			);
			await requestStart(store, hostNodeId);
			tickSupervisor('exchange redemption');
			logger.info(`[exchange] invite ${nonce} redeemed; node ${hostNodeId} starting`);
		},
	});
	exchangePlane.on('error', (error: NodeJS.ErrnoException) => {
		const detail = error.code === 'EADDRINUSE' ? `port ${config.exchangePort} is already in use` : error.message;
		logger.error(`[host] exchange plane could not listen: ${detail}`);
		void lock.release().finally(() => process.exit(1));
	});
	exchangePlane.listen(config.exchangePort, () => {
		logger.info(`[host] exchange plane listening on :${config.exchangePort}`);
	});

	const timer = setInterval(() => tickSupervisor('interval'), TICK_INTERVAL_MS);

	let shuttingDown = false;
	const shutdown = (signal: string): void => {
		if (shuttingDown) {
			return;
		}
		shuttingDown = true;
		logger.info(`[host] received ${signal}`);
		clearInterval(timer);
		server.close();
		exchangePlane.close();

		// Bound the drain so a stuck node cannot hold the container open past the
		// platform's own kill timeout; losing the race just means the next boot
		// checks for a stranded round.
		// Assigned so the intent is readable, then deliberately left alone.
		const _guard = setTimeout(() => {
			logger.error('[host] shutdown exceeded its grace period; exiting');
			// The lease goes back first, as it does on both listen-error paths.
			// Without it the restarted container cannot acquire the data volume
			// until HEARTBEAT_STALE_AFTER_MS, so it crash-loops through
			// `main().catch -> exit(1)` for the whole of that window — a minute of
			// no supervisor on top of a shutdown that already failed to drain.
			void lock
				.release()
				.catch(() => undefined)
				.finally(() => process.exit(1));
		}, SHUTDOWN_GRACE_MS);
		// Deliberately NOT unref'd. This timer's only job is to force a non-zero
		// exit, and an unref'd one lets an otherwise-idle loop exit 0 first — which
		// reports a shutdown that never drained as a clean one.

		void supervisor
			.shutdown()
			.then(async () => {
				await lock.release();
				logger.info('[host] all nodes drained; exiting');
				process.exit(0);
			})
			.catch((error: unknown) => {
				logger.error(`[host] shutdown failed: ${(error as Error).message}`);
				process.exit(1);
			});
	};
	handleLeaseLoss = (reason: string): void => {
		logger.error(`[host] data-volume lease lost: ${reason}`);
		shutdown('LOCK_LOST');
	};

	// Added before the deferred ones are removed, not after. `process.off` of the
	// last listener for a signal restores the OS default disposition, so the two
	// statements in the other order leave a window — however short — in which
	// SIGTERM kills the host outright with every node undrained. A transient
	// double registration is harmless: `shuttingDown` makes the second call a
	// no-op, and the deferred recorder only writes to `startup`.
	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('SIGINT', () => shutdown('SIGINT'));
	process.off('SIGTERM', deferSigterm);
	process.off('SIGINT', deferSigint);
	if (startup.signal !== null) {
		logger.info(`[host] ${startup.signal} arrived during startup; draining now`);
		shutdown(startup.signal);
	}
}

main().catch((error: unknown) => {
	logger.error(`[host] failed to start: ${(error as Error).message}`);
	process.exit(1);
});
