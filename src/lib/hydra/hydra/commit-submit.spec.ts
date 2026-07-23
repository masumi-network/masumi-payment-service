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
		const result = interpretCardanoTxSubmitResult({
			tag: 'SomeOtherFailure',
			detail: 'x',
			failingTransaction: { cborHex: 'a'.repeat(1_000) },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain('SomeOtherFailure');
			expect(result.reason).toContain('[redacted]');
			expect(result.reason).not.toContain('a'.repeat(128));
		}
	});

	it('bounds and redacts long failure strings', () => {
		const result = interpretCardanoTxSubmitResult({ failureReason: `prefix-${'a'.repeat(1_000)}-suffix` });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason.length).toBeLessThanOrEqual(512);
			expect(result.reason).toContain('[redacted hex]');
		}
	});

	it('treats any non-success tag as a failure', () => {
		const result = interpretCardanoTxSubmitResult({ tag: 'CommandFailed' });
		expect(result.ok).toBe(false);
	});

	it('rejects a tagless object', () => {
		expect(interpretCardanoTxSubmitResult({ someField: 1 })).toEqual({ ok: false, reason: '{"someField":1}' });
	});

	it('rejects null', () => {
		expect(interpretCardanoTxSubmitResult(null)).toEqual({ ok: false, reason: 'null' });
	});

	it('rejects a string reply without the success tag object', () => {
		expect(interpretCardanoTxSubmitResult('TransactionSubmitted')).toEqual({
			ok: false,
			reason: 'TransactionSubmitted',
		});
	});

	it('rejects undefined', () => {
		expect(interpretCardanoTxSubmitResult(undefined)).toEqual({ ok: false, reason: 'undefined' });
	});
});
