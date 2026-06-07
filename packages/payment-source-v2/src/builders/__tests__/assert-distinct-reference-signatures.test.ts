import { jest } from '@jest/globals';
import type { UTxO } from '@meshsdk/core';

/**
 * Build a stub UTxO whose `plutusData` carries a `PLACEHOLDER_<hex>` marker.
 * The mocked `deserializeDatum` below recognises that marker and returns a
 * minimal decoded shape with `fields[5].bytes` set to <hex>. This decouples
 * the test from mesh's CBOR serializer while still exercising the extractor's
 * field-index logic (which is the part most likely to drift if the V2 datum
 * layout changes).
 *
 * Under jest's ESM-mode runner the `jest` global is not injected and
 * `jest.mock` is not hoisted; the mock must be registered with
 * `jest.unstable_mockModule(...)` before the module under test is pulled in
 * via dynamic `await import(...)`.
 */
function utxoWithRefSig(txHash: string, outputIndex: number, referenceSignatureHex: string): UTxO {
	return {
		input: { txHash, outputIndex },
		output: {
			address: 'addr_test1placeholder',
			amount: [{ unit: 'lovelace', quantity: '5000000' }],
			plutusData: `PLACEHOLDER_${referenceSignatureHex}`,
		},
	} as unknown as UTxO;
}

jest.unstable_mockModule('@meshsdk/core', () => {
	const actual = jest.requireActual('@meshsdk/core') as Record<string, unknown>;
	return {
		...actual,
		deserializeDatum: (data: string) => {
			if (typeof data !== 'string' || !data.startsWith('PLACEHOLDER_')) {
				throw new Error(`unrecognized test datum: ${data}`);
			}
			const refSig = data.slice('PLACEHOLDER_'.length);
			return {
				constructor: 0,
				fields: [
					{}, // 0 buyerAddr
					{}, // 1 buyerReturnAddr
					{}, // 2 sellerAddr
					{}, // 3 sellerReturnAddr
					{ bytes: '' }, // 4 referenceKey
					{ bytes: refSig }, // 5 referenceSignature — what the extractor reads
				],
			};
		},
	};
});

const { assertDistinctReferenceSignatures } = await import('../assert-distinct-reference-signatures');

describe('assertDistinctReferenceSignatures', () => {
	it('passes when all reference_signatures are distinct', () => {
		const items = [
			{ smartContractUtxo: utxoWithRefSig('aaaa', 0, 'deadbeef'.repeat(4)) },
			{ smartContractUtxo: utxoWithRefSig('bbbb', 0, 'cafebabe'.repeat(4)) },
			{ smartContractUtxo: utxoWithRefSig('cccc', 0, 'feedface'.repeat(4)) },
		];
		expect(() => assertDistinctReferenceSignatures(items)).not.toThrow();
	});

	it('throws when two items share a reference_signature (fabricated collision)', () => {
		const collidingRefSig = 'deadbeef'.repeat(4);
		const items = [
			{ smartContractUtxo: utxoWithRefSig('aaaa', 0, collidingRefSig) },
			{ smartContractUtxo: utxoWithRefSig('bbbb', 1, collidingRefSig) },
		];
		expect(() => assertDistinctReferenceSignatures(items)).toThrow(/Duplicate reference_signature/);
	});

	it('reports both offending refs in the error message', () => {
		const collidingRefSig = '11'.repeat(16);
		const items = [
			{ smartContractUtxo: utxoWithRefSig('aaaa', 0, collidingRefSig) },
			{ smartContractUtxo: utxoWithRefSig('bbbb', 1, collidingRefSig) },
		];
		expect(() => assertDistinctReferenceSignatures(items)).toThrow(/aaaa#0.*bbbb#1|bbbb#1.*aaaa#0/);
	});

	it('skips items whose datum cannot be decoded', () => {
		const malformedUtxo = {
			input: { txHash: 'dddd', outputIndex: 0 },
			output: {
				address: 'addr_test1placeholder',
				amount: [{ unit: 'lovelace', quantity: '5000000' }],
				plutusData: undefined,
			},
		} as unknown as UTxO;
		const items = [
			{ smartContractUtxo: malformedUtxo },
			{ smartContractUtxo: utxoWithRefSig('eeee', 0, 'aa'.repeat(16)) },
		];
		expect(() => assertDistinctReferenceSignatures(items)).not.toThrow();
	});

	it('is a no-op on an empty batch', () => {
		expect(() => assertDistinctReferenceSignatures([])).not.toThrow();
	});

	it('is a no-op on a single-item batch', () => {
		const items = [{ smartContractUtxo: utxoWithRefSig('aaaa', 0, 'aa'.repeat(16)) }];
		expect(() => assertDistinctReferenceSignatures(items)).not.toThrow();
	});
});
