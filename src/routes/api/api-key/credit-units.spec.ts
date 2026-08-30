import { describe, expect, it } from '@jest/globals';
import { consolidateUsageCredits, findNonCanonicalEvmCreditUnit, normalizeCreditUnit } from './credit-units';

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

	it('leaves Cardano native-asset units verbatim', () => {
		// Cardano asset-name hex is case-significant, so only EVM-shaped units and the
		// ADA alias are safe to rewrite.
		const cardanoUnit = '16a55b2a349361ff88c0AbCd' + 'ef'.repeat(10);
		expect(normalizeCreditUnit(cardanoUnit)).toBe(cardanoUnit);
	});

	it('canonicalises the ADA alias to the empty unit', () => {
		// The purchase path presents ADA as '' (normalizePurchaseUnit maps 'lovelace' to
		// '' before the cost reaches the credit gate, which compares units verbatim), so a
		// row stored as 'lovelace' could never match an ADA purchase and the key failed
		// with `Credit unit not found:` for a balance that looked funded.
		expect(normalizeCreditUnit('lovelace')).toBe('');
		expect(normalizeCreditUnit('Lovelace')).toBe('');
		expect(normalizeCreditUnit('')).toBe('');
	});

	it('folds an existing lovelace row onto the canonical ADA unit', () => {
		// The update path matches rows on the normalized form and writes that form back,
		// so a stale row is repaired on the next top-up instead of lingering as dead
		// credit next to a working one.
		expect(
			consolidateUsageCredits([
				{ unit: 'lovelace', amount: 1_000_000n },
				{ unit: '', amount: 500_000n },
			]),
		).toEqual([{ unit: '', amount: 1_500_000n }]);
	});

	it('leaves non-matching strings verbatim', () => {
		// Normalization does not guess: near misses are REJECTED at the API boundary
		// by findNonCanonicalEvmCreditUnit rather than silently rewritten here.
		expect(normalizeCreditUnit('eip155:8453')).toBe('eip155:8453');
		expect(normalizeCreditUnit('EIP155:8453:0x' + 'a'.repeat(40))).toBe('EIP155:8453:0x' + 'a'.repeat(40));
	});
});

describe('findNonCanonicalEvmCreditUnit', () => {
	const canonical = 'eip155:8453:0x' + 'a'.repeat(40);

	it('accepts a canonical EVM unit', () => {
		expect(findNonCanonicalEvmCreditUnit([canonical])).toBeNull();
	});

	it('accepts Cardano units, which are not EVM-shaped at all', () => {
		expect(findNonCanonicalEvmCreditUnit(['lovelace', '16a55b2a349361ff88c0AbCd'])).toBeNull();
	});

	it.each([
		['uppercase namespace', 'EIP155:8453:0x' + 'a'.repeat(40)],
		['no asset', 'eip155:8453'],
		['non-hex asset', 'eip155:8453:native'],
		['short address', 'eip155:8453:0x' + 'a'.repeat(39)],
		['missing 0x', 'eip155:8453:' + 'a'.repeat(40)],
	])('rejects a near-miss EVM unit (%s)', (_label, unit) => {
		// These must FAIL CLOSED. Stored verbatim, none of them would ever match the
		// x402 debit lookup, and the key would then hold no rows the enforcement
		// probe recognizes — spending with no ceiling while the dashboard shows it
		// as funded and usage limited.
		expect(findNonCanonicalEvmCreditUnit([unit])).toBe(unit);
	});

	it('reports the first offender in a mixed list', () => {
		expect(findNonCanonicalEvmCreditUnit(['lovelace', 'eip155:8453:native', canonical])).toBe('eip155:8453:native');
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
		// ADA now lands on the canonical '' unit: 'lovelace' can never match an ADA
		// purchase, which the credit gate compares verbatim against the normalized cost.
		expect(
			consolidateUsageCredits([
				{ unit: 'lovelace', amount: 5n },
				{ unit: 'eip155:8453:0x' + 'a'.repeat(40), amount: 7n },
			]),
		).toEqual([
			{ unit: '', amount: 5n },
			{ unit: 'eip155:8453:0x' + 'a'.repeat(40), amount: 7n },
		]);
	});

	it('keeps an explicit zero grant visible', () => {
		expect(consolidateUsageCredits([{ unit: 'lovelace', amount: 0n }])).toEqual([{ unit: '', amount: 0n }]);
	});

	it('throws on a negative amount', () => {
		expect(() => consolidateUsageCredits([{ unit: 'lovelace', amount: -1n }])).toThrow('Invalid amount');
	});
});
