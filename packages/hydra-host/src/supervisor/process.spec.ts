import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
	jest.restoreAllMocks();
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

describe('NodeProcessManager child environment', () => {
	// The Host holds both bearer tokens in its own environment. A node that
	// inherits them can leak them through anything that logs its environment.
	it('starts a node without the Host tokens but with PATH and etcd overrides', async () => {
		const nodeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hydra-host-env-'));
		const injected = {
			HYDRA_HOST_ADMIN_TOKEN: 'admin-token-that-must-not-leak',
			HYDRA_HOST_USER_TOKEN: 'user-token-that-must-not-leak',
			ETCD_INITIAL_CLUSTER_STATE: 'existing',
			ETCD_VERSION: '3.5.34',
		};
		const previous = Object.fromEntries(Object.keys(injected).map((key) => [key, process.env[key]]));
		Object.assign(process.env, injected);
		try {
			const manager = new NodeProcessManager();
			let onExit: () => void = () => undefined;
			const exited = new Promise<void>((resolve) => {
				onExit = resolve;
			});
			await manager.start(
				{
					nodeId: 'node-1',
					binary: process.execPath,
					args: ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
					nodeDir,
				},
				() => onExit(),
			);
			await exited;

			const childEnv = JSON.parse(await fs.readFile(path.join(nodeDir, 'logs', 'node.log'), 'utf8')) as Record<
				string,
				string
			>;
			expect(childEnv.HYDRA_HOST_ADMIN_TOKEN).toBeUndefined();
			expect(childEnv.HYDRA_HOST_USER_TOKEN).toBeUndefined();
			expect(childEnv.ETCD_VERSION).toBeUndefined();
			expect(childEnv.ETCD_INITIAL_CLUSTER_STATE).toBe('existing');
			expect(childEnv.PATH).toBe(process.env.PATH);
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			await fs.rm(nodeDir, { recursive: true, force: true });
		}
	});
});

describe('failed process stops retain ownership', () => {
	const PID = 987654;
	async function adopted() {
		const manager = new NodeProcessManager();
		const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
		const read = fs.readFile.bind(fs);
		const command = jest.spyOn(fs, 'readFile').mockImplementation(((
			file: Parameters<typeof fs.readFile>[0],
			options: Parameters<typeof fs.readFile>[1],
		) => {
			if (file === `/proc/${PID}/cmdline`)
				return Promise.resolve(`${process.execPath} --persistence-dir ${NODE_DIR}/persistence`);
			return read(file, options);
		}) as typeof fs.readFile);
		expect(await manager.adopt('node-1', PID, process.execPath, NODE_DIR)).toBe(true);
		return { manager, kill, command };
	}

	it.each(['SIGTERM', 'SIGKILL'] as const)('retains the adopted entry when %s fails with EPERM', async (denied) => {
		const { manager, kill } = await adopted();
		kill.mockImplementation((_pid, signal) => {
			if (signal === denied) throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
			return true;
		});
		expect(await manager.stop('node-1', 0)).toMatchObject({
			stopped: false,
			failureReason: expect.stringContaining('EPERM'),
		});
		expect(manager.get('node-1')?.pid).toBe(PID);
		expect(manager.isRunning('node-1')).toBe(true);
	});

	it('only drops the adopted entry when a failed signal proves ESRCH', async () => {
		const { manager, kill } = await adopted();
		kill.mockImplementation((_pid, signal) => {
			if (signal === 'SIGTERM') throw Object.assign(new Error('gone'), { code: 'ESRCH' });
			return true;
		});
		expect((await manager.stop('node-1', 0)).stopped).toBe(true);
		expect(manager.get('node-1')).toBeUndefined();
	});

	it('retains an adopted entry when identity cannot be read, without signalling an unknown process', async () => {
		const { manager, kill, command } = await adopted();
		command.mockResolvedValue('');
		expect(await manager.revalidateAdopted()).toEqual([]);
		expect(manager.get('node-1')?.pid).toBe(PID);
		expect((await manager.stop('node-1', 0)).stopped).toBe(false);
		expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
	});

	it('does not report unknown liveness errors as process absence', () => {
		jest.spyOn(process, 'kill').mockImplementation(() => {
			throw Object.assign(new Error('I/O failure'), { code: 'EIO' });
		});
		expect(isProcessAlive(PID)).toBe(true);
	});

	it('keeps a live owned child after a failed signal emits an error', async () => {
		const nodeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hydra-stop-error-'));
		const manager = new NodeProcessManager();
		const onExit = jest.fn();
		const entry = await manager.start(
			{ nodeId: 'node-1', binary: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], nodeDir },
			onExit,
		);
		const child = entry.child!;
		spawned.push(child);
		const kill = jest.spyOn(child, 'kill').mockImplementation(() => {
			child.emit('error', Object.assign(new Error('permission denied'), { code: 'EPERM' }));
			return false;
		});
		try {
			expect((await manager.stop('node-1', 0)).stopped).toBe(false);
			expect(manager.isRunning('node-1')).toBe(true);
			expect(onExit).not.toHaveBeenCalled();
		} finally {
			kill.mockRestore();
			child.kill('SIGKILL');
			await fs.rm(nodeDir, { recursive: true, force: true });
		}
	});

	it('does not treat a successfully delivered signal as proof that the child exited', async () => {
		const nodeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hydra-signal-pending-'));
		const manager = new NodeProcessManager();
		const entry = await manager.start(
			{ nodeId: 'node-1', binary: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], nodeDir },
			() => undefined,
		);
		spawned.push(entry.child!);
		try {
			Object.defineProperty(entry.child!, 'killed', { value: true, configurable: true });
			expect(manager.isRunning('node-1')).toBe(true);
		} finally {
			entry.child!.kill('SIGKILL');
			await fs.rm(nodeDir, { recursive: true, force: true });
		}
	});
});

it('removes per-stop listeners after repeated denied child signals', async () => {
	const nodeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hydra-stop-retry-'));
	const manager = new NodeProcessManager();
	const entry = await manager.start(
		{ nodeId: 'node-1', binary: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], nodeDir },
		() => undefined,
	);
	const child = entry.child!;
	spawned.push(child);
	const exitListeners = child.listenerCount('exit');
	const errorListeners = child.listenerCount('error');
	const kill = jest.spyOn(child, 'kill').mockImplementation(() => {
		child.emit('error', Object.assign(new Error('permission denied'), { code: 'EPERM' }));
		return false;
	});
	try {
		for (let attempt = 0; attempt < 12; attempt += 1)
			expect((await manager.stop('node-1', 30_000)).stopped).toBe(false);
		expect(child.listenerCount('exit')).toBe(exitListeners);
		expect(child.listenerCount('error')).toBe(errorListeners);
		expect(manager.isRunning('node-1')).toBe(true);
	} finally {
		kill.mockRestore();
		child.kill('SIGKILL');
		await fs.rm(nodeDir, { recursive: true, force: true });
	}
});
