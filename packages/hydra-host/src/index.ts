/**
 * Hydra Host entrypoint.
 *
 * The container's PID 1 is this supervisor, not hydra-node. SIGTERM therefore
 * reaches code that knows to drain each node's snapshot round before stopping —
 * something a container runtime's restart policy could never do, which is why
 * the image ships with no restart policy of its own.
 */

import { loadHostConfig } from './config.js';
import { PortAllocator } from './registry/ports.js';
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
	const config = loadHostConfig();
	const store = new NodeRegistryStore(config.dataDir);

	// Port allocation is rebuilt from the durable registry rather than kept in
	// memory, so a restart cannot reissue a live node's peer port.
	const existing = await store.list();
	const allocator = new PortAllocator(
		config.ports,
		existing.map((record) => record.peerPort),
	);
	logger.info(`[host] ${allocator.used} of ${config.ports.capacity} node slots in use`);

	const supervisor = new Supervisor(config, store, allocator, resolveSlotConfig(config.network), logger);
	await supervisor.boot();

	const timer = setInterval(() => void supervisor.tick(), TICK_INTERVAL_MS);

	let shuttingDown = false;
	const shutdown = (signal: string): void => {
		if (shuttingDown) {
			return;
		}
		shuttingDown = true;
		logger.info(`[host] received ${signal}`);
		clearInterval(timer);

		// Bound the drain so a stuck node cannot hold the container open past the
		// platform's own kill timeout; losing the race just means the next boot
		// checks for a stranded round.
		const guard = setTimeout(() => {
			logger.error('[host] shutdown exceeded its grace period; exiting');
			process.exit(1);
		}, SHUTDOWN_GRACE_MS);
		guard.unref?.();

		void supervisor
			.shutdown()
			.then(() => {
				logger.info('[host] all nodes drained; exiting');
				process.exit(0);
			})
			.catch((error: unknown) => {
				logger.error(`[host] shutdown failed: ${(error as Error).message}`);
				process.exit(1);
			});
	};

	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
	logger.error(`[host] failed to start: ${(error as Error).message}`);
	process.exit(1);
});
