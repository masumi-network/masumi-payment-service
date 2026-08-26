/**
 * Talking to a node's own API through the Host proxy, and closing a head down.
 *
 * Shared by the head-init phase and the resume helper, because a run that opens
 * a head and a session that finds one already open need exactly the same
 * teardown — and getting it wrong strands funds in a script address.
 */

import WebSocket from 'ws';

export type Observed = { tags: string[]; messages: Array<Record<string, unknown>>; error: string | null };

export type NodeEndpoint = { baseUrl: string; nodeId: string; token: string; label: string };

/**
 * Send one command and collect what comes back.
 *
 * Always through the Host proxy with a real token, which is the only route the
 * payment service has to a node — so this exercises the upgrade path, the token
 * check and the path allow-list alongside the protocol itself.
 */
export function sendCommand(node: NodeEndpoint, command: unknown, durationMs: number): Promise<Observed> {
	const url = `${node.baseUrl.replace(/^http/, 'ws')}/v1/nodes/${node.nodeId}/api`;
	return new Promise((resolve) => {
		const tags: string[] = [];
		const messages: Array<Record<string, unknown>> = [];
		let error: string | null = null;

		const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${node.token}` } });
		const finish = (): void => resolve({ tags, messages, error });
		const timer = setTimeout(() => {
			socket.close();
			finish();
		}, durationMs);

		socket.on('open', () => {
			if (command !== undefined) {
				socket.send(JSON.stringify(command));
			}
		});
		socket.on('message', (raw: Buffer) => {
			try {
				const parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
				messages.push(parsed);
				if (typeof parsed.tag === 'string') {
					tags.push(parsed.tag);
				}
			} catch {
				// Non-JSON frame; nothing to assert on.
			}
		});
		socket.on('error', (cause: Error) => {
			error = cause.message;
		});
		socket.on('close', () => {
			clearTimeout(timer);
			finish();
		});
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The node's current view of its head.
 *
 * Read from `Greetings`, which carries the status on every connect — so this
 * does not depend on catching a transient event as it happens.
 */
export async function headStatus(node: NodeEndpoint): Promise<string> {
	const observed = await sendCommand(node, { tag: 'GetUTxO' }, 12_000);
	if (observed.error !== null && observed.messages.length === 0) {
		return `error: ${observed.error}`;
	}
	const greeting = observed.messages.find((message) => message.tag === 'Greetings');
	const status = greeting?.headStatus;
	return typeof status === 'string' ? status : '(no greeting)';
}

/** Poll until the head reaches `expected`, or the deadline passes. */
export async function waitForHeadStatus(
	node: NodeEndpoint,
	expected: string | string[],
	timeoutMs = 600_000,
): Promise<boolean> {
	const wanted = Array.isArray(expected) ? expected : [expected];
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (wanted.includes(await headStatus(node))) {
			return true;
		}
		await sleep(20_000);
	}
	return false;
}

export type TeardownResult = { path: string; ok: boolean; finalStatus: string };

/**
 * Return a head to `Idle`, whichever state it is in.
 *
 * The two paths are not interchangeable. `Abort` is only legal while the head
 * is still `Initializing`; once it is `Open` the funds are committed and the
 * only way out is `Close`, waiting out the contestation period, then `Fanout`.
 * Sending the wrong one is silently ignored, which looks like the command was
 * lost.
 */
export async function teardownHead(
	node: NodeEndpoint,
	log: (message: string) => void = () => undefined,
): Promise<TeardownResult> {
	const status = await headStatus(node);

	if (status === 'Idle') {
		return { path: 'none', ok: true, finalStatus: status };
	}

	if (status === 'Initializing') {
		log(`${node.label}: aborting an initialising head`);
		await sendCommand(node, { tag: 'Abort' }, 30_000);
		const ok = await waitForHeadStatus(node, 'Idle');
		return { path: 'abort', ok, finalStatus: await headStatus(node) };
	}

	if (status === 'Open' || status === 'Closed' || status === 'FanoutPossible') {
		if (status === 'Open') {
			log(`${node.label}: closing an open head`);
			await sendCommand(node, { tag: 'Close' }, 30_000);
			// The contestation period has to elapse before a fanout is accepted.
			if (!(await waitForHeadStatus(node, ['Closed', 'FanoutPossible'], 300_000))) {
				return { path: 'close', ok: false, finalStatus: await headStatus(node) };
			}
		}
		log(`${node.label}: waiting out the contestation period`);
		if (!(await waitForHeadStatus(node, 'FanoutPossible', 600_000))) {
			return { path: 'close', ok: false, finalStatus: await headStatus(node) };
		}
		log(`${node.label}: fanning out`);
		await sendCommand(node, { tag: 'Fanout' }, 30_000);
		const ok = await waitForHeadStatus(node, 'Idle', 600_000);
		return { path: 'close+fanout', ok, finalStatus: await headStatus(node) };
	}

	return { path: 'unknown', ok: false, finalStatus: status };
}
