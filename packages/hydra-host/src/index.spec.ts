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
let ready: Promise<void>;

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
	ready = new Promise<void>((resolve) => {
		listening = resolve;
	});
	jest.spyOn(Server.prototype, 'listen').mockImplementation(function (this: Server) {
		servers.push(this);
		if (servers.length === 2) listening();
		return this;
	});
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

async function startListening(): Promise<void> {
	await import('./index.js');
	await Promise.race([
		ready,
		exitReached.then(() => {
			throw new Error(`Host startup failed: ${jest.mocked(console.error).mock.calls.flat().join(' ')}`);
		}),
	]);
}

async function loseLease(): Promise<void> {
	const ownerPath = path.join(dataDir, 'host.lock', 'owner.json');
	const owner = JSON.parse(await fs.readFile(ownerPath, 'utf8')) as { ownerToken: string };
	await fs.writeFile(ownerPath, JSON.stringify({ ...owner, ownerToken: 'replacement-owner' }));
	const lost = new Promise<void>((resolve) => {
		jest.mocked(console.error).mockImplementation((message) => {
			if (String(message).includes('data-volume lease lost')) resolve();
		});
	});
	const { HEARTBEAT_INTERVAL_MS } = await import('./registry/host-lock.js');
	const heartbeat = intervals.mock.calls.find(([, delay]) => delay === HEARTBEAT_INTERVAL_MS);
	if (!heartbeat) throw new Error('lease heartbeat was not installed');
	heartbeat[0]();
	await lost;
}

describe('Host startup failure shutdown', () => {
	it('does not adopt or launch a stored node without the required egress firewall receipt', async () => {
		process.env.HYDRA_HOST_REQUIRE_PEER_EGRESS_FIREWALL = 'true';
		const { Supervisor } = await import('./supervisor/supervisor.js');
		const boot = jest.spyOn(Supervisor.prototype, 'boot');
		await import('./index.js');
		await exitReached;
		expect(boot).not.toHaveBeenCalled();
		expect(servers).toHaveLength(0);
		expect(jest.mocked(console.error).mock.calls.flat().join(' ')).toContain('peer egress firewall attestation');
	});

	it('starts shutdown drains while the initial reconciliation tick is still pending', async () => {
		const { NodeRegistryStore } = await import('./registry/store.js');
		const list = NodeRegistryStore.prototype.list;
		let resumeTick: () => void = () => undefined;
		const heldTick = new Promise<void>((resolve) => {
			resumeTick = resolve;
		});
		let reportSignal: () => void = () => undefined;
		const signaled = new Promise<void>((resolve) => {
			reportSignal = resolve;
		});
		let lists = 0;
		jest.spyOn(NodeRegistryStore.prototype, 'list').mockImplementation(async function (
			this: InstanceType<typeof NodeRegistryStore>,
		) {
			const records = await list.call(this);
			lists += 1;
			// Outer startup, process adoption, then the initial reconciliation tick.
			if (lists === 3) {
				process.emit('SIGTERM');
				reportSignal();
				await heldTick;
			}
			return records;
		});
		await import('./index.js');
		await signaled;
		try {
			expect(shutdown).toHaveBeenCalledTimes(1);
			await drainStarted;
			expect(servers).toHaveLength(0);
			expect(release).not.toHaveBeenCalled();
		} finally {
			resumeTick();
			await drainStarted;
			releaseDrain();
			await exitReached;
		}
		expect(events).toEqual(['drain', 'child-exit', 'release', 'exit:0']);
	});

	it('starts bounded SIGTERM cleanup during boot without recovery or listeners', async () => {
		const { ExchangeStore } = await import('./registry/exchange-store.js');
		const recovery = jest.spyOn(ExchangeStore.prototype, 'listInvites');
		let resumeBoot: () => void = () => undefined;
		const heldBoot = new Promise<void>((resolve) => {
			resumeBoot = resolve;
		});
		let reportSignal: () => void = () => undefined;
		const signaled = new Promise<void>((resolve) => {
			reportSignal = resolve;
		});
		jest.mocked(globalThis.fetch).mockImplementationOnce(async () => {
			process.emit('SIGTERM');
			reportSignal();
			await heldBoot;
			throw new Error('node API is still starting');
		});
		await import('./index.js');
		await signaled;
		try {
			// The grace clock must already run while the boot probe is pending.
			const guardIndex = timeouts.mock.calls.findIndex(([, delay]) => delay === GRACE_MS);
			expect(guardIndex).toBeGreaterThanOrEqual(0);
			const guard = timeouts.mock.results[guardIndex];
			expect(guard.type).toBe('return');
			if (guard.type === 'return') expect(guard.value.hasRef()).toBe(true);
			expect(release).not.toHaveBeenCalled();
			expect(exit).not.toHaveBeenCalled();
		} finally {
			resumeBoot();
			// Let old startup finish too, so a red assertion cannot leak work.
			await Promise.race([ready, drainStarted]);
		}
		expect(recovery).not.toHaveBeenCalled();
		expect(servers).toHaveLength(0);
		expect(shutdown).toHaveBeenCalledTimes(1);
		await drainStarted;
		expect(child.signalCode).toBeNull();
		expect(release).not.toHaveBeenCalled();
		releaseDrain();
		await exitReached;
		expect(events).toEqual(['drain', 'child-exit', 'release', 'exit:0']);
		expect(release).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledTimes(1);
		expect(await store.read('node-1')).toMatchObject({ state: 'Stopped', lastStopUndrained: false });
	});

	it.each(['lease acquisition', 'registry read'])(
		'defers SIGTERM only until %s permits safe cleanup',
		async (phase) => {
			const { Supervisor } = await import('./supervisor/supervisor.js');
			const { HostLock } = await import('./registry/host-lock.js');
			const { NodeRegistryStore } = await import('./registry/store.js');
			const { ExchangeStore } = await import('./registry/exchange-store.js');
			const boot = jest.spyOn(Supervisor.prototype, 'boot');
			const recovery = jest.spyOn(ExchangeStore.prototype, 'listInvites');
			if (phase === 'lease acquisition') {
				const acquire = HostLock.prototype.acquire;
				jest.spyOn(HostLock.prototype, 'acquire').mockImplementationOnce(async function (
					this: InstanceType<typeof HostLock>,
				) {
					process.emit('SIGTERM');
					await acquire.call(this);
				});
			} else {
				const list = NodeRegistryStore.prototype.list;
				jest.spyOn(NodeRegistryStore.prototype, 'list').mockImplementationOnce(async function (
					this: InstanceType<typeof NodeRegistryStore>,
				) {
					process.emit('SIGTERM');
					return await list.call(this);
				});
			}
			await import('./index.js');
			await Promise.race([ready, drainStarted]);
			expect(boot).not.toHaveBeenCalled();
			expect(recovery).not.toHaveBeenCalled();
			expect(servers).toHaveLength(0);
			expect(shutdown).toHaveBeenCalledTimes(1);
			expect(release).not.toHaveBeenCalled();
			releaseDrain();
			await exitReached;
			expect(events).toEqual(['drain', 'child-exit', 'release', 'exit:0']);
		},
	);

	it.each([false, true])('drains on lease loss during the registry read with pending SIGTERM=%s', async (signal) => {
		const { NodeRegistryStore } = await import('./registry/store.js');
		const list = NodeRegistryStore.prototype.list;
		jest.spyOn(NodeRegistryStore.prototype, 'list').mockImplementationOnce(async function (
			this: InstanceType<typeof NodeRegistryStore>,
		) {
			const records = await list.call(this);
			if (signal) process.emit('SIGTERM');
			await loseLease();
			return records;
		});
		await import('./index.js');
		await Promise.race([drainStarted, exitReached]);
		expect(shutdown).toHaveBeenCalledTimes(1);
		expect(servers).toHaveLength(0);
		expect(release).not.toHaveBeenCalled();
		releaseDrain();
		await exitReached;
		expect(events).toEqual(['drain', 'child-exit', 'release', 'exit:1']);
		expect(release).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledTimes(1);
		expect(await fs.readFile(path.join(dataDir, 'host.lock', 'owner.json'), 'utf8')).toContain('replacement-owner');
	});

	it.each(['boot failure', 'lease loss'])('keeps %s fatal when SIGTERM starts cleanup during boot', async (failure) => {
		if (failure === 'boot failure') {
			const rename = fs.rename;
			let rejected = false;
			jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
				if (!rejected && String(to).endsWith('/node.json')) {
					rejected = true;
					throw new Error('registry write failed after SIGTERM');
				}
				await rename(from, to);
			});
		}
		jest.mocked(globalThis.fetch).mockImplementationOnce(async () => {
			process.emit('SIGTERM');
			if (failure === 'lease loss') await loseLease();
			throw new Error('node API is still starting');
		});
		await import('./index.js');
		await drainStarted;
		expect(shutdown).toHaveBeenCalledTimes(1);
		expect(servers).toHaveLength(0);
		expect(release).not.toHaveBeenCalled();
		releaseDrain();
		await exitReached;
		expect(events).toEqual(['drain', 'child-exit', 'release', 'exit:1']);
		expect(release).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledTimes(1);
	});

	it.each(['partial boot', 'listener construction'])(
		'drains after %s fails before either listener starts',
		async (failure) => {
			if (failure === 'partial boot') {
				const rename = fs.rename;
				let rejected = false;
				jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
					if (!rejected && String(to).endsWith('/node.json')) {
						rejected = true;
						throw new Error('registry write failed after process adoption');
					}
					await rename(from, to);
				});
			} else {
				jest.spyOn(Server.prototype, 'on').mockImplementationOnce(() => {
					throw new Error('listener construction failed after boot');
				});
			}
			await import('./index.js');
			await Promise.race([drainStarted, exitReached]);
			expect(shutdown).toHaveBeenCalledTimes(1);
			expect(release).not.toHaveBeenCalled();
			expect(exit).not.toHaveBeenCalled();
			expect(servers).toHaveLength(0);
			const guard = timeouts.mock.results[timeouts.mock.calls.findIndex(([, delay]) => delay === GRACE_MS)];
			expect(guard.type).toBe('return');
			if (guard.type === 'return') expect(guard.value.hasRef()).toBe(true);
			releaseDrain();
			await exitReached;
			expect(events).toEqual(['drain', 'child-exit', 'release', 'exit:1']);
			expect(await store.read('node-1')).toMatchObject({ state: 'Stopped', lastStopUndrained: false });
		},
	);

	it('drains on lease loss during boot and never proceeds to listeners', async () => {
		jest.mocked(globalThis.fetch).mockImplementationOnce(async () => {
			await loseLease();
			throw new Error('node API is still starting');
		});
		await import('./index.js');
		// The old host continues boot after its mocked exit. Wait for that work
		// too, so a failing assertion cannot leave startup running after teardown.
		await Promise.race([ready, drainStarted]);
		expect(shutdown).toHaveBeenCalledTimes(1);
		expect(release).not.toHaveBeenCalled();
		expect(exit).not.toHaveBeenCalled();
		expect(servers).toHaveLength(0);
		releaseDrain();
		await exitReached;
		expect(events).toEqual(['drain', 'child-exit', 'release', 'exit:1']);
		expect(await fs.readFile(path.join(dataDir, 'host.lock', 'owner.json'), 'utf8')).toContain('replacement-owner');
	});

	it('bounds the wait for in-flight boot before starting one drain', async () => {
		let resumeBoot: () => void = () => undefined;
		const heldBoot = new Promise<void>((resolve) => {
			resumeBoot = resolve;
		});
		let reportLoss: () => void = () => undefined;
		const reported = new Promise<void>((resolve) => {
			reportLoss = resolve;
		});
		jest.mocked(globalThis.fetch).mockImplementationOnce(async () => {
			await loseLease();
			reportLoss();
			await heldBoot;
			throw new Error('node API is still starting');
		});
		await import('./index.js');
		await reported;
		try {
			expect(shutdown).not.toHaveBeenCalled();
			expect(release).not.toHaveBeenCalled();
			expect(exit).not.toHaveBeenCalled();
			const guard = timeouts.mock.results[timeouts.mock.calls.findIndex(([, delay]) => delay === GRACE_MS)];
			expect(guard.type).toBe('return');
			if (guard.type === 'return') expect(guard.value.hasRef()).toBe(true);
			// A second shutdown request while boot is settling must not add a drain.
			process.emit('SIGTERM');
		} finally {
			resumeBoot();
			await Promise.race([ready, drainStarted]);
		}
		expect(shutdown).toHaveBeenCalledTimes(1);
		expect(servers).toHaveLength(0);
		releaseDrain();
		await exitReached;
		expect(events).toEqual(['drain', 'child-exit', 'release', 'exit:1']);
		expect(release).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledTimes(1);
	});
});

describe('Host listener failure shutdown', () => {
	beforeEach(startListening);

	it('treats active lease loss as a failure after draining', async () => {
		await loseLease();
		await drainStarted;
		expect(release).not.toHaveBeenCalled();
		releaseDrain();
		await exitReached;
		expect(events).toEqual(['drain', 'child-exit', 'release', 'exit:1']);
	});
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

describe('Host peer firewall control socket', () => {
	it('refuses a shared socket directory before any stored node boots', async () => {
		const shared = path.join(dataDir, 'shared');
		await fs.mkdir(shared, { mode: 0o755 });
		await fs.chmod(shared, 0o755);
		process.env.HYDRA_HOST_CONTROL_SOCKET = path.join(shared, 'control.sock');
		const { Supervisor } = await import('./supervisor/supervisor.js');
		const boot = jest.spyOn(Supervisor.prototype, 'boot');
		await import('./index.js');
		await exitReached;
		expect(boot).not.toHaveBeenCalled();
		expect(servers).toHaveLength(0);
		expect(jest.mocked(console.error).mock.calls.flat().join(' ')).toContain('control socket directory');
	});

	it('drains the Host when the private listener cannot start', async () => {
		process.env.HYDRA_HOST_CONTROL_SOCKET = path.join(dataDir, 'control.sock');
		await startListening();
		expect(servers).toHaveLength(3);
		listenerError(2);
		await drainStarted;
		releaseDrain();
		await exitReached;
		expect(events).toEqual(['drain', 'child-exit', 'release', 'exit:1']);
	});
});
