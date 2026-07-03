import { isTransientPreSubmitError } from './pre-submit-error';

describe('isTransientPreSubmitError', () => {
	it.each([
		'cost model sync failed: 503 Service Unavailable',
		'Blockfrost request timeout',
		'connect ETIMEDOUT 1.2.3.4:443',
		'read ECONNRESET',
		'getaddrinfo ENOTFOUND cardano-preprod.blockfrost.io',
		'socket hang up',
		'fetch failed',
		'502 Bad Gateway',
		'504 Gateway Timeout',
	])('classifies transient build/sign error as retryable: %s', (message) => {
		expect(isTransientPreSubmitError(new Error(message))).toBe(true);
	});

	it.each([
		'UTxO Balance Insufficient',
		'ValueNotConservedUTxO',
		'PPViewHashesDontMatch',
		'invalid datum',
		'some unexpected serialization bug',
		// Status-code digits inside larger numbers (amounts, tx sizes) must NOT
		// match — '15034567' contains '503' but is an amount, not an HTTP status.
		'insufficient balance: needed 15034567 lovelace but wallet holds 5020000',
		'tx size 45042 exceeds limit',
	])('leaves non-transient errors for manual action: %s', (message) => {
		expect(isTransientPreSubmitError(new Error(message))).toBe(false);
	});

	it('handles non-Error values without throwing', () => {
		expect(isTransientPreSubmitError('socket hang up')).toBe(true);
		expect(isTransientPreSubmitError(null)).toBe(false);
		expect(isTransientPreSubmitError(undefined)).toBe(false);
	});
});
