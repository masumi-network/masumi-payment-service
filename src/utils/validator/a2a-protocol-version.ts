import { z } from '@masumi/payment-core/zod';

export const A2A_PROTOCOL_VERSION_MAX_BYTES = 64;

// ASCII Major.Minor keeps character and metadata byte lengths identical.
export const a2aProtocolVersionSchema = z
	.string()
	.max(A2A_PROTOCOL_VERSION_MAX_BYTES)
	.regex(/^[0-9]+\.[0-9]+$/, 'A2A protocol version must use Major.Minor');
