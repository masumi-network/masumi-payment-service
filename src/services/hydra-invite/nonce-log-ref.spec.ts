import { describe, expect, it } from '@jest/globals';
import { nonceLogRef } from './nonce-log-ref';

describe('nonceLogRef', () => {
	it('is a stable truncated sha256 of the nonce, never the nonce itself', () => {
		expect(nonceLogRef('nonce123456')).toBe('sha256:575140b1803e');
		expect(nonceLogRef('nonce123456')).not.toContain('nonce123456');
	});
});
