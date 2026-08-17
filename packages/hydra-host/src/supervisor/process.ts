/**
 * Child-process lifecycle for one hydra-node.
 *
 * Stopping is always SIGTERM first with a bounded wait. SIGKILL exists only as
 * a last resort and is reported back to the caller, because a hard kill is the
 * documented way to strand a head and the supervisor records it so the next
 * start checks for a stranded round.
 *
 * A node outlives the host that supervises it, so this manager holds two kinds
 * of entry. One is a child of this process, with a handle and an exit event.
 * The other is a node that was already running when the host booted — same
 * hydra-node, no handle, reachable only by pid. Without the second kind, a host
 * restart left every node it had started unstoppable and unrestartable while
 * still looking, to the rest of the supervisor, like nothing was running at all.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export type SpawnRequest = {
	nodeId: string;
	binary: string;
	args: string[];
	nodeDir: string;
};

export type StopResult = {
	/** True when the process exited on SIGTERM; false when it had to be killed. */
	graceful: boolean;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
};

export type RunningNode = {
	nodeId: string;
	pid: number | undefined;
	/** Absent for an adopted node: it is not a child of this process. */
	child?: ChildProcess;
	startedAtMs: number;
};

/** How often an adopted process is polled while waiting for it to exit. */
const ADOPTED_POLL_INTERVAL_MS = 250;
/** How long to wait for an adopted process to die after SIGKILL before giving up on it. */
const ADOPTED_SIGKILL_WAIT_MS = 5_000;

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});

/**
 * Whether a pid names a live process.
 *
 * `EPERM` counts as alive: the process exists, it just belongs to someone else.
 * Only `ESRCH` — no such process — means gone.
 */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/**
 * Whether the process at `pid` is running the binary we expect.
 *
 * Pids are reused, and this manager's whole purpose is to send signals to one.
 * A record that survived a machine reboot can name a pid that now belongs to
 * something else entirely, so the command line is checked before that pid is
 * ever treated as a hydra-node. Anything unverifiable answers false: refusing
 * to adopt costs a supervisor that cannot stop one node, while adopting wrongly
 * costs an unrelated process a SIGKILL.
 */
export async function isProcessRunningBinary(pid: number, binary: string): Promise<boolean> {
	const needle = path.basename(binary);
	if (needle.length === 0) {
		return false;
	}
	const command = await new Promise<string | null>((resolve) => {
		execFile('ps', ['-p', String(pid), '-o', 'command='], { timeout: 5_000 }, (error, stdout) => {
			resolve(error === null ? stdout : null);
		});
	});
	return command !== null && command.includes(needle);
}

export class NodeProcessManager {
	private readonly running = new Map<string, RunningNode>();

	isRunning(nodeId: string): boolean {
		const entry = this.running.get(nodeId);
		if (entry === undefined) {
			return false;
		}
		if (entry.child === undefined) {
			return entry.pid !== undefined && isProcessAlive(entry.pid);
		}
		return entry.child.exitCode === null && !entry.child.killed;
	}

	get(nodeId: string): RunningNode | undefined {
		return this.running.get(nodeId);
	}

	list(): RunningNode[] {
		return [...this.running.values()];
	}

	/**
	 * Take responsibility for a hydra-node this host did not spawn.
	 *
	 * Returns false when the pid is dead or is not running `binary`, in which
	 * case nothing is registered and the caller is no worse off than before.
	 */
	async adopt(nodeId: string, pid: number, binary: string): Promise<boolean> {
		if (this.isRunning(nodeId)) {
			return false;
		}
		if (!isProcessAlive(pid) || !(await isProcessRunningBinary(pid, binary))) {
			return false;
		}
		this.running.set(nodeId, { nodeId, pid, startedAtMs: Date.now() });
		return true;
	}

	async start(
		request: SpawnRequest,
		onExit: (nodeId: string, code: number | null, signal: NodeJS.Signals | null) => void,
	): Promise<RunningNode> {
		if (this.isRunning(request.nodeId)) {
			throw new Error(`node ${request.nodeId} is already running`);
		}

		const logDir = path.join(request.nodeDir, 'logs');
		await fs.mkdir(logDir, { recursive: true });
		// Logs go to a file for operator forensics only. Nothing in the supervisor
		// parses them: drift comes from the API, not from stdout.
		const handle = await fs.open(path.join(logDir, 'node.log'), 'a');

		const child = spawn(request.binary, request.args, {
			cwd: request.nodeDir,
			stdio: ['ignore', handle.fd, handle.fd],
			detached: false,
		});

		const entry: RunningNode = {
			nodeId: request.nodeId,
			pid: child.pid,
			child,
			startedAtMs: Date.now(),
		};
		this.running.set(request.nodeId, entry);

		let completed = false;
		const complete = (code: number | null, signal: NodeJS.Signals | null): void => {
			if (completed) {
				return;
			}
			completed = true;
			this.running.delete(request.nodeId);
			void handle.close().catch(() => undefined);
			onExit(request.nodeId, code, signal);
		};
		child.once('exit', complete);
		// spawn errors (notably ENOENT/EACCES) emit `error`; without a listener
		// EventEmitter throws and terminates the Host.
		child.once('error', () => complete(null, null));

		return entry;
	}

	/**
	 * SIGTERM, then wait. Only escalates to SIGKILL when the process ignores the
	 * grace period, and says so in the result.
	 */
	async stop(nodeId: string, graceMs: number): Promise<StopResult> {
		const entry = this.running.get(nodeId);
		if (entry === undefined) {
			return { graceful: true, exitCode: null, signal: null };
		}
		if (entry.child === undefined) {
			return this.stopAdopted(entry, graceMs);
		}

		const child = entry.child;
		const exited = new Promise<StopResult>((resolve) => {
			const settle = (code: number | null, signal: NodeJS.Signals | null): void =>
				resolve({ graceful: signal !== 'SIGKILL', exitCode: code, signal });
			child.once('exit', settle);
			child.once('error', () => settle(null, null));
		});

		child.kill('SIGTERM');

		const timeout = new Promise<null>((resolve) => {
			const timer = setTimeout(() => resolve(null), graceMs);
			timer.unref?.();
		});

		const settled = await Promise.race([exited, timeout]);
		if (settled !== null) {
			return settled;
		}

		child.kill('SIGKILL');
		return exited;
	}

	/**
	 * Stop a node this host adopted.
	 *
	 * There is no exit event to wait on, so death is observed by polling the pid.
	 * A pid that outlives SIGKILL is reported as a failed stop rather than waited
	 * on forever: the caller records that as an undrained stop, which is what
	 * makes the next start check for a stranded snapshot round.
	 */
	private async stopAdopted(entry: RunningNode, graceMs: number): Promise<StopResult> {
		const pid = entry.pid;
		if (pid === undefined || !isProcessAlive(pid)) {
			this.running.delete(entry.nodeId);
			return { graceful: true, exitCode: null, signal: null };
		}

		const waitForExit = async (budgetMs: number): Promise<boolean> => {
			const deadline = Date.now() + budgetMs;
			while (Date.now() < deadline) {
				if (!isProcessAlive(pid)) {
					return true;
				}
				await sleep(ADOPTED_POLL_INTERVAL_MS);
			}
			return !isProcessAlive(pid);
		};

		try {
			process.kill(pid, 'SIGTERM');
		} catch {
			// Already gone between the liveness check and the signal.
			this.running.delete(entry.nodeId);
			return { graceful: true, exitCode: null, signal: null };
		}

		if (await waitForExit(graceMs)) {
			this.running.delete(entry.nodeId);
			return { graceful: true, exitCode: null, signal: 'SIGTERM' };
		}

		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			this.running.delete(entry.nodeId);
			return { graceful: false, exitCode: null, signal: 'SIGKILL' };
		}

		const dead = await waitForExit(ADOPTED_SIGKILL_WAIT_MS);
		if (dead) {
			this.running.delete(entry.nodeId);
		}
		return { graceful: false, exitCode: null, signal: 'SIGKILL' };
	}

	async stopAll(graceMs: number): Promise<void> {
		await Promise.all(this.list().map((entry) => this.stop(entry.nodeId, graceMs)));
	}
}
