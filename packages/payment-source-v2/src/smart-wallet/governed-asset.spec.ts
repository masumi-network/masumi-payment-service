import { describe, expect, it } from '@jest/globals';
import { MAINNET_USDCX_UNIT, PREPROD_USDM_UNIT } from '@/utils/asset-units';
import { assetUnitOf, exchainAssetIdOf, governableAssetIds, LOVELACE_ASSET_ID } from './governed-asset';

const TUSDM_ID = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde.0014df10745553444d';

describe('governed asset ids', () => {
	it('converts a concatenated unit to the dotted Exchain id and back', () => {
		expect(exchainAssetIdOf(PREPROD_USDM_UNIT)).toBe(TUSDM_ID);
		expect(assetUnitOf(TUSDM_ID)).toBe(PREPROD_USDM_UNIT);
	});

	it('maps both lovelace spellings to lovelace', () => {
		expect(exchainAssetIdOf('')).toBe(LOVELACE_ASSET_ID);
		expect(exchainAssetIdOf('lovelace')).toBe(LOVELACE_ASSET_ID);
		expect(assetUnitOf(LOVELACE_ASSET_ID)).toBe('lovelace');
	});

	it('offers tUSDM on preprod and USDM plus USDCx on mainnet', () => {
		expect(governableAssetIds('preprod')).toEqual([LOVELACE_ASSET_ID, TUSDM_ID]);
		expect(governableAssetIds('mainnet')).toContain(exchainAssetIdOf(MAINNET_USDCX_UNIT));
		expect(governableAssetIds('preprod')).not.toContain(exchainAssetIdOf(MAINNET_USDCX_UNIT));
	});
});
