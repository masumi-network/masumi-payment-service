import { jest } from '@jest/globals';

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('@/services/shared', () => ({
	createApiClient: jest.fn(),
	withJobLock: jest.fn(),
}));

jest.unstable_mockModule('../service', () => ({
	processTransactionData: jest.fn(),
}));

jest.unstable_mockModule('../blockchain', () => ({
	getExtendedTxInformation: jest.fn(),
}));

const { classifyQuarantineError, isBlockingQuarantineOutcome } = await import('./reconciler');

describe('classifyQuarantineError', () => {
	// 404 is deliberately NOT terminal on its own: Blockfrost returns it both
	// for indexing lag and rollback absence. Same-provider retries cannot prove
	// which one happened, so the reconciler backs off and eventually escalates.
	it.each(['Request failed with status code 404', 'Not Found', 'ERR: 404 not found'])(
		'classifies %p as not-found rather than terminal',
		(message) => {
			expect(classifyQuarantineError(new Error(message))).toBe('not-found');
		},
	);

	it.each([
		'Request failed with status code 429',
		'Too Many Requests',
		'ETIMEDOUT',
		'socket hang up',
		'ECONNRESET',
		'Request failed with status code 502',
		'Request failed with status code 503',
	])('classifies %p as transient', (message) => {
		expect(classifyQuarantineError(new Error(message))).toBe('transient');
	});

	// Deterministic failures must escalate rather than retry forever — retrying
	// a parse bug thousands of times buries the signal it should be raising.
	it.each([
		'Invalid datum',
		'Cannot read properties of undefined',
		'deserializeDatum threw',
		'Unsupported V2 redeemer action',
	])('classifies %p as terminal', (message) => {
		expect(classifyQuarantineError(new Error(message))).toBe('terminal');
	});

	it('handles non-Error values without throwing', () => {
		expect(classifyQuarantineError('timeout')).toBe('transient');
		expect(classifyQuarantineError(undefined)).toBe('terminal');
		expect(classifyQuarantineError({ status: 429 })).toBe('transient');
	});

	it('uses Blockfrost structured status even when its message has no numeric code', () => {
		expect(
			classifyQuarantineError({
				status_code: 404,
				message: 'The requested component has not been found.',
			}),
		).toBe('not-found');
		expect(classifyQuarantineError({ status_code: 503, message: 'Service unavailable' })).toBe('transient');
	});

	it('does not let error text override a structured terminal status', () => {
		expect(classifyQuarantineError({ status_code: 400, message: 'header fragment 404' })).toBe('terminal');
	});
});

describe('ordered reconciliation', () => {
	it('blocks descendants after an unresolved outcome', () => {
		expect(isBlockingQuarantineOutcome('retry')).toBe(true);
		expect(isBlockingQuarantineOutcome('terminal')).toBe(true);
		expect(isBlockingQuarantineOutcome('resolved')).toBe(false);
	});
});
