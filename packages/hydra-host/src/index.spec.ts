import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import * as childProcesses from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { NodeRecord } from './registry/types.js';

// Keep the real entrypoint, supervisor, registry, lease, process adoption and
// stop logic. Only listener binding, node HTTP responses, exit and the clock
// boundary are controlled. The managed process is a local sleeping Node child.
// Rejected-drain cases inject a supervisor failure to exercise host cleanup.
const GRACE_MS = 240_000;
const signals = ['SIGTERM', 'SIGINT'] as const;
let dataDir: string;
let child: ChildProcess;
let childExited: Promise<void>;
let releaseDrain: () => void;
let drainStarted: Promise<void>;
let exitReached: Promise<void>;
let servers: Server[];
let events: string[];
let oldSignals: Map<string, Set<(...args: any[]) => void>>;
let shutdown: jest.SpiedFunction<typeof import('./supervisor/supervisor.js').Supervisor.prototype.shutdown>;
let release: jest.SpiedFunction<typeof import('./registry/host-lock.js').HostLock.prototype.release>;
let exit: jest.SpiedFunction<typeof process.exit>;
let timeouts: jest.SpiedFunction<typeof setTimeout>;
let intervals: jest.SpiedFunction<typeof setInterval>;
let store: InstanceType<typeof import('./registry/store.js').NodeRegistryStore>;

beforeEach(async () => {
	jest.resetModules();
	dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hydra-host-entry-'));
	servers = [];
	events = [];
	oldSignals = new Map(signals.map((signal) => [signal, new Set(process.listeners(signal))]));
	jest.spyOn(console, 'log').mockImplementation(() => undefined);
	jest.spyOn(console, 'warn').mockImplementation(() => undefined);
	jest.spyOn(console, 'error').mockImplementation(() => undefined);
	timeouts = jest.spyOn(globalThis, 'setTimeout');
	intervals = jest.spyOn(globalThis, 'setInterval');
	let didExit: () => void;
	exitReached = new Promise<void>((resolve) => {
		didExit = resolve;
	});
	exit = jest.spyOn(process, 'exit').mockImplementation((code) => {
		events.push(`exit:${code}`);
		didExit();
		return undefined as never;
	});
	const drainGate = new Promise<void>((resolve) => {
		releaseDrain = resolve;
	});
	let beganDrain: () => void;
	drainStarted = new Promise<void>((resolve) => {
		beganDrain = resolve;
	});
	jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
		if (!String(input).endsWith('/snapshot/last-seen')) throw new Error('node API is still starting');
		events.push('drain');
		beganDrain();
		await drainGate;
		return new Response(JSON.stringify({ tag: 'LastSeenSnapshot' }));
	});
	jest.replaceProperty(process, 'env', {
		...process.env,
		HYDRA_HOST_DATA_DIR: dataDir,
		HYDRA_NODE_BIN: process.execPath,
		HYDRA_HOST_USE_SYSTEM_ETCD: 'false',
		HYDRA_HOST_PUBLIC_HOST: 'host.example.com',
		HYDRA_HOST_PUBLIC_EXCHANGE_URL: 'https://exchange.example.com/exchange',
		HYDRA_HOST_ADMIN_TOKEN: 'a'.repeat(40),
		HYDRA_HOST_USER_TOKEN: 'u'.repeat(40),
		HYDRA_HOST_LEDGER_PARAMS_FILE: path.resolve('packages/hydra-host/params/preprod.json'),
	});
	const { NodeRegistryStore } = await import('./registry/store.js');
	// macOS process-table reads are denied in the sandbox. Expose only this
	// fixture's child to the real manager's identity checks, never another pid.
	jest.unstable_mockModule('node:child_process', () => ({
		...childProcesses,
		execFile: (
			file: string,
			args: string[],
			_options: object,
			callback: (error: Error | null, stdout: string) => void,
		) => {
			if (file !== 'ps') throw new Error(`unexpected executable: ${file}`);
			const command = `${process.execPath} --persistence-dir ${store.nodeDir('node-1')}/persistence`;
			callback(null, args[0] === '-p' ? (args[1] === String(child.pid) ? command : '') : `${child.pid} ${command}`);
			return child;
		},
	}));
	const { Supervisor } = await import('./supervisor/supervisor.js');
	const { HostLock } = await import('./registry/host-lock.js');
	store = new NodeRegistryStore(dataDir);
	const nodeDir = store.nodeDir('node-1');
	child = spawn(
		process.execPath,
		['-e', 'setInterval(() => {}, 1000)', '--', '--persistence-dir', path.join(nodeDir, 'persistence')],
		{
			stdio: 'ignore',
		},
	);
	childExited = new Promise<void>((resolve) => {
		child.once('exit', () => {
			events.push('child-exit');
			resolve();
		});
	});
	const now = new Date().toISOString();
	await store.write({
		nodeId: 'node-1',
		state: 'Running',
		desired: 'Running',
		network: 'preprod',
		apiPort: 4599,
		peerPort: 5001,
		monitoringPort: 6599,
		advertise: 'host.example.com:5001',
		peers: [],
		contestationPeriodSeconds: 120,
		depositPeriodSeconds: 600,
		depositActivationSeconds: 600,
		unsyncedPeriodSeconds: 300,
		hydraVerificationKey: `5820${'ab'.repeat(32)}`,
		cardanoVerificationKey: `5820${'cd'.repeat(32)}`,
		escrowAckedAt: now,
		idempotencyKey: 'idem-1',
		createdAt: now,
		updatedAt: now,
		startAttempts: 0,
		lastStopUndrained: false,
		pid: child.pid,
	} satisfies NodeRecord);
	shutdown = jest.spyOn(Supervisor.prototype, 'shutdown');
	const releaseLease = HostLock.prototype.release;
	release = jest.spyOn(HostLock.prototype, 'release').mockImplementation(function (
		this: InstanceType<typeof HostLock>,
	) {
		events.push('release');
		return releaseLease.call(this);
	});
	let listening: () => void;
	const ready = new Promise<void>((resolve) => {
		listening = resolve;
	});
	jest.spyOn(Server.prototype, 'listen').mockImplementation(function (this: Server) {
		servers.push(this);
		if (servers.length === 2) listening();
		return this;
	});
	await import('./index.js');
	await Promise.race([
		ready,
		exitReached.then(() => {
			throw new Error(`Host startup failed: ${jest.mocked(console.error).mock.calls.flat().join(' ')}`);
		}),
	]);
});

afterEach(async () => {
	releaseDrain?.();
	await Promise.allSettled(shutdown?.mock.results.map(({ value }) => value) ?? []);
	await Promise.allSettled(release?.mock.results.map(({ value }) => value) ?? []);
	await new Promise((resolve) => setImmediate(resolve));
	child?.kill('SIGKILL');
	if (childExited) await childExited;
	for (const result of timeouts?.mock.results ?? []) {
		if (result.type === 'return') clearTimeout(result.value);
	}
	for (const result of intervals?.mock.results ?? []) {
		if (result.type === 'return') clearInterval(result.value);
	}
	for (const signal of signals) {
		for (const listener of process.listeners(signal)) {
			if (!oldSignals.get(signal)?.has(listener)) process.off(signal, listener);
		}
	}
	jest.restoreAllMocks();
	await fs.rm(dataDir, { recursive: true, force: true });
});

function listenerError(index: number): void {
	servers[index].emit('error', Object.assign(new Error('address in use'), { code: 'EADDRINUSE' }));
}

describe('Host listener failure shutdown', () => {
	it('logs a failed lease release after a rejected drain and still exits nonzero', async () => {
		shutdown.mockRejectedValueOnce(new Error('drain failed'));
		jest.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('release storage failure'));
		listenerError(0);
		listenerError(1);
		await exitReached;

		expect(shutdown).toHaveBeenCalledTimes(1);
		expect(events).toEqual(['release', 'exit:1']);
		expect(release).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledTimes(1);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining('lease release failed after shutdown error'));
		expect(
			(await fs.readdir(path.join(dataDir, 'host.lock'))).filter((name) => name.startsWith('released.')),
		).toHaveLength(0);
	});

	it.each([
		[0, new Error('drain failed')],
		[1, new Error('drain failed')],
		[0, null],
	])('releases the lease before exit when listener %s fails and shutdown rejects with %p', async (first, error) => {
		// Fault injection at the supervisor boundary: the host must still hand
		// back its lease when draining cannot complete.
		shutdown.mockRejectedValueOnce(error);
		listenerError(first);
		listenerError(1 - first);
		await exitReached;

		expect(shutdown).toHaveBeenCalledTimes(1);
		expect(events).toEqual(['release', 'exit:1']);
		expect(release).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledTimes(1);
		expect(child.signalCode).toBeNull();
		expect(
			(await fs.readdir(path.join(dataDir, 'host.lock'))).filter((name) => name.startsWith('released.')),
		).toHaveLength(1);
	});

	it.each([0, 1])('drains after listener %s fails, even if both fail, before releasing the lease', async (first) => {
		const closes = servers.map((server) => jest.spyOn(server, 'close'));
		listenerError(first);
		listenerError(1 - first);
		expect(shutdown).toHaveBeenCalledTimes(1);
		await drainStarted;
		expect(release).not.toHaveBeenCalled();
		expect(exit).not.toHaveBeenCalled();
		expect(existsSync(path.join(dataDir, 'host.lock'))).toBe(true);
		expect(child.signalCode).toBeNull();
		// These real HTTP servers never bound. Their actual close() must be safe.
		for (const [index, close] of closes.entries()) {
			expect(servers[index].listening).toBe(false);
			expect(close).toHaveBeenCalledTimes(1);
		}
		releaseDrain();
		await exitReached;
		expect(events).toEqual(['drain', 'child-exit', 'release', 'exit:1']);
		expect(release).toHaveBeenCalledTimes(1);
		expect(await store.read('node-1')).toMatchObject({ state: 'Stopped', lastStopUndrained: false });
		expect(
			(await fs.readdir(path.join(dataDir, 'host.lock'))).filter((name) => name.startsWith('released.')),
		).toHaveLength(1);
	});

	it('keeps a referenced grace timer and exits nonzero if the drain cannot finish', async () => {
		listenerError(0);
		expect(shutdown).toHaveBeenCalledTimes(1);
		await drainStarted;
		const guardIndex = timeouts.mock.calls.findIndex(([, milliseconds]) => milliseconds === GRACE_MS);
		expect(guardIndex).toBeGreaterThanOrEqual(0);
		const guard = timeouts.mock.results[guardIndex];
		expect(guard.type).toBe('return');
		if (guard.type === 'return') expect(guard.value.hasRef()).toBe(true);
		timeouts.mock.calls[guardIndex][0]();
		await exitReached;
		expect(events).toEqual(['drain', 'release', 'exit:1']);
		expect(child.signalCode).toBeNull();
	});

	it.each(signals)('keeps clean %s shutdown at exit status zero', async (signal) => {
		process.emit(signal);
		expect(shutdown).toHaveBeenCalledTimes(1);
		await drainStarted;
		releaseDrain();
		await exitReached;
		expect(events).toEqual(['drain', 'child-exit', 'release', 'exit:0']);
	});

	it('keeps listener failure nonzero when a signal started the drain first', async () => {
		process.emit('SIGTERM');
		listenerError(1);
		expect(shutdown).toHaveBeenCalledTimes(1);
		await drainStarted;
		expect(release).not.toHaveBeenCalled();
		releaseDrain();
		await exitReached;
		expect(events).toEqual(['drain', 'child-exit', 'release', 'exit:1']);
	});
});
