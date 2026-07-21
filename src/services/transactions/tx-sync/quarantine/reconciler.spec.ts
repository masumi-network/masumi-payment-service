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

const { classifyQuarantineError } = await import('./reconciler');

describe('classifyQuarantineError', () => {
	// 404 is deliberately NOT terminal on its own: Blockfrost returns it both
	// for a tx it has not indexed yet and for one that was rolled back. Only a
	// live chain lookup can tell those apart, so this returns 'not-found' and
	// leaves the decision to the caller.
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
});
