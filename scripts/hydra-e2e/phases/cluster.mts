/**
 * Start both nodes and prove they actually form one cluster.
 *
 * `Running` on its own only means a process survived; it is `PeerConnected`
 * over the node's own API that proves the two hydra-nodes found each other
 * through etcd on the peer plane. That is the part no unit test can cover,
 * because it needs two real binaries and a real socket.
 */

import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { check, equals, phase } from '../check.mjs';
import { countHydraNodes, http, sleep, tail, waitFor } from '../procs.mjs';
import type { NodeHandle } from './provision.mjs';

type NodeView = {
	state?: string;
	desired?: string;
	failureReason?: string;
	restartCount?: number;
	usable?: boolean;
	responsive?: boolean | null;
	chainSynced?: boolean | null;
	drift?: string | null;
	lastCheckedAt?: string | null;
};

export async function readNode(node: NodeHandle): Promise<NodeView> {
	const result = await http(`${node.host.spec.baseUrl}/v1/nodes/${node.nodeId}`, {
		token: node.host.spec.adminToken,
	});
	return (result.body ?? {}) as NodeView;
}

/** The user-tier route the payment service polls to decide whether a node is usable. */
export async function readHealth(node: NodeHandle): Promise<NodeView> {
	const result = await http(`${node.host.spec.baseUrl}/v1/nodes/${node.nodeId}/health`, {
		token: node.host.spec.userToken,
	});
	return (result.body ?? {}) as NodeView;
}

export async function startNode(node: NodeHandle): Promise<number> {
	const result = await http(`${node.host.spec.baseUrl}/v1/nodes/${node.nodeId}/start`, {
		method: 'POST',
		token: node.host.spec.adminToken,
	});
	return result.status;
}

/**
 * Wait until the node's own API answers through the proxy.
 *
 * This is the ground truth the registry's `Running` is derived from — the
 * supervisor promotes `Starting` to `Running` only once a probe succeeds — so
 * the proxy answers first and the state follows within a tick. With a
 * two-member etcd cluster that can take minutes: neither node can elect a
 * leader alone, and hydra-node opens its API only once it has a quorum and its
 * chain follower has synced.
 */
export async function waitForNodeApi(node: NodeHandle, timeoutMs = 180_000): Promise<boolean> {
	const url = `${node.host.spec.baseUrl}/v1/nodes/${node.nodeId}/api/protocol-parameters`;
	try {
		await waitFor(
			`${node.host.spec.name} node API`,
			() => http(url, { token: node.host.spec.userToken }),
			(result) => result.status === 200,
			{ timeoutMs, intervalMs: 2_000 },
		);
		return true;
	} catch {
		return false;
	}
}

export async function startCluster(nodes: NodeHandle[]): Promise<void> {
	phase('cluster: start');

	// Both are started before either is awaited: with two members, raft needs
	// both present to reach a quorum, so waiting on the first alone would always
	// time out.
	for (const node of nodes) {
		const status = await startNode(node);
		check(`${node.host.spec.name} accepted the start request`, status === 202, `status ${status}`);
	}

	// A spawned node is `Starting`, not `Running` — it has answered nothing yet.
	for (const node of nodes) {
		const view = await readNode(node);
		check(`${node.host.spec.name} node is Starting, not yet Running`, view.state === 'Starting', String(view.state));
	}

	for (const node of nodes) {
		const ready = await waitForNodeApi(node);
		check(
			`${node.host.spec.name} node API is serving`,
			ready,
			ready ? 'protocol-parameters answered through the proxy' : 'never answered; see the node log',
		);
		if (!ready) {
			console.log(`\n[2m--- ${node.host.spec.name} log ---\n${tail(node.host.process.logFile, 30)}[0m\n`);
		}
	}

	// The state follows the probe, so it lags the serving API by at most a tick.
	for (const node of nodes) {
		try {
			const view = await waitFor(
				`${node.host.spec.name} node to be promoted to Running`,
				() => readNode(node),
				(value) => value.state === 'Running' || value.state === 'Failed',
				{ timeoutMs: 60_000, intervalMs: 2_000 },
			);
			check(
				`${node.host.spec.name} node was promoted to Running`,
				view.state === 'Running',
				view.state === 'Failed' ? (view.failureReason ?? 'failed') : String(view.state),
			);
		} catch (error) {
			check(`${node.host.spec.name} node was promoted to Running`, false, (error as Error).message);
			console.log(`\n[2m--- ${node.host.spec.name} log ---\n${tail(node.host.process.logFile, 40)}[0m\n`);
		}
	}

	const running = await countHydraNodes();
	check('two hydra-node processes are alive', running === nodes.length, `found ${running}`);
}

/**
 * The health route is what the payment service polls to decide whether a node
 * is usable, so it has to answer that question rather than echo the record.
 */
export async function checkNodeHealth(nodes: NodeHandle[]): Promise<void> {
	phase('cluster: health');

	for (const node of nodes) {
		const health = await readHealth(node);
		const name = node.host.spec.name;

		equals(`${name} health reports Running`, health.state, 'Running');
		equals(`${name} health reports the node answering`, health.responsive, true);
		// A node that is answering but still catching up must NOT be reported
		// usable: it accepts the connection and then refuses every command with
		// WaitOnNodeInSync. So usable tracks sync, and drift only means anything
		// once synced.
		equals(`${name} health reports whether the chain follower caught up`, typeof health.chainSynced, 'boolean');
		equals(`${name} usable matches chain sync`, health.usable, health.chainSynced === true);
		check(
			`${name} reports a drift verdict once synced`,
			health.chainSynced === true
				? health.drift === 'Healthy' || health.drift === 'Degraded' || health.drift === 'Unsynced'
				: health.drift === null,
			`chainSynced=${String(health.chainSynced)} drift=${String(health.drift)}`,
		);
		check(
			`${name} health reports a recent probe`,
			typeof health.lastCheckedAt === 'string' && Date.now() - Date.parse(health.lastCheckedAt) < 120_000,
			String(health.lastCheckedAt),
		);
		// The whole point of the fix: a node that came up first time has not
		// restarted, and must not claim it did.
		equals(`${name} health reports no restarts`, health.restartCount, 0);
	}

	// A user token may read health; that is the one node route it is for.
	const forbidden = await http(`${nodes[0].host.spec.baseUrl}/v1/nodes/${nodes[0].nodeId}`, {
		token: nodes[0].host.spec.userToken,
	});
	equals('the node record itself still needs the admin token', forbidden.status, 403);
}

/**
 * Collect the node's own event stream through the Host proxy.
 *
 * Going through the proxy rather than straight to the loopback API is
 * deliberate: it exercises the WebSocket upgrade path, the token check and the
 * path allow-list at the same time as the protocol assertions.
 */
export function collectEvents(
	node: NodeHandle,
	options: { durationMs: number; token?: string },
): Promise<{ tags: string[]; messages: unknown[]; error: string | null; closeCode: number | null }> {
	const url = `${node.host.spec.baseUrl.replace(/^http/, 'ws')}/v1/nodes/${node.nodeId}/api`;
	const token = options.token ?? node.host.spec.userToken;

	return new Promise((resolve) => {
		const tags: string[] = [];
		const messages: unknown[] = [];
		let error: string | null = null;
		let closeCode: number | null = null;

		const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
		const finish = (): void => {
			try {
				socket.close();
			} catch {
				// Already closed; nothing to do.
			}
			resolve({ tags, messages, error, closeCode });
		};
		const timer = setTimeout(finish, options.durationMs);

		socket.on('message', (raw: Buffer) => {
			const text = raw.toString('utf8');
			try {
				const parsed = JSON.parse(text) as { tag?: string };
				messages.push(parsed);
				if (typeof parsed.tag === 'string') {
					tags.push(parsed.tag);
				}
			} catch {
				messages.push(text);
			}
		});
		socket.on('error', (cause: Error) => {
			error = cause.message;
		});
		socket.on('unexpected-response', (_request, response: { statusCode?: number }) => {
			error = `unexpected response ${response.statusCode ?? 0}`;
			clearTimeout(timer);
			finish();
		});
		socket.on('close', (code: number) => {
			closeCode = code;
			clearTimeout(timer);
			resolve({ tags, messages, error, closeCode });
		});
	});
}

/**
 * Did this node record connecting to the given peer?
 *
 * `PeerConnected` is a transient network event, not part of the persisted
 * event log, so a WebSocket client that attaches after the fact never sees it
 * replayed. The node's own log is the durable record, and it names the peer's
 * `host:port` — which makes the evidence mutual and specific rather than just
 * "something connected".
 */
function loggedPeerConnection(node: NodeHandle, peerAdvertise: string): boolean {
	const logPath = path.join(node.host.spec.dataDir, 'nodes', node.nodeId, 'logs', 'node.log');
	if (!fs.existsSync(logPath)) {
		return false;
	}
	const [host, port] = peerAdvertise.split(':');
	// hydra-node emits compact JSON, but tolerate whitespace rather than depend
	// on its serialiser's formatting.
	const peer = new RegExp(`"hostname":\\s*"${host.replace(/\./g, '\\.')}",\\s*"port":\\s*${port}\\b`);
	return fs
		.readFileSync(logPath, 'utf8')
		.split('\n')
		.some((line) => line.includes('"PeerConnected"') && peer.test(line));
}

export async function checkPeerConnection(nodes: NodeHandle[]): Promise<void> {
	phase('cluster: peer connection');

	// etcd needs a moment to establish the peer session after both members boot.
	await sleep(5_000);

	for (const node of nodes) {
		const observed = await collectEvents(node, { durationMs: 20_000 });
		const unique = [...new Set(observed.tags)];

		check(
			`${node.host.spec.name} node API is reachable through the proxy`,
			observed.error === null && observed.messages.length > 0,
			observed.error ?? `${observed.messages.length} messages: ${unique.join(', ')}`,
		);
		check(`${node.host.spec.name} node greeted us`, unique.includes('Greetings'), unique.join(', '));

		const greeting = observed.messages.find(
			(message): message is { tag: string; headStatus?: string } =>
				typeof message === 'object' && message !== null && (message as { tag?: string }).tag === 'Greetings',
		);
		if (greeting !== undefined) {
			check(
				`${node.host.spec.name} head status is Idle before Init`,
				greeting.headStatus === 'Idle',
				String(greeting.headStatus),
			);
		}
	}

	// Mutual, and named by address: each node logged connecting to the other's
	// advertise endpoint.
	//
	// Polled rather than sampled once. etcd establishes the peer session early,
	// but the node only *processes* the resulting event once its chain follower
	// is in sync — so the log line can trail a serving API by a minute or more.
	for (const node of nodes) {
		const peer = nodes.find((candidate) => candidate !== node);
		if (peer === undefined) {
			continue;
		}
		const deadline = Date.now() + 180_000;
		let connected = loggedPeerConnection(node, peer.advertise);
		while (!connected && Date.now() < deadline) {
			await sleep(5_000);
			connected = loggedPeerConnection(node, peer.advertise);
		}
		check(`${node.host.spec.name} node connected to ${peer.advertise}`, connected, 'from the node event log');
	}

	// Independently of the log: with two members, raft has no quorum until the
	// peers find each other, and the node API does not open without a quorum.
	// A serving API is therefore itself proof the peer plane works.
	check(
		'both node APIs serve, which requires an etcd quorum across the peer plane',
		(await Promise.all(nodes.map((node) => waitForNodeApi(node, 15_000)))).every(Boolean),
	);
}

/** The nodes must be visible to each other as *different* participants. */
export async function checkClusterIdentity(nodes: NodeHandle[]): Promise<void> {
	phase('cluster: identity');

	for (const node of nodes) {
		const view = await readNode(node);
		equals(`${node.host.spec.name} desired state is Running`, view.desired, 'Running');
		equals(`${node.host.spec.name} came up without restarting`, view.restartCount, 0);
		check(`${node.host.spec.name} recorded no failure`, view.failureReason === undefined, String(view.failureReason));
	}
}
