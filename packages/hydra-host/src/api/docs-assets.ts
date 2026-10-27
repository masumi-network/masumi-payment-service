import { open } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';

type DocsAsset = { filePath: string; contentType: string };

/** Stream allow-listed docs assets so slow readers cannot pin a full copy per request. */
export async function serveDocsAsset(
	response: ServerResponse,
	asset: DocsAsset,
	headOnly: boolean,
	onError: (error: Error) => void,
): Promise<void> {
	const file = await open(asset.filePath, 'r');
	if (response.destroyed) {
		await file.close();
		return;
	}

	const headers = {
		'Content-Type': asset.contentType,
		'Cache-Control': 'public, max-age=300',
		'X-Content-Type-Options': 'nosniff',
	};
	if (headOnly) {
		try {
			const { size } = await file.stat();
			if (!response.destroyed) {
				response.writeHead(200, { ...headers, 'Content-Length': size });
				response.end();
			}
		} finally {
			await file.close();
		}
		return;
	}

	const stream = file.createReadStream();
	stream.on('error', (error: Error) => {
		onError(error);
		response.destroy();
	});
	response.once('close', () => stream.destroy());
	if (response.destroyed) {
		stream.destroy();
		return;
	}
	response.writeHead(200, headers);
	stream.pipe(response);
}
