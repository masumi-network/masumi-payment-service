/**
 * Child-process lifecycle for one hydra-node.
 *
 * Stopping is always SIGTERM first with a bounded wait. SIGKILL exists only as
 * a last resort and is reported back to the caller, because a hard kill is the
 * documented way to strand a head and the supervisor records it so the next
 * start checks for a stranded round.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
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
	child: ChildProcess;
	startedAtMs: number;
};

export class NodeProcessManager {
	private readonly running = new Map<string, RunningNode>();

	isRunning(nodeId: string): boolean {
		const entry = this.running.get(nodeId);
		return entry !== undefined && entry.child.exitCode === null && !entry.child.killed;
	}

	get(nodeId: string): RunningNode | undefined {
		return this.running.get(nodeId);
	}

	list(): RunningNode[] {
		return [...this.running.values()];
	}

	start(
		request: SpawnRequest,
		onExit: (nodeId: string, code: number | null, signal: NodeJS.Signals | null) => void,
	): RunningNode {
		if (this.isRunning(request.nodeId)) {
			throw new Error(`node ${request.nodeId} is already running`);
		}

		const logDir = path.join(request.nodeDir, 'logs');
		fs.mkdirSync(logDir, { recursive: true });
		// Logs go to a file for operator forensics only. Nothing in the supervisor
		// parses them: drift comes from the API, not from stdout.
		const out = fs.openSync(path.join(logDir, 'node.log'), 'a');

		const child = spawn(request.binary, request.args, {
			cwd: request.nodeDir,
			stdio: ['ignore', out, out],
			detached: false,
		});

		const entry: RunningNode = {
			nodeId: request.nodeId,
			pid: child.pid,
			child,
			startedAtMs: Date.now(),
		};
		this.running.set(request.nodeId, entry);

		child.once('exit', (code, signal) => {
			this.running.delete(request.nodeId);
			try {
				fs.closeSync(out);
			} catch {
				// already closed
			}
			onExit(request.nodeId, code, signal);
		});

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

		const exited = new Promise<StopResult>((resolve) => {
			entry.child.once('exit', (code, signal) => {
				resolve({ graceful: signal !== 'SIGKILL', exitCode: code, signal });
			});
		});

		entry.child.kill('SIGTERM');

		const timeout = new Promise<null>((resolve) => {
			const timer = setTimeout(() => resolve(null), graceMs);
			timer.unref?.();
		});

		const settled = await Promise.race([exited, timeout]);
		if (settled !== null) {
			return settled;
		}

		entry.child.kill('SIGKILL');
		return exited;
	}

	async stopAll(graceMs: number): Promise<void> {
		await Promise.all(this.list().map((entry) => this.stop(entry.nodeId, graceMs)));
	}
}
