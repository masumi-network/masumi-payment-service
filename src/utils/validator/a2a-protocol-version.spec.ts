import { describe, expect, it } from '@jest/globals';
import { a2aProtocolVersionSchema, A2A_PROTOCOL_VERSION_MAX_BYTES } from './a2a-protocol-version';

describe('A2A protocol version metadata', () => {
	it.each(['0.3', '1.0', '12.34'])('accepts Major.Minor %s', (version) => {
		expect(a2aProtocolVersionSchema.safeParse(version).success).toBe(true);
	});
	it('accepts exactly the metadata byte ceiling', () => {
		const version = `${'1'.repeat(A2A_PROTOCOL_VERSION_MAX_BYTES - 2)}.0`;
		expect(Buffer.byteLength(version)).toBe(A2A_PROTOCOL_VERSION_MAX_BYTES);
		expect(a2aProtocolVersionSchema.safeParse(version).success).toBe(true);
	});
	it('rejects one byte beyond the metadata ceiling', () => {
		expect(a2aProtocolVersionSchema.safeParse(`${'1'.repeat(A2A_PROTOCOL_VERSION_MAX_BYTES - 1)}.0`).success).toBe(
			false,
		);
	});
});
