import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DEFAULT_V1_COST_MODEL_LIST, DEFAULT_V2_COST_MODEL_LIST, DEFAULT_V3_COST_MODEL_LIST } from '@meshsdk/core';
import { syncMeshCostModelsFromHeadV2 } from './mesh-cost-model-sync';

// syncMeshCostModelsFromHeadV2 mutates the V2 mesh line's bundled cost-model
// arrays in place (that's the whole point — core-cst hashes the script data
// from these exact arrays). Snapshot + restore so the mutation can't leak into
// other specs sharing the same process-global mesh module.
describe('syncMeshCostModelsFromHeadV2', () => {
	let v1Original: number[];
	let v2Original: number[];
	let v3Original: number[];

	beforeEach(() => {
		v1Original = [...DEFAULT_V1_COST_MODEL_LIST];
		v2Original = [...DEFAULT_V2_COST_MODEL_LIST];
		v3Original = [...DEFAULT_V3_COST_MODEL_LIST];
	});

	afterEach(() => {
		DEFAULT_V1_COST_MODEL_LIST.splice(0, DEFAULT_V1_COST_MODEL_LIST.length, ...v1Original);
		DEFAULT_V2_COST_MODEL_LIST.splice(0, DEFAULT_V2_COST_MODEL_LIST.length, ...v2Original);
		DEFAULT_V3_COST_MODEL_LIST.splice(0, DEFAULT_V3_COST_MODEL_LIST.length, ...v3Original);
	});

	it('patches the V2 mesh cost-model arrays in place with the head payload', async () => {
		const patched = await syncMeshCostModelsFromHeadV2({
			PlutusV1: [11, 22, 33],
			PlutusV2: [44, 55, 66, 77],
			PlutusV3: [88, 99],
		});

		expect(patched).toBe(true);
		expect([...DEFAULT_V1_COST_MODEL_LIST]).toEqual([11, 22, 33]);
		expect([...DEFAULT_V2_COST_MODEL_LIST]).toEqual([44, 55, 66, 77]);
		expect([...DEFAULT_V3_COST_MODEL_LIST]).toEqual([88, 99]);
	});

	it('keeps the SAME array reference (in-place splice, not reassignment)', async () => {
		const v2Ref = DEFAULT_V2_COST_MODEL_LIST;

		await syncMeshCostModelsFromHeadV2({ PlutusV2: [1, 2, 3] });

		// core-cst captures the array reference at complete() time; reassigning
		// would orphan the patch. Verify identity is preserved.
		expect(DEFAULT_V2_COST_MODEL_LIST).toBe(v2Ref);
		expect([...v2Ref]).toEqual([1, 2, 3]);
	});

	it('patches only the languages present in the payload, leaving others intact', async () => {
		const patched = await syncMeshCostModelsFromHeadV2({ PlutusV2: [7, 8, 9] });

		expect(patched).toBe(true);
		expect([...DEFAULT_V2_COST_MODEL_LIST]).toEqual([7, 8, 9]);
		expect([...DEFAULT_V1_COST_MODEL_LIST]).toEqual(v1Original);
		expect([...DEFAULT_V3_COST_MODEL_LIST]).toEqual(v3Original);
	});

	it('returns false and leaves arrays untouched when the head supplies no models', async () => {
		const patched = await syncMeshCostModelsFromHeadV2({});

		expect(patched).toBe(false);
		expect([...DEFAULT_V1_COST_MODEL_LIST]).toEqual(v1Original);
		expect([...DEFAULT_V2_COST_MODEL_LIST]).toEqual(v2Original);
		expect([...DEFAULT_V3_COST_MODEL_LIST]).toEqual(v3Original);
	});

	it('rejects a malformed (non-array) language entry without partial patching', async () => {
		const patched = await syncMeshCostModelsFromHeadV2({
			PlutusV2: 'not-an-array' as unknown as number[],
		});

		expect(patched).toBe(false);
		expect([...DEFAULT_V2_COST_MODEL_LIST]).toEqual(v2Original);
	});
});
