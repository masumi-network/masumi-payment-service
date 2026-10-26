/** Bounded diagnostic history for a node whose log fd survives Host restarts. */

import fs from 'node:fs/promises';
import path from 'node:path';

export const NODE_LOG_MAX_BYTES = 8 * 1024 * 1024;
export const NODE_LOG_CHECK_MS = 1_000;
const NODE_LOG_COPIES = 2;

/**
 * Copy the last bounded slice, then truncate the live inode. Renaming the live
 * file would leave a running or adopted hydra-node writing to the renamed inode.
 */
export async function rotateNodeLog(logDir: string, maxBytes = NODE_LOG_MAX_BYTES): Promise<boolean> {
	const active = path.join(logDir, 'node.log');
	let reader: fs.FileHandle;
	try {
		reader = await fs.open(active, 'r+');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw error;
	}
	try {
		const size = (await reader.stat()).size;
		if (size <= maxBytes) return false;
		const retainedBytes = Math.min(size, maxBytes);
		const tail = Buffer.alloc(retainedBytes);
		let offset = 0;
		while (offset < retainedBytes) {
			const { bytesRead } = await reader.read(tail, offset, retainedBytes - offset, size - retainedBytes + offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		const oldest = path.join(logDir, `node.log.${NODE_LOG_COPIES}`);
		await fs.rm(oldest, { force: true });
		for (let index = NODE_LOG_COPIES - 1; index >= 1; index--) {
			const current = path.join(logDir, `node.log.${index}`);
			try {
				await fs.rename(current, path.join(logDir, `node.log.${index + 1}`));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			}
		}
		await fs.writeFile(path.join(logDir, 'node.log.1'), tail.subarray(0, offset));
		await reader.truncate(0);
		return true;
	} finally {
		await reader.close();
	}
}
