import { describe, expect, it } from '@jest/globals';
import { parseRetentionDaysEnv } from './config';

describe('parseRetentionDaysEnv', () => {
	it('defaults to 30 days when unset or blank', () => {
		expect(parseRetentionDaysEnv('X', undefined)).toBe(30);
		expect(parseRetentionDaysEnv('X', '')).toBe(30);
		expect(parseRetentionDaysEnv('X', '  ')).toBe(30);
	});

	it('keeps all history for 0', () => {
		expect(parseRetentionDaysEnv('X', '0')).toBeNull();
	});

	it('accepts whole days from 1 up', () => {
		expect(parseRetentionDaysEnv('X', '1')).toBe(1);
		expect(parseRetentionDaysEnv('X', ' 90 ')).toBe(90);
		expect(parseRetentionDaysEnv('X', '00')).toBeNull();
	});

	it('rejects typos and values that cannot become a cutoff date', () => {
		// 1e-324 and the long decimal round to 0 and 1 inside Number().
		for (const value of ['0.5', '1.5', '-1', '30d', '1e12', '1e-324', '0.99999999999999999']) {
			expect(() => parseRetentionDaysEnv('X', value)).toThrow('X must be a whole number of days (0 keeps all history)');
		}
		expect(() => parseRetentionDaysEnv('X', '10000000')).toThrow('X must be at most 36500; use 0 to keep all history');
	});
});
