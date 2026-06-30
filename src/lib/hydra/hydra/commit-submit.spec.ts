import { describe, it, expect } from '@jest/globals';
import { interpretCardanoTxSubmitResult } from './commit-submit';

describe('interpretCardanoTxSubmitResult', () => {
	it('returns ok for a TransactionSubmitted reply', () => {
		const result = interpretCardanoTxSubmitResult({ tag: 'TransactionSubmitted' });
		expect(result).toEqual({ ok: true });
	});

	it('returns not-ok with the failureReason for a FailedToPostTx reply', () => {
		const result = interpretCardanoTxSubmitResult({
			tag: 'FailedToPostTx',
			failureReason: 'NotEnoughFuel',
			failingTx: { cborHex: 'deadbeef' },
		});
		expect(result).toEqual({ ok: false, reason: 'NotEnoughFuel' });
	});

	it('stringifies a non-string failureReason', () => {
		const result = interpretCardanoTxSubmitResult({
			tag: 'FailedToPostTx',
			failureReason: { code: 42, detail: 'OutsideValidityInterval' },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain('OutsideValidityInterval');
		}
	});

	it('falls back to the serialized object when a failing tag carries no failureReason', () => {
		const result = interpretCardanoTxSubmitResult({ tag: 'SomeOtherFailure', detail: 'x' });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain('SomeOtherFailure');
		}
	});

	it('treats any non-success tag as a failure', () => {
		const result = interpretCardanoTxSubmitResult({ tag: 'CommandFailed' });
		expect(result.ok).toBe(false);
	});

	// The node contract guarantees a tagged object; the branches below are
	// defensive and preserve the original handler behaviour (no throw → ok).
	it('treats a tagless object as ok (defensive)', () => {
		expect(interpretCardanoTxSubmitResult({ someField: 1 })).toEqual({ ok: true });
	});

	it('treats null as ok (defensive)', () => {
		expect(interpretCardanoTxSubmitResult(null)).toEqual({ ok: true });
	});

	it('treats a string reply as ok (defensive)', () => {
		expect(interpretCardanoTxSubmitResult('TransactionSubmitted')).toEqual({ ok: true });
	});

	it('treats undefined as ok (defensive)', () => {
		expect(interpretCardanoTxSubmitResult(undefined)).toEqual({ ok: true });
	});
});
