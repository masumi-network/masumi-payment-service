import { jest } from '@jest/globals';

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { nextRetryDelayMs, errorToText, MAX_QUARANTINE_ATTEMPTS } = await import('./index');

describe('nextRetryDelayMs', () => {
	it('starts short so the common case — a transient blockfrost failure — clears fast', () => {
		expect(nextRetryDelayMs(0)).toBe(30_000);
	});

	it('backs off as attempts accumulate', () => {
		expect(nextRetryDelayMs(1)).toBeGreaterThan(nextRetryDelayMs(0));
		expect(nextRetryDelayMs(2)).toBeGreaterThan(nextRetryDelayMs(1));
		expect(nextRetryDelayMs(3)).toBeGreaterThan(nextRetryDelayMs(2));
	});

	it('caps the delay rather than growing without bound', () => {
		expect(nextRetryDelayMs(50)).toBe(nextRetryDelayMs(MAX_QUARANTINE_ATTEMPTS));
		expect(nextRetryDelayMs(50)).toBe(60 * 60 * 1000);
	});

	it('is defensive about out-of-range attempt counts', () => {
		expect(nextRetryDelayMs(-1)).toBe(30_000);
	});
});

describe('errorToText', () => {
	it('includes the error name and message', () => {
		expect(errorToText(new TypeError('bad datum'))).toBe('TypeError: bad datum');
	});

	it('passes strings through', () => {
		expect(errorToText('timeout')).toBe('timeout');
	});

	it('serialises plain objects', () => {
		expect(errorToText({ status: 429 })).toBe('{"status":429}');
	});

	it('does not throw on circular structures', () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;

		expect(() => errorToText(circular)).not.toThrow();
	});
});
