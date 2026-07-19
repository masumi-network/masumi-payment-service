import { calculateDistributionMinLovelace, calculateDistributionValueSize } from './min-utxo';

const TEST_ADDRESS =
	'addr_test1qq0e6dy7cehm9zfqurcf8mwwg9te9nszsx5gy5q4eclpd0czhmdlpagxe5n8ppnrf6424tt8gwweumrtg2q7234x2p2qzjenfx';
const POLICY_ID = 'ab'.repeat(28);

describe('calculateDistributionMinLovelace', () => {
	it('measures the serialized Value used by the protocol size limit', () => {
		const oneAsset = calculateDistributionValueSize([
			{ unit: 'lovelace', quantity: 2_000_000n },
			{ unit: `${POLICY_ID}01`, quantity: 1n },
		]);
		const manyAssets = calculateDistributionValueSize([
			{ unit: 'lovelace', quantity: 2_000_000n },
			...Array.from({ length: 24 }, (_, index) => ({
				unit: `${POLICY_ID}${index.toString(16).padStart(64, '0')}`,
				quantity: 1n,
			})),
		]);

		expect(manyAssets).toBeGreaterThan(oneAsset);
	});

	it('grows with the serialized native-asset bundle', () => {
		const oneAsset = calculateDistributionMinLovelace({
			address: TEST_ADDRESS,
			assets: [{ unit: `${POLICY_ID}01`, quantity: 1n }],
			coinsPerUtxoSize: 4310,
		});
		const manyAssets = calculateDistributionMinLovelace({
			address: TEST_ADDRESS,
			assets: Array.from({ length: 24 }, (_, index) => ({
				unit: `${POLICY_ID}${index.toString(16).padStart(64, '0')}`,
				quantity: 1n,
			})),
			coinsPerUtxoSize: 4310,
		});

		expect(manyAssets).toBeGreaterThan(oneAsset);
		expect(manyAssets).toBeGreaterThan(2_000_000n);
	});

	it('uses the supplied protocol cost', () => {
		const assets = [{ unit: `${POLICY_ID}01`, quantity: 1n }];
		const currentCost = calculateDistributionMinLovelace({
			address: TEST_ADDRESS,
			assets,
			coinsPerUtxoSize: 4310,
		});
		const doubledCost = calculateDistributionMinLovelace({
			address: TEST_ADDRESS,
			assets,
			coinsPerUtxoSize: 8620,
		});

		expect(doubledCost).toBe(currentCost * 2n);
	});
});
