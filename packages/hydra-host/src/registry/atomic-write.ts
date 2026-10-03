/**
 * Durable writes on the persistence volume.
 *
 * Temp-then-rename with an fsync on both the file and its directory. A torn
 * record here is not cosmetic: the registry is what the Host rebuilds its port
 * allocation from at boot, and the exchange log is what decides whether an
 * invite has already been redeemed.
 */

import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

export async function fsyncDir(dir: string): Promise<void> {
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

let tempCounter = 0;

export async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
	const dir = path.dirname(filePath);
	// The temp name must be unique per write. A shared name lets two concurrent
	// writers race: the first rename consumes the file and the second fails with
	// ENOENT, losing that update. Observed in a running host when a node exited
	// while its state was being reconciled.
	const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${tempCounter++}.tmp`);
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
