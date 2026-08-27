import { describe, expect, it } from '@jest/globals';
import {
	MAINNET_USDCX_UNIT,
	MAINNET_USDM_UNIT,
	PREPROD_USDM_UNIT,
	atomicToDecimalString,
	getReportAssetMetadata,
	normalizeAssetUnit,
	serializeReportAmount,
} from './asset-units';

describe('normalizeAssetUnit', () => {
	it.each(['', 'lovelace', 'LOVELACE'])("normalizes '%s' to lovelace", (unit) => {
		expect(normalizeAssetUnit(unit)).toBe('lovelace');
	});

	it('preserves native asset units', () => {
		expect(normalizeAssetUnit(MAINNET_USDM_UNIT)).toBe(MAINNET_USDM_UNIT);
	});
});

describe('atomicToDecimalString', () => {
	it.each([
		[0n, '0.000000'],
		[1n, '0.000001'],
		[1_000_000n, '1.000000'],
		[1_234_567n, '1.234567'],
		[-1_234_567n, '-1.234567'],
	])('formats %s with six decimals', (amount, expected) => {
		expect(atomicToDecimalString(amount, 6)).toBe(expected);
	});

	it('rejects a negative decimal count', () => {
		expect(() => atomicToDecimalString(1n, -1)).toThrow('decimals must be a non-negative integer');
	});
});

describe('getReportAssetMetadata', () => {
	it.each([
		['lovelace', 'ada', 'ADA'],
		[MAINNET_USDM_UNIT, 'usdm', 'USDM'],
		[PREPROD_USDM_UNIT, 'usdm', 'USDM'],
		[MAINNET_USDCX_UNIT, 'usdcx', 'USDCx'],
	])('recognizes %s', (unit, key, symbol) => {
		expect(getReportAssetMetadata(unit)).toEqual({
			key,
			symbol,
			decimals: 6,
		});
	});

	it('returns null for another native asset', () => {
		expect(getReportAssetMetadata('policyasset')).toBeNull();
	});
});

describe('serializeReportAmount', () => {
	it('returns raw and decimal values for a known report asset', () => {
		expect(serializeReportAmount({ unit: 'lovelace', amount: 1_500_000n })).toEqual({
			unit: 'lovelace',
			rawAmount: '1500000',
			decimalAmount: '1.500000',
			decimals: 6,
			symbol: 'ADA',
		});
	});

	it('keeps only the atomic value for another native asset', () => {
		expect(serializeReportAmount({ unit: 'policyasset', amount: 42n })).toEqual({
			unit: 'policyasset',
			rawAmount: '42',
			decimalAmount: null,
			decimals: null,
			symbol: null,
		});
	});
});
