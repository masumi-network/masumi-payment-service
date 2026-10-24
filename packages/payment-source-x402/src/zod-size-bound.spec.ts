import { createRequire } from 'node:module';
import { describe, expect, it } from '@jest/globals';
import { ResourceInfoSchema } from '@x402/core/schemas';

const localRequire = createRequire(import.meta.url);
const x402Require = createRequire(localRequire.resolve('@x402/core'));
const zod3 = x402Require('zod') as typeof import('zod/v3');

describe('Zod 3 collection bounds', () => {
	it('rejects oversized x402 resource tags with one bound issue', () => {
		const result = ResourceInfoSchema.safeParse({
			url: 'https://example.com/resource',
			tags: Array.from({ length: 6 }, () => ''),
		});
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.issues.map(({ code }) => code)).toEqual(['too_big']);
	});

	it('rejects oversized arrays before parsing elements', () => {
		let parsedElements = 0;
		const element = zod3.string().refine(() => {
			parsedElements += 1;
			return false;
		});

		for (const schema of [zod3.array(element).max(1), zod3.array(element).length(1)]) {
			const result = schema.safeParse(['first', 'second']);
			expect(result.success).toBe(false);
			if (!result.success) expect(result.error.issues.map(({ code }) => code)).toEqual(['too_big']);
		}
		expect(parsedElements).toBe(0);
	});

	it('rejects oversized sets before parsing elements', () => {
		let parsedElements = 0;
		const element = zod3.string().refine(() => {
			parsedElements += 1;
			return false;
		});
		const result = zod3
			.set(element)
			.max(1)
			.safeParse(new Set(['first', 'second']));

		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.issues.map(({ code }) => code)).toEqual(['too_big']);
		expect(parsedElements).toBe(0);
	});

	it('rejects oversized arrays before starting asynchronous refinements', async () => {
		let parsedElements = 0;
		const element = zod3.string().refine(async () => {
			parsedElements += 1;
			return false;
		});
		const result = await zod3.array(element).max(1).safeParseAsync(['first', 'second']);

		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.issues.map(({ code }) => code)).toEqual(['too_big']);
		expect(parsedElements).toBe(0);
	});
});
