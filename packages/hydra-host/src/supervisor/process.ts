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
	/**
	 * Whether the process is actually gone.
	 *
	 * Distinct from `graceful`: a SIGKILL that lands is ungraceful but stopped,
	 * and one that does not land — a process blocked in uninterruptible I/O, say
	 * — is neither. The caller acts on this bit by deleting the node's
	 * persistence directory and handing its peer port to the next provision, so
	 * conflating the two removes the files of a node that is still writing them.
	 */
	stopped: boolean;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
};

export type RunningNode = {
	nodeId: string;
	pid: number | undefined;
	/** Absent for an adopted node: it is not a child of this process. */
	child?: ChildProcess;
	/**
	 * How to re-identify an adopted process, kept from the adoption that
	 * accepted it. An adopted node has no exit event, so nothing reports its
	 * death: the entry survives it, and after pid reuse it names whatever now
	 * holds that number — including a sibling hydra-node on this same host.
	 * Checked again before any signal, so a stop cannot land on the neighbour.
	 */
	identity?: { binary: string; nodeDir: string };
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
 * Whether the process at `pid` is running THIS node.
 *
 * Pids are reused, and this manager's whole purpose is to send signals to one.
 * A record that survived a machine reboot can name a pid that now belongs to
 * something else entirely, so the command line is checked before that pid is
 * ever treated as a hydra-node. Anything unverifiable answers false: refusing
 * to adopt costs a supervisor that cannot stop one node, while adopting wrongly
 * costs an unrelated process a SIGKILL.
 *
 * The binary alone is not enough to identify a node, because one host runs many
 * of them: every head gets its own hydra-node, all from the same binary, so a
 * stale pid from a previous incarnation of the host matches its neighbour's
 * live process just as readily as its own. That match is not a false positive
 * that costs a probe — it is the supervisor reporting node A as up because node
 * B is, and later sending node B a SIGKILL in node A's name, mid-round. So the
 * node's own directory, which appears in its argv as `--persistence-dir` and is
 * unique per node, has to be there too.
 */
export async function isProcessRunningNode(pid: number, binary: string, nodeDir: string): Promise<boolean> {
	const needle = path.basename(binary);
	if (needle.length === 0 || nodeDir.length === 0) {
		return false;
	}
	const command = await readProcessCommand(pid);
	return command !== null && command.includes(needle) && command.includes(nodeDir);
}

/**
 * One process's command line, or null if it cannot be read.
 *
 * `/proc` first, and not only because it is faster: the runtime image is a slim
 * Debian with Node and certificates on it, so `ps` is a dependency this package
 * would rather not have. Where `/proc` exists the answer is authoritative and
 * needs no subprocess at all; `ps` remains the fallback for macOS, where the
 * native launcher runs during development.
 */
async function readProcessCommand(pid: number): Promise<string | null> {
	try {
		const raw = await fs.readFile(`/proc/${pid}/cmdline`, 'utf8');
		// argv arrives NUL-separated, with a trailing NUL.
		return raw.replace(/\0+$/, '').split('\0').join(' ');
	} catch {
		// Not Linux, or the process is gone. `ps` distinguishes the two.
	}
	return await new Promise<string | null>((resolve) => {
		execFile('ps', ['-p', String(pid), '-o', 'command='], { timeout: 5_000 }, (error, stdout) => {
			resolve(error === null ? stdout : null);
		});
	});
}

/**
 * Find the live process running this node, by what it is running rather than by
 * a pid we recorded.
 *
 * The recorded pid can only be written once the spawn returns, so a host that
 * dies in that window leaves a node running with nothing naming it: the record
 * says `Starting` with no pid, and the next boot has no way to tell a node that
 * survived from one that never came up. It then starts a second hydra-node over
 * the first one's persistence directory, api port and etcd data dir.
 *
 * The node's own directory is the identity, exactly as in `isProcessRunningNode`
 * — it appears in argv as `--persistence-dir` and no two nodes share one — so a
 * match here is the same evidence, arrived at from the other direction.
 */
export async function findProcessRunningNode(binary: string, nodeDir: string): Promise<number | null> {
	const needle = path.basename(binary);
	if (needle.length === 0 || nodeDir.length === 0) {
		return null;
	}
	for (const { pid, command } of await listProcessCommands()) {
		if (command.includes(needle) && command.includes(nodeDir)) {
			return pid;
		}
	}
	return null;
}

/**
 * Every visible process and its command line.
 *
 * Read in one pass rather than one probe per pid: a machine has hundreds of
 * processes, and a `ps` for each would be hundreds of subprocesses for a single
 * question asked at boot.
 */
async function listProcessCommands(): Promise<Array<{ pid: number; command: string }>> {
	try {
		const entries = await fs.readdir('/proc');
		const pids = entries.filter((entry) => /^\d+$/.test(entry)).map((entry) => Number(entry));
		if (pids.length > 0) {
			const read = await Promise.all(
				pids.map(async (pid) => ({ pid, command: (await readProcessCommand(pid)) ?? '' })),
			);
			return read.filter((entry) => entry.command.length > 0);
		}
	} catch {
		// Not Linux.
	}
	const listing = await new Promise<string | null>((resolve) => {
		execFile('ps', ['-eo', 'pid=,command='], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
			resolve(error === null ? stdout : null);
		});
	});
	if (listing === null) return [];
	const rows: Array<{ pid: number; command: string }> = [];
	for (const line of listing.split('\n')) {
		const match = /^\s*(\d+)\s+(.*)$/.exec(line);
		if (match === null) continue;
		rows.push({ pid: Number(match[1]), command: match[2] });
	}
	return rows;
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
	 * Returns false when the pid is dead or is not running this node's own
	 * `binary` out of `nodeDir`, in which case nothing is registered and the
	 * caller is no worse off than before.
	 */
	async adopt(nodeId: string, pid: number, binary: string, nodeDir: string): Promise<boolean> {
		if (this.isRunning(nodeId)) {
			return false;
		}
		if (!isProcessAlive(pid) || !(await isProcessRunningNode(pid, binary, nodeDir))) {
			return false;
		}
		this.running.set(nodeId, { nodeId, pid, startedAtMs: Date.now(), identity: { binary, nodeDir } });
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
			return { graceful: true, stopped: true, exitCode: null, signal: null };
		}
		if (entry.child === undefined) {
			return this.stopAdopted(entry, graceMs);
		}

		const child = entry.child;
		const exited = new Promise<StopResult>((resolve) => {
			const settle = (code: number | null, signal: NodeJS.Signals | null): void =>
				resolve({ graceful: signal !== 'SIGKILL', stopped: true, exitCode: code, signal });
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
			return { graceful: true, stopped: true, exitCode: null, signal: null };
		}
		// Re-checked here, not only at adoption. An adopted node is not a child, so
		// its death goes unobserved and this entry outlives it; once the pid is
		// reused the signal below would land on whatever inherited the number,
		// which on this host is most likely a sibling node mid-round.
		if (
			entry.identity !== undefined &&
			!(await isProcessRunningNode(pid, entry.identity.binary, entry.identity.nodeDir))
		) {
			this.running.delete(entry.nodeId);
			return { graceful: true, stopped: true, exitCode: null, signal: null };
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
			return { graceful: true, stopped: true, exitCode: null, signal: null };
		}

		if (await waitForExit(graceMs)) {
			this.running.delete(entry.nodeId);
			return { graceful: true, stopped: true, exitCode: null, signal: 'SIGTERM' };
		}

		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			// The pid went between the wait and the signal, which is the process
			// exiting on the SIGTERM it was already sent.
			this.running.delete(entry.nodeId);
			return { graceful: false, stopped: true, exitCode: null, signal: 'SIGKILL' };
		}

		const dead = await waitForExit(ADOPTED_SIGKILL_WAIT_MS);
		if (dead) {
			this.running.delete(entry.nodeId);
		}
		// `dead` is the whole point of the wait and it used to be discarded here,
		// so a SIGKILL that never landed reported the same result as one that did.
		return { graceful: false, stopped: dead, exitCode: null, signal: 'SIGKILL' };
	}

	async stopAll(graceMs: number): Promise<void> {
		await Promise.all(this.list().map((entry) => this.stop(entry.nodeId, graceMs)));
	}
}
