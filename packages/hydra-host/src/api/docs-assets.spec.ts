import { describe, expect, it, jest } from '@jest/globals';
import type { ServerResponse } from 'node:http';
import { createDocsAssetServer } from './docs-assets';

const ASSET = { filePath: '/assets/bundle.js', contentType: 'text/javascript' };

function fakeResponse() {
	const writeHead = jest.fn();
	const end = jest.fn();
	return { response: { destroyed: false, writeHead, end } as unknown as ServerResponse, writeHead, end };
}

describe('createDocsAssetServer', () => {
	it('reads each public asset from disk once, however many requests arrive', async () => {
		const read = jest.fn(async () => Buffer.from('bundle'));
		const serve = createDocsAssetServer(read);

		for (let index = 0; index < 5; index += 1) await serve(fakeResponse().response, ASSET, false);

		expect(read).toHaveBeenCalledTimes(1);
	});

	it('retries a failed read on the next request', async () => {
		const read = jest
			.fn<(filePath: string) => Promise<Buffer>>()
			.mockRejectedValueOnce(new Error('EIO'))
			.mockResolvedValue(Buffer.from('bundle'));
		const serve = createDocsAssetServer(read);

		await expect(serve(fakeResponse().response, ASSET, false)).rejects.toThrow('EIO');
		const { response, end } = fakeResponse();
		await serve(response, ASSET, false);

		expect(end).toHaveBeenCalledWith(Buffer.from('bundle'));
	});
});
