import { describe, expect, it } from '@jest/globals';
import {
	L1_CONSOLIDATION_RESERVE_LOVELACE,
	MAX_L1_CONSOLIDATION_ASSETS,
	MAX_L1_CONSOLIDATION_UTXOS,
	planL1Consolidation,
} from './consolidate';

const USDM = `${'c'.repeat(56)}0014df105553444d`;

describe('planL1Consolidation', () => {
	it('sends the whole balance less the reserve, with every token', () => {
		const result = planL1Consolidation([
			{ amount: [{ unit: 'lovelace', quantity: '10000000' }] },
			{
				amount: [
					{ unit: 'lovelace', quantity: '1500000' },
					{ unit: USDM, quantity: '4000000' },
				],
			},
			{
				amount: [
					{ unit: 'lovelace', quantity: '1500000' },
					{ unit: USDM, quantity: '1000000' },
				],
			},
		]);

		expect(result).toEqual({
			lovelaceAmount: 13_000_000n - L1_CONSOLIDATION_RESERVE_LOVELACE,
			assets: [{ unit: USDM, quantity: '5000000' }],
		});
	});

	it('returns null for a single UTxO', () => {
		expect(planL1Consolidation([{ amount: [{ unit: 'lovelace', quantity: '90000000' }] }])).toBeNull();
	});

	// The transfer pipeline refuses less than 2 ADA, and the reserve takes 2 more.
	it('returns null when the ADA cannot pay for merging', () => {
		expect(
			planL1Consolidation([
				{ amount: [{ unit: 'lovelace', quantity: '1900000' }] },
				{ amount: [{ unit: 'lovelace', quantity: '2000000' }] },
			]),
		).toBeNull();
	});

	it('treats an empty unit as lovelace', () => {
		const result = planL1Consolidation([
			{ amount: [{ unit: '', quantity: '3000000' }] },
			{ amount: [{ unit: 'lovelace', quantity: '3000000' }] },
		]);

		expect(result).toEqual({ lovelaceAmount: 4_000_000n, assets: [] });
	});

	// Past these the transfer would fail only inside the scheduler.
	it('refuses more UTxOs than one transaction can spend', () => {
		const utxos = Array.from({ length: MAX_L1_CONSOLIDATION_UTXOS + 1 }, () => ({
			amount: [{ unit: 'lovelace', quantity: '2000000' }],
		}));
		expect(() => planL1Consolidation(utxos)).toThrow(/at most/);
	});

	it('refuses more assets than one output can carry', () => {
		const utxos = Array.from({ length: MAX_L1_CONSOLIDATION_ASSETS + 1 }, (_, index) => ({
			amount: [
				{ unit: 'lovelace', quantity: '2000000' },
				{ unit: `${index.toString(16).padStart(56, '0')}01`, quantity: '1' },
			],
		}));
		expect(() => planL1Consolidation(utxos)).toThrow(/distinct assets/);
	});
});
