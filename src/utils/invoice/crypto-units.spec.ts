import { describe, expect, it } from '@jest/globals';
import { MAINNET_USDCX_UNIT, MAINNET_USDM_UNIT, PREPROD_USDM_UNIT, formatCryptoUnitConversion } from './crypto-units';

/**
 * These constants label the currency an invoice states its conversion rate in.
 * A wrong hex string or a wrong label mislabels real money on a document a
 * customer keeps, and nothing downstream would notice.
 */
describe('formatCryptoUnitConversion', () => {
	it.each(['', 'lovelace', 'LOVELACE'])('labels the ADA alias %p as ADA', (unit) => {
		expect(formatCryptoUnitConversion(unit, '1.5')).toBe(' 1.5 ADA');
	});

	it.each([
		[MAINNET_USDCX_UNIT, 'USDCx'],
		[MAINNET_USDM_UNIT, 'USDM'],
		[PREPROD_USDM_UNIT, 'tUSDM'],
	])('labels %s as %s', (unit, expected) => {
		expect(formatCryptoUnitConversion(unit, '2')).toBe(` 2 ${expected}`);
	});

	it('falls back to the raw unit when it recognises nothing', () => {
		expect(formatCryptoUnitConversion('deadbeef', '3')).toBe(' 3 deadbeef');
	});

	it('keeps the three units distinct', () => {
		expect(new Set([MAINNET_USDCX_UNIT, MAINNET_USDM_UNIT, PREPROD_USDM_UNIT]).size).toBe(3);
	});
});
