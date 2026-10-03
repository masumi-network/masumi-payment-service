import { describe, expect, it } from '@jest/globals';
import {
	consolidateUsageCredits,
	findNonCanonicalEvmCreditUnit,
	normalizeCreditUnit,
	planCreditDelta,
} from './credit-units';

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
		// Stored verbatim, none of these units would match the exact x402 debit lookup.
		// The dashboard would show credit while every matching payment returns 402.
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

describe('planCreditDelta', () => {
	it('spends a balance split across duplicate rows', () => {
		// The reported bug. 5 ADA + 3 ADA shows as 8, so lowering it to 1 sends -7.
		// Resolving the first row alone took 5 to -2 and 400'd the whole PATCH for an
		// edit the balance covers twice over.
		const plan = planCreditDelta(
			[
				{ id: 'a', unit: '', amount: 5_000_000n },
				{ id: 'b', unit: '', amount: 3_000_000n },
			],
			'',
			-7_000_000n,
		);
		expect(plan).toEqual({ updateId: 'a', deleteIds: ['b'], amount: 1_000_000n });
	});

	it('folds a checksummed row into the canonical one it duplicates', () => {
		// Both rows are the same ERC-20 to the debit path, which looks the unit up
		// lowercased. Removing the 3 the stale row holds used to land on whichever row
		// matched first, taking it off the live balance and leaving the stale row.
		const canonical = 'eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
		const plan = planCreditDelta(
			[
				{ id: 'live', unit: canonical, amount: 5_000_000n },
				{ id: 'stale', unit: 'eip155:8453:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: 3_000_000n },
			],
			canonical,
			-3_000_000n,
		);
		expect(plan).toEqual({ updateId: 'live', deleteIds: ['stale'], amount: 5_000_000n });
	});

	it('matches a checksummed EVM row from the canonical unit', () => {
		const plan = planCreditDelta(
			[{ id: 'a', unit: 'eip155:8453:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: 10n }],
			'eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
			5n,
		);
		expect(plan).toEqual({ updateId: 'a', deleteIds: [], amount: 15n });
	});

	it('keeps a row that the delta zeroes', () => {
		// A zeroed row is the record that the key is capped on that unit. Deleting it
		// would read as "never capped" and lose the unit the operator would retype.
		expect(planCreditDelta([{ id: 'a', unit: '', amount: 7n }], '', -7n)).toEqual({
			updateId: 'a',
			deleteIds: [],
			amount: 0n,
		});
	});

	it('consolidates duplicates even when the delta does not move the balance', () => {
		// Reached by topping one unit up and back down in the same submit. The rows
		// still need folding, otherwise the next edit hits the same split balance.
		expect(
			planCreditDelta(
				[
					{ id: 'a', unit: '', amount: 4n },
					{ id: 'b', unit: '', amount: 6n },
				],
				'',
				0n,
			),
		).toEqual({ updateId: 'a', deleteIds: ['b'], amount: 10n });
	});

	it('refuses an overdraw against the summed balance', () => {
		expect(
			planCreditDelta(
				[
					{ id: 'a', unit: '', amount: 5n },
					{ id: 'b', unit: '', amount: 3n },
				],
				'',
				-9n,
			),
		).toBeNull();
	});

	it('creates a row for a positive delta on an unfunded unit', () => {
		expect(planCreditDelta([{ id: 'a', unit: '', amount: 5n }], 'other', 12n)).toEqual({
			updateId: null,
			deleteIds: [],
			amount: 12n,
		});
	});

	it('refuses a non-positive delta on an unfunded unit', () => {
		// Nothing to remove from, and a zero grant is made through UsageCredits on
		// create, not through a no-op delta here.
		expect(planCreditDelta([], 'other', 0n)).toBeNull();
		expect(planCreditDelta([], 'other', -1n)).toBeNull();
	});

	it('leaves rows for other units alone', () => {
		const plan = planCreditDelta(
			[
				{ id: 'ada', unit: '', amount: 5n },
				{ id: 'usdm', unit: 'c48cbb', amount: 9n },
			],
			'',
			1n,
		);
		expect(plan).toEqual({ updateId: 'ada', deleteIds: [], amount: 6n });
	});

	it('folds a legacy lovelace row into the ADA row it duplicates', () => {
		// The dashboard shows one ADA balance, so an edit that lowers it to 1 sends -7
		// against the pair. Applying that to the ADA row alone took 5 to -2 and 400'd.
		expect(
			planCreditDelta(
				[
					{ id: 'row-a', unit: '', amount: 5n },
					{ id: 'row-b', unit: 'lovelace', amount: 3n },
				],
				'',
				-7n,
			),
		).toEqual({ updateId: 'row-a', deleteIds: ['row-b'], amount: 1n });
	});

	it('keeps the exact canonical EVM row when an alias also exists', () => {
		// x402 debits and refunds pin a row id, and the row they pin is the canonical
		// one. Folding onto the alias instead would retire the id they hold.
		const canonicalUnit = 'eip155:8453:0x' + 'ab'.repeat(20);
		const alias = 'eip155:8453:0x' + 'AB'.repeat(20);
		expect(
			planCreditDelta(
				[
					{ id: 'row-a', unit: alias, amount: 2n },
					{ id: 'row-b', unit: canonicalUnit, amount: 3n },
				],
				canonicalUnit,
				1n,
			),
		).toEqual({ updateId: 'row-b', deleteIds: ['row-a'], amount: 6n });
	});

	it('keeps one zero row when the aggregate is fully removed', () => {
		expect(
			planCreditDelta(
				[
					{ id: 'row-a', unit: '', amount: 5n },
					{ id: 'row-b', unit: 'lovelace', amount: 3n },
				],
				'',
				-8n,
			),
		).toEqual({ updateId: 'row-a', deleteIds: ['row-b'], amount: 0n });
	});

	it('canonicalizes a legacy alias with the zero delta used when enabling the cap', () => {
		// Turning the cap on seeds a zero delta per stored unit, so the row is rewritten
		// under the unit the exact-match debit lookup uses.
		expect(planCreditDelta([{ id: 'row-a', unit: 'lovelace', amount: 1_000_000n }], '', 0n)).toEqual({
			updateId: 'row-a',
			deleteIds: [],
			amount: 1_000_000n,
		});
	});
});
