import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
	BlockfrostProvider,
	DEFAULT_V1_COST_MODEL_LIST as ROOT_V1_COST_MODEL_LIST,
	DEFAULT_V2_COST_MODEL_LIST as ROOT_V2_COST_MODEL_LIST,
	DEFAULT_V3_COST_MODEL_LIST as ROOT_V3_COST_MODEL_LIST,
} from '../../../../node_modules/@meshsdk/core/dist/index.js';
import { DEFAULT_V1_COST_MODEL_LIST, DEFAULT_V2_COST_MODEL_LIST, DEFAULT_V3_COST_MODEL_LIST } from '@meshsdk/core';

const rootArrays = [ROOT_V1_COST_MODEL_LIST, ROOT_V2_COST_MODEL_LIST, ROOT_V3_COST_MODEL_LIST];
const rootOriginals = rootArrays.map((v) => [...v]);
const originals = [DEFAULT_V1_COST_MODEL_LIST, DEFAULT_V2_COST_MODEL_LIST, DEFAULT_V3_COST_MODEL_LIST].map((v) => [
	...v,
]);
const models = (value: number) => ({
	PlutusV1: [value, ...originals[0].slice(1)],
	PlutusV2: [value, ...originals[1].slice(1)],
	PlutusV3: [value, ...originals[2].slice(1)],
});
const mockParameters = jest.fn<(key: string) => Promise<unknown>>();
jest.unstable_mockModule('@blockfrost/blockfrost-js', () => ({
	BlockFrostAPI: class {
		constructor(private options: { projectId: string }) {}
		async epochsLatestParameters() {
			return await mockParameters(this.options.projectId);
		}
	},
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({ logger: { info() {}, warn() {}, error() {} } }));
const { withMeshCostModelLock } = await import('@/utils/mesh-cost-model-sync');
const { syncMeshCostModelsFromChainV2, syncMeshCostModelsFromHeadV2 } = await import('./mesh-cost-model-sync');

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

afterEach(() => {
	rootArrays.forEach((v, i) => v.splice(0, v.length, ...rootOriginals[i]));
	[DEFAULT_V1_COST_MODEL_LIST, DEFAULT_V2_COST_MODEL_LIST, DEFAULT_V3_COST_MODEL_LIST].forEach((v, i) =>
		v.splice(0, v.length, ...originals[i]),
	);
	jest.restoreAllMocks();
});

describe('cost-model isolation across heads and provider keys', () => {
	it('blocks a direct sync while another key holds a build lock', async () => {
		const held = deferred();
		const release = deferred();
		let synced = false;
		const build = withMeshCostModelLock('mainnet-build', async () => {
			await syncMeshCostModelsFromHeadV2(models(111));
			held.resolve();
			await release.promise;
			expect(DEFAULT_V3_COST_MODEL_LIST[0]).toBe(111);
		});
		await held.promise;
		const directSync = syncMeshCostModelsFromHeadV2(models(222)).then(() => {
			synced = true;
		});
		try {
			await new Promise((done) => setImmediate(done));
			expect(synced).toBe(false);
		} finally {
			release.resolve();
			await Promise.all([build, directSync]);
		}
		expect(DEFAULT_V3_COST_MODEL_LIST[0]).toBe(222);
	});

	it('reapplies cached models after another provider key changes the arrays', async () => {
		jest
			.spyOn(BlockfrostProvider.prototype, 'fetchProtocolParameters')
			.mockResolvedValue({ coinsPerUtxoSize: 4310 } as never);
		mockParameters.mockImplementation(async (key) => ({
			epoch: 1,
			cost_models_raw: models(key.endsWith('A') ? 111 : 222),
		}));
		await syncMeshCostModelsFromChainV2('mainnet-cache-A');
		await syncMeshCostModelsFromChainV2('preprod-cache-B');
		const calls = mockParameters.mock.calls.length;
		await syncMeshCostModelsFromChainV2('mainnet-cache-A');
		expect(mockParameters.mock.calls.length).toBe(calls);
		expect(DEFAULT_V3_COST_MODEL_LIST[0]).toBe(111);
		expect(ROOT_V3_COST_MODEL_LIST[0]).toBe(111);
	});
});
