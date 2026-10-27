import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readBlockfrostLatestParameters } from './init-admission.js';

const PARAMETERS = { max_tx_size: 16_384, max_val_size: 5_000, coins_per_utxo_size: '4310' };
let dataDir: string;
let projectFile: string;

beforeEach(async () => {
	dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hydra-init-blockfrost-'));
	projectFile = path.join(dataDir, 'project-id');
	await fs.writeFile(projectFile, 'preprod-project-id\n', { mode: 0o600 });
});

afterEach(async () => {
	await fs.rm(dataDir, { recursive: true, force: true });
});

describe('Blockfrost Init admission reader', () => {
	it('uses the network endpoint and mounted project ID for a fresh parameter read', async () => {
		let requestedUrl = '';
		let sentProjectId: string | null = null;
		let redirectPolicy: RequestRedirect | undefined;
		const fetchStub: typeof fetch = async (input, init) => {
			requestedUrl = String(input);
			sentProjectId = new Headers(init?.headers).get('project_id');
			redirectPolicy = init?.redirect;
			return new Response(JSON.stringify(PARAMETERS), { status: 200 });
		};

		const result = await readBlockfrostLatestParameters('preprod', projectFile, fetchStub);

		expect(requestedUrl).toBe('https://cardano-preprod.blockfrost.io/api/v0/epochs/latest/parameters');
		expect(sentProjectId).toBe('preprod-project-id');
		expect(redirectPolicy).toBe('error');
		expect(result).toEqual(PARAMETERS);
	});

	it('uses the mainnet endpoint for a mainnet Host', async () => {
		let requestedUrl = '';
		const fetchStub: typeof fetch = async (input) => {
			requestedUrl = String(input);
			return new Response(JSON.stringify(PARAMETERS), { status: 200 });
		};
		await readBlockfrostLatestParameters('mainnet', projectFile, fetchStub);
		expect(requestedUrl).toBe('https://cardano-mainnet.blockfrost.io/api/v0/epochs/latest/parameters');
	});

	it.each([302, 403, 429, 500])('fails closed on Blockfrost HTTP %s', async (status) => {
		const fetchStub: typeof fetch = async () => new Response('{}', { status });
		await expect(readBlockfrostLatestParameters('preprod', projectFile, fetchStub)).rejects.toMatchObject({
			status: 503,
		});
	});

	it('fails closed when the response exceeds the byte limit', async () => {
		const fetchStub: typeof fetch = async () => new Response('x'.repeat(70_000), { status: 200 });
		await expect(readBlockfrostLatestParameters('preprod', projectFile, fetchStub)).rejects.toMatchObject({
			status: 503,
		});
	});

	it('does not make a request when the project file is absent', async () => {
		await fs.rm(projectFile);
		let wasCalled = false;
		const fetchStub: typeof fetch = async () => {
			wasCalled = true;
			return new Response('{}', { status: 200 });
		};
		await expect(readBlockfrostLatestParameters('preprod', projectFile, fetchStub)).rejects.toMatchObject({
			status: 503,
		});
		expect(wasCalled).toBe(false);
	});
});
