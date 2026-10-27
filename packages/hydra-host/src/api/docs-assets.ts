import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';

type DocsAsset = { filePath: string; contentType: string };
type ReadAsset = (filePath: string) => Promise<Buffer>;

/**
 * Serve allow-listed docs assets from memory. The routes are public, so a
 * disk read and a fresh copy per request would let anyone turn requests into
 * disk I/O and memory. The allow-list is a fixed handful of files, so the
 * cache is bounded. A failed read is not cached, so the next request retries.
 */
export function createDocsAssetServer(read: ReadAsset = readFile) {
	const cache = new Map<string, Promise<Buffer>>();
	const load = (filePath: string): Promise<Buffer> => {
		let body = cache.get(filePath);
		if (!body) {
			body = read(filePath);
			cache.set(filePath, body);
			body.catch(() => cache.delete(filePath));
		}
		return body;
	};

	return async (response: ServerResponse, asset: DocsAsset, headOnly: boolean): Promise<void> => {
		const body = await load(asset.filePath);
		if (response.destroyed) return;
		response.writeHead(200, {
			'Content-Type': asset.contentType,
			'Content-Length': body.byteLength,
			'Cache-Control': 'public, max-age=300',
			'X-Content-Type-Options': 'nosniff',
		});
		response.end(headOnly ? undefined : body);
	};
}
