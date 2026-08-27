/**
 * The two deposit milestones, and the amount shape a withdrawal must have.
 *
 * Both are small pieces of arithmetic and validation that decide what an
 * operator is told about their own money, and both have shipped wrong before:
 * the milestones were once derived from the transaction's validity TTL and
 * reported healthy deposits as expired, and the withdrawal amount fields are
 * the difference between "take 5 of this token" and "empty my side of the
 * head".
 */

import { describe, expect, it } from '@jest/globals';
import { shiftPeriods } from './topup';
import { assertWithdrawAmountShape } from './withdraw';

const DEPOSIT_PERIOD_SECONDS = 600;
const DEADLINE = new Date('2026-08-17T12:00:00.000Z');

describe('shiftPeriods', () => {
	// The node writes the deadline as `deposit + 3·DP` and will not take the
	// deposit before `deposit + DP` — two periods before the deadline.
	it('puts the usable-from milestone two deposit periods before the deadline', () => {
		expect(shiftPeriods(DEADLINE, -2, DEPOSIT_PERIOD_SECONDS)).toBe('2026-08-17T11:40:00.000Z');
	});

	// And refuses a deposit with less than a period left, closing the window a
	// period before the deadline rather than at it.
	it('puts the absorb-by milestone one deposit period before the deadline', () => {
		expect(shiftPeriods(DEADLINE, -1, DEPOSIT_PERIOD_SECONDS)).toBe('2026-08-17T11:50:00.000Z');
	});

	// A head opened from an invite carries its own period, so the milestones move
	// with it rather than with the service default.
	it("scales with the head's own deposit period", () => {
		expect(shiftPeriods(DEADLINE, -2, 1200)).toBe('2026-08-17T11:20:00.000Z');
	});

	// Null until the head has stated the deadline. Substituting any other time —
	// the deposit's, the operator's — is what made healthy deposits look expired.
	it('reports no milestone while the head has stated no deadline', () => {
		expect(shiftPeriods(null, -2, DEPOSIT_PERIOD_SECONDS)).toBeNull();
	});
});

describe('assertWithdrawAmountShape', () => {
	it('accepts an exact lovelace amount', () => {
		expect(() => assertWithdrawAmountShape({ lovelace: '5000000' })).not.toThrow();
	});

	it('accepts an asset with its amount', () => {
		expect(() => assertWithdrawAmountShape({ assetUnit: 'aa'.repeat(28), assetAmount: '5' })).not.toThrow();
	});

	// The whole-UTxO withdrawal: no amount at all.
	it('accepts a request with no amount', () => {
		expect(() => assertWithdrawAmountShape({})).not.toThrow();
	});

	// The dangerous one. Without the amount the asset is dropped and the request
	// means "take everything eligible, whole".
	it('refuses an asset with no amount', () => {
		expect(() => assertWithdrawAmountShape({ assetUnit: 'aa'.repeat(28) })).toThrow(/go together/);
	});

	it('refuses an amount with no asset', () => {
		expect(() => assertWithdrawAmountShape({ assetAmount: '5' })).toThrow(/go together/);
	});

	// One withdrawal carries one thing: a decommit of both would be two
	// different removals described as one.
	it('refuses lovelace and an asset in the same request', () => {
		expect(() =>
			assertWithdrawAmountShape({ lovelace: '5000000', assetUnit: 'aa'.repeat(28), assetAmount: '5' }),
		).toThrow(/either lovelace or one native asset/);
	});
});
