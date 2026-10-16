import { describe, expect, it } from '@jest/globals';
import { resolveCreateUsageLimited } from './usage-limited';

describe('resolveCreateUsageLimited', () => {
	it('accepts an admin create that omits usageLimited', () => {
		// The documented admin create call sends no usageLimited at all. While the
		// schema defaulted the field to true, this call was rejected with
		// 400 'Admin API keys cannot have usage limits'.
		expect(resolveCreateUsageLimited({ isAdmin: true, requested: undefined })).toBe(false);
	});

	it('accepts an admin create that explicitly disables usage limits', () => {
		expect(resolveCreateUsageLimited({ isAdmin: true, requested: false })).toBe(false);
	});

	it('rejects an admin create that explicitly enables usage limits', () => {
		expect(() => resolveCreateUsageLimited({ isAdmin: true, requested: true })).toThrow(
			'Admin API keys cannot have usage limits',
		);
	});

	it('keeps a non-admin key usage limited when the field is omitted', () => {
		// The default moved from the schema to here, so omitting the field must still
		// produce a capped key for everyone who is not an admin.
		expect(resolveCreateUsageLimited({ isAdmin: false, requested: undefined })).toBe(true);
	});

	it('honours an explicit non-admin value in both directions', () => {
		expect(resolveCreateUsageLimited({ isAdmin: false, requested: false })).toBe(false);
		expect(resolveCreateUsageLimited({ isAdmin: false, requested: true })).toBe(true);
	});
});
