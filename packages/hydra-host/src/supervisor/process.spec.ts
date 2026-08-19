import { afterEach, describe, expect, it } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import { isProcessAlive, isProcessRunningNode, NodeProcessManager } from './process.js';

/**
 * Adoption is what makes a host restart survivable: the hydra-nodes keep running
 * and the new host has to be able to stop them again. These tests use a real
 * child process rather than a mock, because everything being asserted — pid
 * liveness, command-line identity, signal delivery — is the operating system's
 * behaviour and not ours.
 */

const spawned: ChildProcess[] = [];

const NODE_DIR = '/var/lib/hydra-host/node-1';
const SIBLING_DIR = '/var/lib/hydra-host/node-2';

/**
 * A stand-in for a running hydra-node: the same binary every node on the host
 * runs, told which directory it belongs to in the same way — an argument on its
 * command line. That argument is the only thing distinguishing one node's
 * process from its neighbour's.
 */
function spawnIdleProcess(nodeDir: string = NODE_DIR): ChildProcess {
	const child = spawn(
		process.execPath,
		['-e', 'setInterval(() => {}, 1000)', '--', '--persistence-dir', `${nodeDir}/persistence`],
		{ stdio: 'ignore' },
	);
	spawned.push(child);
	return child;
}

async function waitUntilGone(pid: number, budgetMs = 5_000): Promise<boolean> {
	const deadline = Date.now() + budgetMs;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return false;
}

afterEach(() => {
	for (const child of spawned.splice(0)) {
		child.kill('SIGKILL');
	}
});

describe('isProcessRunningNode', () => {
	it('recognises a process running the expected binary out of the expected directory', async () => {
		const child = spawnIdleProcess();
		expect(await isProcessRunningNode(child.pid as number, process.execPath, NODE_DIR)).toBe(true);
	});

	// The case the binary check alone cannot see. One host runs a hydra-node per
	// head, all from the same binary, so a stale pid matches a sibling's live
	// process — and the next thing done with that pid is a SIGKILL sent in the
	// wrong node's name.
	it('refuses a pid running the same binary for a different node', async () => {
		const child = spawnIdleProcess(SIBLING_DIR);
		expect(await isProcessRunningNode(child.pid as number, process.execPath, NODE_DIR)).toBe(false);
	});

	// Pids are reused. A record that outlived a reboot can name a pid belonging to
	// something else entirely.
	it('refuses a pid running something else', async () => {
		const child = spawnIdleProcess();
		expect(await isProcessRunningNode(child.pid as number, '/opt/hydra/bin/hydra-node', NODE_DIR)).toBe(false);
	});

	it('refuses a pid that is gone', async () => {
		const child = spawnIdleProcess();
		const pid = child.pid as number;
		child.kill('SIGKILL');
		await waitUntilGone(pid);
		expect(await isProcessRunningNode(pid, process.execPath, NODE_DIR)).toBe(false);
	});
});

describe('NodeProcessManager adoption', () => {
	it('adopts a live process so the node counts as running again', async () => {
		const manager = new NodeProcessManager();
		const child = spawnIdleProcess();

		expect(manager.isRunning('node-1')).toBe(false);
		expect(await manager.adopt('node-1', child.pid as number, process.execPath, NODE_DIR)).toBe(true);
		expect(manager.isRunning('node-1')).toBe(true);
	});

	it('refuses to adopt a pid that is not running the node binary', async () => {
		const manager = new NodeProcessManager();
		const child = spawnIdleProcess();

		expect(await manager.adopt('node-1', child.pid as number, '/opt/hydra/bin/hydra-node', NODE_DIR)).toBe(false);
		expect(manager.isRunning('node-1')).toBe(false);
	});

	it('refuses to adopt the process of a different node', async () => {
		const manager = new NodeProcessManager();
		const child = spawnIdleProcess(SIBLING_DIR);

		expect(await manager.adopt('node-1', child.pid as number, process.execPath, NODE_DIR)).toBe(false);
		expect(manager.isRunning('node-1')).toBe(false);
	});

	it('refuses to adopt a dead pid', async () => {
		const manager = new NodeProcessManager();
		const child = spawnIdleProcess();
		const pid = child.pid as number;
		child.kill('SIGKILL');
		await waitUntilGone(pid);

		expect(await manager.adopt('node-1', pid, process.execPath, NODE_DIR)).toBe(false);
		expect(manager.isRunning('node-1')).toBe(false);
	});

	// The whole point of the pid: a node the host did not spawn must still be
	// stoppable, or `desired: Stopped` is unreachable for the rest of its life.
	it('stops an adopted process by signalling its pid', async () => {
		const manager = new NodeProcessManager();
		const child = spawnIdleProcess();
		const pid = child.pid as number;
		await manager.adopt('node-1', pid, process.execPath, NODE_DIR);

		const result = await manager.stop('node-1', 5_000);

		expect(result.graceful).toBe(true);
		expect(await waitUntilGone(pid)).toBe(true);
		expect(manager.isRunning('node-1')).toBe(false);
	});

	it('reports a stop for a node it holds no process for', async () => {
		const manager = new NodeProcessManager();
		const result = await manager.stop('node-unknown', 1_000);
		// Nothing to stop is a stop that succeeded: the caller may free the node's
		// files and its peer port on the strength of it.
		expect(result).toEqual({ graceful: true, stopped: true, exitCode: null, signal: null });
	});
});

describe('NodeProcessManager stop safety', () => {
	// An adopted node has no exit event, so nothing reports its death and the
	// entry outlives it. Once the pid is reused — on this host, most likely by a
	// sibling hydra-node — signalling it would SIGKILL the neighbour mid-round.
	it('refuses to signal an adopted pid that now belongs to something else', async () => {
		const manager = new NodeProcessManager();
		const child = spawnIdleProcess();
		const pid = child.pid as number;
		await manager.adopt('node-1', pid, process.execPath, NODE_DIR);

		// The same live pid, now failing the identity check: exactly what pid reuse
		// looks like from here.
		const entry = manager.get('node-1');
		if (entry !== undefined) entry.identity = { binary: process.execPath, nodeDir: SIBLING_DIR };

		const result = await manager.stop('node-1', 1_000);

		expect(result.stopped).toBe(true);
		expect(manager.isRunning('node-1')).toBe(false);
		// The process it refused to signal is untouched, which is the whole point.
		expect(isProcessAlive(pid)).toBe(true);
		expect(child.killed).toBe(false);
	});
});
