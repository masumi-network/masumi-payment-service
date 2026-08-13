import { describe, expect, it } from '@jest/globals';
import { consolidateUsageCredits, normalizeCreditUnit } from './credit-units';

describe('normalizeCreditUnit', () => {
	it('lowercases a checksummed EVM chain-qualified unit', () => {
		// The form explorers and wallets put on the clipboard. The x402 debit looks
		// the unit up lowercased, so stored-verbatim checksummed rows could never
		// match and the key would 402 forever despite funded credits.
		expect(normalizeCreditUnit('eip155:8453:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(
			'eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
		);
	});

	it('leaves an already-lowercase EVM unit unchanged', () => {
		expect(normalizeCreditUnit('eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')).toBe(
			'eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
		);
	});

	it('leaves Cardano units verbatim', () => {
		// Cardano asset-name hex is case-significant; only EVM-shaped units are safe
		// to normalize.
		expect(normalizeCreditUnit('lovelace')).toBe('lovelace');
		const cardanoUnit = '16a55b2a349361ff88c0AbCd' + 'ef'.repeat(10);
		expect(normalizeCreditUnit(cardanoUnit)).toBe(cardanoUnit);
	});

	it('leaves non-matching strings verbatim', () => {
		expect(normalizeCreditUnit('eip155:8453')).toBe('eip155:8453');
		expect(normalizeCreditUnit('EIP155:8453:0x' + 'a'.repeat(40))).toBe('EIP155:8453:0x' + 'a'.repeat(40));
	});
});

describe('consolidateUsageCredits', () => {
	it('merges duplicate units by summing their amounts', () => {
		// Nothing enforces one row per (apiKeyId, unit); duplicates read as a lower
		// balance to any consumer resolving a single row, so they are collapsed
		// before they are ever created.
		expect(
			consolidateUsageCredits([
				{ unit: 'eip155:8453:0x' + 'a'.repeat(40), amount: 40n },
				{ unit: 'eip155:8453:0x' + 'a'.repeat(40), amount: 60n },
			]),
		).toEqual([{ unit: 'eip155:8453:0x' + 'a'.repeat(40), amount: 100n }]);
	});

	it('merges entries that only differ by address case', () => {
		expect(
			consolidateUsageCredits([
				{ unit: 'eip155:8453:0x' + 'AB'.repeat(20), amount: 1n },
				{ unit: 'eip155:8453:0x' + 'ab'.repeat(20), amount: 2n },
			]),
		).toEqual([{ unit: 'eip155:8453:0x' + 'ab'.repeat(20), amount: 3n }]);
	});

	it('preserves distinct units and first-seen order', () => {
		expect(
			consolidateUsageCredits([
				{ unit: 'lovelace', amount: 5n },
				{ unit: 'eip155:8453:0x' + 'a'.repeat(40), amount: 7n },
			]),
		).toEqual([
			{ unit: 'lovelace', amount: 5n },
			{ unit: 'eip155:8453:0x' + 'a'.repeat(40), amount: 7n },
		]);
	});

	it('keeps an explicit zero grant visible', () => {
		expect(consolidateUsageCredits([{ unit: 'lovelace', amount: 0n }])).toEqual([{ unit: 'lovelace', amount: 0n }]);
	});

	it('throws on a negative amount', () => {
		expect(() => consolidateUsageCredits([{ unit: 'lovelace', amount: -1n }])).toThrow('Invalid amount');
	});
});
