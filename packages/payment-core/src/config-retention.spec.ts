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

	it('accepts whole and fractional days from 1 up', () => {
		expect(parseRetentionDaysEnv('X', '1')).toBe(1);
		expect(parseRetentionDaysEnv('X', '90')).toBe(90);
		expect(parseRetentionDaysEnv('X', '1.5')).toBe(1.5);
	});

	it('rejects values that could delete rows inside the rollback window, or typos', () => {
		expect(() => parseRetentionDaysEnv('X', '0.5')).toThrow('X must be 0 (keep all history) or at least 1');
		expect(() => parseRetentionDaysEnv('X', '-1')).toThrow('X must be at least 0');
		expect(() => parseRetentionDaysEnv('X', '30d')).toThrow('X must be a valid number');
	});
});
