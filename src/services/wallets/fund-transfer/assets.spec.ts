import { readFundTransferAssets } from './assets';

const POLICY = 'a'.repeat(56);
const USDM = POLICY + '55534424';

describe('readFundTransferAssets', () => {
	it('always leads with the validated lovelaceAmount', () => {
		expect(readFundTransferAssets(5_000_000n, null)).toEqual([{ unit: 'lovelace', quantity: 5_000_000n }]);
	});

	it('appends valid native tokens after lovelace', () => {
		expect(readFundTransferAssets(2_000_000n, [{ unit: USDM, quantity: '100' }])).toEqual([
			{ unit: 'lovelace', quantity: 2_000_000n },
			{ unit: USDM, quantity: 100n },
		]);
	});

	it('drops a lovelace entry inside assets — ADA rides only on lovelaceAmount', () => {
		// mesh would silently pick the FIRST lovelace via .find(), so a second
		// entry here is not summed; dropping it keeps the on-chain amount honest.
		const result = readFundTransferAssets(2_000_000n, [{ unit: 'lovelace', quantity: '9999' }]);
		expect(result).toEqual([{ unit: 'lovelace', quantity: 2_000_000n }]);
	});

	it('skips malformed entries rather than sending a wrong value', () => {
		const result = readFundTransferAssets(2_000_000n, [
			{ unit: USDM, quantity: 'abc' }, // non-integer
			{ unit: USDM, quantity: '-5' }, // negative
			{ unit: USDM, quantity: '0' }, // zero
			{ unit: '', quantity: '10' }, // empty unit
			{ notAnAsset: true },
			null,
			'garbage',
		]);
		expect(result).toEqual([{ unit: 'lovelace', quantity: 2_000_000n }]);
	});

	it('treats a non-array assets column as no tokens', () => {
		expect(readFundTransferAssets(2_000_000n, { unit: USDM } as unknown as null)).toEqual([
			{ unit: 'lovelace', quantity: 2_000_000n },
		]);
	});
});
