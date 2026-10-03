/**
 * Process and HTTP helpers for the end-to-end run.
 *
 * Every spawned process writes to its own log under the run directory rather
 * than being interleaved into this script's stdout: when a node fails to reach
 * `Running` the answer is almost always in hydra-node's own output, and the
 * Host relays it verbatim.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { LOG_DIR, REPO_ROOT, RUN_DIR } from './env.mjs';

/**
 * Run TypeScript entrypoints as a *single* process.
 *
 * The `tsx` bin is a shim that spawns node as a child, so killing it leaves the
 * real process running — which strands the Host still holding its control-plane
 * port and makes the next run fail with EADDRINUSE. Loading tsx into node
 * directly keeps one process, so a kill is a kill.
 */
const NODE_ARGS = ['--import', 'tsx'];

export type Managed = { name: string; child: ChildProcess; logFile: string };

const managed: Managed[] = [];

/** Run a plain JavaScript entrypoint — the built server, rather than sources. */
export function spawnNode(name: string, entry: string, env: NodeJS.ProcessEnv): Managed {
	const logFile = path.join(LOG_DIR, `${name}.log`);
	const out = fs.openSync(logFile, 'w');
	const child = spawn(process.execPath, [entry], { cwd: REPO_ROOT, env, stdio: ['ignore', out, out] });
	const record = { name, child, logFile };
	managed.push(record);
	return record;
}

export function spawnTsx(name: string, entry: string, env: NodeJS.ProcessEnv): Managed {
	const logFile = path.join(LOG_DIR, `${name}.log`);
	const out = fs.openSync(logFile, 'w');
	const child = spawn(process.execPath, [...NODE_ARGS, entry], {
		cwd: REPO_ROOT,
		env,
		stdio: ['ignore', out, out],
	});
	const record = { name, child, logFile };
	managed.push(record);
	return record;
}

/**
 * Run a script to completion and capture its output.
 *
 * Used for the one-shot helpers (the fixture, the offer driver) whose printed
 * result is the assertion material, unlike the long-lived processes above.
 */
export function runTsx(
	name: string,
	entry: string,
	env: NodeJS.ProcessEnv,
	/** Arguments for the entry itself, e.g. a Prisma subcommand. */
	args: readonly string[] = [],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [...NODE_ARGS, entry, ...args], {
			cwd: REPO_ROOT,
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
		child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
		child.on('close', (code) => {
			fs.writeFileSync(path.join(LOG_DIR, `${name}.log`), `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
			resolve({ code, stdout, stderr });
		});
	});
}

function exited(record: Managed): Promise<void> {
	if (record.child.exitCode !== null || record.child.signalCode !== null) {
		return Promise.resolve();
	}
	return new Promise((resolve) => record.child.once('exit', () => resolve()));
}

/**
 * Terminate everything this run started, gracefully first.
 *
 * Waits for the processes to actually exit rather than assuming they have: a
 * Host still holding its control-plane port makes the *next* run fail at boot
 * with EADDRINUSE, which looks nothing like the real cause.
 */
export async function stopAll(): Promise<void> {
	for (const record of managed) {
		record.child.kill('SIGTERM');
	}
	// The Host drains each node on SIGTERM, so give it room before escalating.
	await Promise.race([Promise.all(managed.map(exited)), sleep(15_000)]);

	for (const record of managed) {
		if (record.child.exitCode === null && record.child.signalCode === null) {
			record.child.kill('SIGKILL');
		}
	}
	await Promise.race([Promise.all(managed.map(exited)), sleep(5_000)]);
}

export function forget(record: Managed): void {
	const index = managed.indexOf(record);
	if (index >= 0) {
		managed.splice(index, 1);
	}
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function tail(logFile: string, lines = 25): string {
	if (!fs.existsSync(logFile)) {
		return '(no log)';
	}
	return fs.readFileSync(logFile, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
}

export type HttpResult = { status: number; body: unknown; text: string };

export async function http(
	url: string,
	options: { method?: string; token?: string; apiKey?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<HttpResult> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (options.token !== undefined) {
		headers.Authorization = `Bearer ${options.token}`;
	}
	// The payment service authenticates on its own `token` header, not Bearer.
	if (options.apiKey !== undefined) {
		headers.token = options.apiKey;
	}
	if (options.idempotencyKey !== undefined) {
		headers['Idempotency-Key'] = options.idempotencyKey;
	}

	const response = await fetch(url, {
		method: options.method ?? 'GET',
		headers,
		...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
	});
	const text = await response.text();
	let body: unknown = null;
	try {
		body = text.length === 0 ? null : JSON.parse(text);
	} catch {
		body = null;
	}
	return { status: response.status, body, text };
}

/**
 * Poll until `predicate` holds.
 *
 * Returns the last observed value on success and throws with it on timeout, so
 * a failing wait reports what it actually saw rather than just "timed out".
 */
export async function waitFor<T>(
	label: string,
	probe: () => Promise<T>,
	predicate: (value: T) => boolean,
	options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
	const timeoutMs = options.timeoutMs ?? 90_000;
	const intervalMs = options.intervalMs ?? 1_000;
	const deadline = Date.now() + timeoutMs;
	let last: T | undefined;

	while (Date.now() < deadline) {
		try {
			last = await probe();
			if (predicate(last)) {
				return last;
			}
		} catch {
			// Transient during startup; the deadline is the real guard.
		}
		await sleep(intervalMs);
	}
	throw new Error(`timed out waiting for ${label}; last observed: ${JSON.stringify(last)}`);
}

/** Whether a pid is alive, used to prove a stop really killed the node process. */
export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function processTable(): Promise<Array<{ pid: number; command: string }>> {
	const { execFile } = await import('node:child_process');
	const { promisify } = await import('node:util');
	const run = promisify(execFile);
	try {
		const { stdout } = await run('/bin/ps', ['-Ao', 'pid=,command='], { maxBuffer: 8 * 1024 * 1024 });
		return stdout
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line) => {
				const space = line.indexOf(' ');
				return { pid: Number(line.slice(0, space)), command: line.slice(space + 1) };
			});
	} catch {
		return [];
	}
}

/** Count live hydra-node processes belonging to this run. */
export async function countHydraNodes(): Promise<number> {
	const table = await processTable();
	return table.filter((entry) => entry.command.includes('--node-id') && entry.command.includes(RUN_DIR)).length;
}

/**
 * Kill hydra-nodes left behind by an earlier run.
 *
 * Matched on this run's data directory, so a hydra-node the developer is
 * running for something else is never touched. A stray holds the peer port and
 * would make the next run's cluster fail in a way that looks like a code
 * defect.
 */
export async function killStrayNodes(): Promise<number> {
	const table = await processTable();
	const strays = table.filter((entry) => entry.command.includes('--node-id') && entry.command.includes(RUN_DIR));
	for (const stray of strays) {
		try {
			process.kill(stray.pid, 'SIGKILL');
		} catch {
			// Already gone.
		}
	}
	if (strays.length > 0) {
		await sleep(2_000);
	}
	return strays.length;
}
