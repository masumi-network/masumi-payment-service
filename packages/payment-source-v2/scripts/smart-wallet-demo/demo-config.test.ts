import { afterEach, describe, expect, it } from '@jest/globals';
import { walletPeriodLimitLovelace } from './demo-config';

const LIMIT_ENV = 'SMART_WALLET_DEMO_PERIOD_LIMIT_LOVELACE';
const originalLimit = process.env[LIMIT_ENV];

afterEach(() => {
	if (originalLimit === undefined) delete process.env[LIMIT_ENV];
	else process.env[LIMIT_ENV] = originalLimit;
});

describe('operator period limit at mint', () => {
	it.each([undefined, '', '  '])('requires an explicit limit: %s', (value) => {
		if (value === undefined) delete process.env[LIMIT_ENV];
		else process.env[LIMIT_ENV] = value;
		expect(() => walletPeriodLimitLovelace()).toThrow(`${LIMIT_ENV} is required`);
	});

	it.each(['0', '-1', '1.5', '1e6', 'NaN', 'Infinity', '0x100', '100 ADA'])('rejects invalid limit: %s', (value) => {
		process.env[LIMIT_ENV] = value;
		expect(() => walletPeriodLimitLovelace()).toThrow(`${LIMIT_ENV} must be a positive lovelace integer`);
	});

	it.each(['1', '123456789', '9007199254740993'])('preserves the operator amount exactly: %s', (value) => {
		process.env[LIMIT_ENV] = value;
		expect(walletPeriodLimitLovelace()).toBe(BigInt(value));
	});
});
