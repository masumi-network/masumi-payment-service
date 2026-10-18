import { describe, expect, it } from '@jest/globals';
import { nonceLogRef } from './nonce-log-ref.js';

describe('nonceLogRef', () => {
	// Same vector as the payment service's helper: lines from both sides must correlate.
	it('matches the payment service digest format', () => {
		expect(nonceLogRef('nonce123456')).toBe('sha256:575140b1803e');
	});
});
