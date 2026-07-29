/**
 * Durable node registry on the persistence volume.
 *
 * Every mutation is written temp-then-rename with an fsync on both the file and
 * its directory, because a torn `node.json` would orphan a node that still
 * holds a peer port, a key pair and a persistence directory — and the Host
 * rebuilds its port allocation from these records at boot, so a half-written
 * one is not a cosmetic problem.
 */

import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { getOwnInteger, getOwnString, isPlainObject } from './json.js';
import type { NodeRecord } from './types.js';

const NODE_FILE = 'node.json';

export class RegistryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RegistryError';
	}
}

async function fsyncDir(dir: string): Promise<void> {
	// Renaming is only durable once the *directory* entry is flushed. Not all
	// platforms permit opening a directory for fsync, so failures here are
	// tolerated rather than fatal.
	let handle: FileHandle | undefined;
	try {
		handle = await fs.open(dir, 'r');
		await handle.sync();
	} catch {
		// best effort
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
	const dir = path.dirname(filePath);
	const tmp = path.join(dir, `.${path.basename(filePath)}.tmp`);
	let handle: FileHandle | undefined;
	try {
		handle = await fs.open(tmp, 'w');
		await handle.writeFile(contents, 'utf8');
		await handle.sync();
	} finally {
		await handle?.close().catch(() => undefined);
	}
	await fs.rename(tmp, filePath);
	await fsyncDir(dir);
}

function parseNodeRecord(raw: string, source: string): NodeRecord {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new RegistryError(`${source} is not valid JSON; the registry may be damaged`);
	}
	if (!isPlainObject(parsed)) {
		throw new RegistryError(`${source} does not contain a node record`);
	}
	const nodeId = getOwnString(parsed, 'nodeId');
	const peerPort = getOwnInteger(parsed, 'peerPort');
	if (nodeId === undefined || nodeId.length === 0) {
		throw new RegistryError(`${source} is missing nodeId`);
	}
	if (peerPort === undefined) {
		throw new RegistryError(`${source} is missing a usable peerPort`);
	}
	return parsed as unknown as NodeRecord;
}

export class NodeRegistryStore {
	private readonly nodesDir: string;

	constructor(dataDir: string) {
		this.nodesDir = path.join(dataDir, 'nodes');
	}

	nodeDir(nodeId: string): string {
		if (nodeId.includes('/') || nodeId.includes('..') || nodeId.length === 0) {
			throw new RegistryError(`refusing to resolve a directory for suspicious nodeId ${JSON.stringify(nodeId)}`);
		}
		return path.join(this.nodesDir, nodeId);
	}

	async ensureLayout(nodeId: string): Promise<string> {
		const dir = this.nodeDir(nodeId);
		await fs.mkdir(path.join(dir, 'keys'), { recursive: true, mode: 0o700 });
		await fs.mkdir(path.join(dir, 'persistence'), { recursive: true });
		await fs.mkdir(path.join(dir, 'peers'), { recursive: true });
		return dir;
	}

	/**
	 * Persist a record wholesale.
	 *
	 * Prefer {@link update} for anything that changes an existing node: writing a
	 * snapshot captured earlier silently discards whatever else touched the
	 * record in between, and process-exit handlers do exactly that.
	 */
	async write(record: NodeRecord): Promise<void> {
		const dir = this.nodeDir(record.nodeId);
		await fs.mkdir(dir, { recursive: true });
		const next = { ...record, updatedAt: new Date().toISOString() };
		await writeFileAtomic(path.join(dir, NODE_FILE), `${JSON.stringify(next, null, 2)}\n`);
	}

	/**
	 * Read-modify-write. The mutator receives the record as it is on disk *now*,
	 * so no caller can persist a stale snapshot — which is the whole class of bug
	 * that lets an async exit handler's update be overwritten by an in-flight
	 * start.
	 *
	 * Returns the written record, or null when the node no longer exists.
	 */
	async update(nodeId: string, mutate: (current: NodeRecord) => NodeRecord): Promise<NodeRecord | null> {
		const current = await this.read(nodeId);
		if (current === null) {
			return null;
		}
		const next = mutate(current);
		if (next.nodeId !== nodeId) {
			throw new RegistryError(`a mutator may not change nodeId (${nodeId} -> ${next.nodeId})`);
		}
		await this.write(next);
		return next;
	}

	async read(nodeId: string): Promise<NodeRecord | null> {
		const file = path.join(this.nodeDir(nodeId), NODE_FILE);
		let raw: string;
		try {
			raw = await fs.readFile(file, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return null;
			}
			throw error;
		}
		return parseNodeRecord(raw, file);
	}

	/**
	 * Load every record. A damaged record is surfaced rather than skipped: the
	 * caller rebuilds port allocation from this list, and silently dropping an
	 * entry would let a live node's port be handed to a new one.
	 */
	async list(): Promise<NodeRecord[]> {
		let entries: string[];
		try {
			entries = await fs.readdir(this.nodesDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return [];
			}
			throw error;
		}

		const records: NodeRecord[] = [];
		for (const entry of entries.sort()) {
			if (entry.startsWith('.')) {
				continue;
			}
			const record = await this.read(entry);
			if (record !== null) {
				records.push(record);
			}
		}
		return records;
	}

	/**
	 * Remove a node's whole directory, including its persistence. Callers must
	 * have confirmed the head is finalised — this destroys the only copy of the
	 * head state held on this host.
	 */
	async remove(nodeId: string): Promise<void> {
		await fs.rm(this.nodeDir(nodeId), { recursive: true, force: true });
		await fsyncDir(this.nodesDir);
	}
}
