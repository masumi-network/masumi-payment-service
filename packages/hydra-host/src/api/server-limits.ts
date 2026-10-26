import type { Server } from 'node:http';

// Preserve the default 32-slot Host's budget of eight control sockets per
// Head as operators raise its supported node capacity. A fixed cap can refuse
// a live session for a valid Head before its peer ports are exhausted.
const CONTROL_CONNECTIONS_PER_HEAD = 8;
const MIN_CONTROL_CONNECTIONS = 256;
// A socket that moves no bytes for this long is closed. Answers the Host builds
// itself finish well inside it, so only a stalled or slow-reading client hits
// it. Proxied node traffic opts out per socket.
const CONTROL_IDLE_TIMEOUT_MS = 60_000;
const DROP_WARNING_INTERVAL_MS = 60_000;

/**
 * Bound how long and how many connections may occupy the control plane. It
 * normally sits behind a load balancer, but the peer plane is public and there
 * is no reason to assume this port never will be.
 */
export function applyControlPlaneLimits(server: Server, headCapacity: number, warn: (message: string) => void): void {
	server.headersTimeout = 15_000;
	server.requestTimeout = 30_000;
	server.keepAliveTimeout = 10_000;
	server.timeout = CONTROL_IDLE_TIMEOUT_MS;
	server.maxConnections = Math.max(MIN_CONTROL_CONNECTIONS, headCapacity * CONTROL_CONNECTIONS_PER_HEAD);

	// Node drops a connection over the cap without a word. Say so at once, then
	// at most once a minute while drops continue, so a flood or an undersized
	// cap shows in the logs with every drop counted.
	let droppedSinceWarning = 0;
	let warningTimer: NodeJS.Timeout | null = null;
	const reportDrops = (): void => {
		if (droppedSinceWarning === 0) {
			warningTimer = null;
			return;
		}
		warn(
			`[api] control plane is at its ${server.maxConnections}-connection cap; ` +
				`dropped ${droppedSinceWarning} connection(s) since the last warning`,
		);
		droppedSinceWarning = 0;
		warningTimer = setTimeout(reportDrops, DROP_WARNING_INTERVAL_MS);
		warningTimer.unref();
	};
	server.on('drop', () => {
		droppedSinceWarning += 1;
		if (warningTimer === null) reportDrops();
	});
	server.on('close', () => {
		if (warningTimer !== null) clearTimeout(warningTimer);
	});
}
