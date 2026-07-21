import { isInsufficientBalanceBuildError } from './index';

describe('isInsufficientBalanceBuildError', () => {
	it.each([
		'UTxO Balance Insufficient',
		'InputSelectionError: not enough funds',
		'utxo fully depleted',
		'Insufficient balance for the transaction',
		'Not enough ADA to cover the outputs',
		'not enough lovelace left for change',
	])('matches the mesh coin-selection failure %p', (message) => {
		expect(isInsufficientBalanceBuildError(new Error(message))).toBe(true);
	});

	// Must stay narrow — retrying these would mask the real failure.
	it.each([
		'PPViewHashesDontMatch',
		'extraRedeemers',
		'Collateral UTxO not found with at least 5000000 lovelace',
		'Transaction hash not found',
		'ValueNotConserved',
		'BadInputsUTxO',
	])('does not match the unrelated failure %p', (message) => {
		expect(isInsufficientBalanceBuildError(new Error(message))).toBe(false);
	});

	it('handles non-Error values without throwing', () => {
		expect(isInsufficientBalanceBuildError('utxo fully depleted')).toBe(true);
		expect(isInsufficientBalanceBuildError(undefined)).toBe(false);
		expect(isInsufficientBalanceBuildError(null)).toBe(false);
	});
});
