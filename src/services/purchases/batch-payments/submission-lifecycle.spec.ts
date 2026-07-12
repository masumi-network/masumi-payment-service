import { jest } from '@jest/globals';
import { runBatchSubmissionLifecycle, type BuiltBatchTransaction } from './submission-lifecycle';

const builtTransaction: BuiltBatchTransaction = {
	completeTx: 'complete-tx',
	signedTx: 'signed-tx',
	resolvedTxHash: 'resolved-hash',
	invalidHereafterSlot: 12345,
};

describe('batch submission lifecycle', () => {
	it('persists the signed identity and expiry before submitting exactly once', async () => {
		const calls: string[] = [];
		const submit = jest.fn(async () => {
			calls.push('submit');
			return builtTransaction.resolvedTxHash;
		});

		await expect(
			runBatchSubmissionLifecycle({
				buildAndSign: async () => {
					calls.push('build-and-sign');
					return builtTransaction;
				},
				persistBeforeSubmit: async (transaction) => {
					calls.push(`persist:${transaction.resolvedTxHash}:${transaction.invalidHereafterSlot}`);
				},
				submit,
			}),
		).resolves.toMatchObject({ status: 'submitted', submittedTxHash: 'resolved-hash' });

		expect(calls).toEqual(['build-and-sign', 'persist:resolved-hash:12345', 'submit']);
		expect(submit).toHaveBeenCalledTimes(1);
	});

	it('never submits when pre-submit persistence fails', async () => {
		const persistenceError = new Error('database unavailable');
		const submit = jest.fn(async () => builtTransaction.resolvedTxHash);

		await expect(
			runBatchSubmissionLifecycle({
				buildAndSign: async () => builtTransaction,
				persistBeforeSubmit: async () => {
					throw persistenceError;
				},
				submit,
			}),
		).rejects.toBe(persistenceError);
		expect(submit).not.toHaveBeenCalled();
	});

	it('returns an ambiguous outcome without resubmitting after a submit crash', async () => {
		const submitError = new Error('connection reset after node acceptance');
		const submit = jest.fn(async () => {
			throw submitError;
		});

		await expect(
			runBatchSubmissionLifecycle({
				buildAndSign: async () => builtTransaction,
				persistBeforeSubmit: async () => undefined,
				submit,
			}),
		).resolves.toMatchObject({
			status: 'ambiguous',
			resolvedTxHash: builtTransaction.resolvedTxHash,
			error: submitError,
		});
		expect(submit).toHaveBeenCalledTimes(1);
	});

	it('returns divergence instead of accepting a node hash mismatch', async () => {
		await expect(
			runBatchSubmissionLifecycle({
				buildAndSign: async () => builtTransaction,
				persistBeforeSubmit: async () => undefined,
				submit: async () => 'different-node-hash',
			}),
		).resolves.toMatchObject({
			status: 'divergent',
			resolvedTxHash: 'resolved-hash',
			submittedTxHash: 'different-node-hash',
		});
	});
});
