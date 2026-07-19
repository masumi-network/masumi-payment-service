import { jest } from '@jest/globals';
import { runSubmitResultSubmissionLifecycle } from './submit-result-lifecycle';

function createOptions() {
	return {
		submit: jest.fn<() => Promise<string>>(),
		requeueRejected: jest.fn<(error: unknown) => Promise<void>>(async () => undefined),
		evaluateProjectedBalance: jest.fn<() => Promise<void>>(async () => undefined),
		recordSubmitted: jest.fn<(txHash: string) => Promise<void>>(async () => undefined),
		onBalanceCheckFailure: jest.fn<(error: unknown, txHash: string) => void>(),
		onRecordFailure: jest.fn<(error: unknown, txHash: string) => void>(),
	};
}

describe('submit-result submission lifecycle', () => {
	it('requeues a rejected submission without recording a pending transaction', async () => {
		const options = createOptions();
		const submitError = new Error('node rejected transaction');
		options.submit.mockRejectedValue(submitError);

		await expect(runSubmitResultSubmissionLifecycle(options)).resolves.toEqual({
			status: 'rejected',
			error: submitError,
		});
		expect(options.requeueRejected).toHaveBeenCalledWith(submitError);
		expect(options.evaluateProjectedBalance).not.toHaveBeenCalled();
		expect(options.recordSubmitted).not.toHaveBeenCalled();
	});

	it('records an accepted transaction even when projected-balance monitoring fails', async () => {
		const options = createOptions();
		const balanceError = new Error('monitoring failed');
		options.submit.mockResolvedValue('submitted-hash');
		options.evaluateProjectedBalance.mockRejectedValue(balanceError);

		await expect(runSubmitResultSubmissionLifecycle(options)).resolves.toEqual({
			status: 'submitted',
			txHash: 'submitted-hash',
			isRecorded: true,
		});
		expect(options.onBalanceCheckFailure).toHaveBeenCalledWith(balanceError, 'submitted-hash');
		expect(options.recordSubmitted).toHaveBeenCalledWith('submitted-hash');
		expect(options.requeueRejected).not.toHaveBeenCalled();
	});

	it('does not throw or resubmit after post-submit recording fails', async () => {
		const options = createOptions();
		const recordError = new Error('database unavailable');
		options.submit.mockResolvedValue('submitted-hash');
		options.recordSubmitted.mockRejectedValue(recordError);

		await expect(runSubmitResultSubmissionLifecycle(options)).resolves.toEqual({
			status: 'submitted',
			txHash: 'submitted-hash',
			isRecorded: false,
		});
		expect(options.submit).toHaveBeenCalledTimes(1);
		expect(options.onRecordFailure).toHaveBeenCalledWith(recordError, 'submitted-hash');
	});
});
