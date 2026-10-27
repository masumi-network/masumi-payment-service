import { createRequire } from 'node:module';
import { describe, expect, it } from '@jest/globals';
import { ResourceInfoSchema, parsePaymentPayload, parsePaymentRequired } from '@x402/core/schemas';

const localRequire = createRequire(import.meta.url);
const x402Require = createRequire(localRequire.resolve('@x402/core'));
const zod4 = x402Require('zod') as typeof import('zod');
const v2Requirements = {
	scheme: 'exact',
	network: 'eip155:84532',
	amount: '10000',
	asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
	payTo: '0x6597342b1dd68216df749a3ccde47be1bf2a98a3',
	maxTimeoutSeconds: 300,
	extra: { assetTransferMethod: 'permit2', decimals: 6 },
};

describe('x402 V2 schemas with Zod 4', () => {
	it('parses real V2 requirements and rejects an invalid network or empty accepts list', () => {
		expect(x402Require('zod/package.json').version).toBe('4.6.6');

		const paymentRequired = {
			x402Version: 2,
			resource: { url: 'https://agent.example/run' },
			accepts: [v2Requirements],
			extensions: { merchant: { id: 'agent-1' } },
		};
		const valid = parsePaymentRequired(paymentRequired);
		expect(valid.success).toBe(true);
		if (valid.success) expect(valid.data).toMatchObject(paymentRequired);

		const invalidNetwork = parsePaymentRequired({
			...paymentRequired,
			accepts: [{ ...v2Requirements, network: 'base-sepolia' }],
		});
		expect(invalidNetwork.success).toBe(false);
		if (!invalidNetwork.success) expect(invalidNetwork.error.issues[0].path).toEqual(['accepts', 0, 'network']);
		expect(parsePaymentRequired({ ...paymentRequired, accepts: [] }).success).toBe(false);
	});

	it('parses a V2 payment payload record and rejects a scalar payload', () => {
		const paymentPayload = {
			x402Version: 2,
			resource: { url: 'https://agent.example/run' },
			accepted: v2Requirements,
			payload: { signature: '0xabc', authorization: { nonce: '0x01', value: '10000' } },
		};
		const valid = parsePaymentPayload(paymentPayload);
		expect(valid.success).toBe(true);
		if (valid.success) expect(valid.data).toMatchObject(paymentPayload);

		const invalid = parsePaymentPayload({ ...paymentPayload, payload: '0xabc' });
		expect(invalid.success).toBe(false);
		if (!invalid.success) expect(invalid.error.issues[0].path).toEqual(['payload']);
	});
});

describe('Zod 4 collection bounds', () => {
	it('rejects oversized x402 resource tags with one bound issue', () => {
		const result = ResourceInfoSchema.safeParse({
			url: 'https://example.com/resource',
			tags: Array.from({ length: 6 }, () => ''),
		});
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.issues.map((issue: { code: string }) => issue.code)).toEqual(['too_big']);
	});

	it('rejects oversized arrays before parsing elements', () => {
		let parsedElements = 0;
		const element = zod4.string().refine(() => {
			parsedElements += 1;
			return false;
		});

		for (const schema of [zod4.array(element).max(1), zod4.array(element).length(1)]) {
			const result = schema.safeParse(['first', 'second']);
			expect(result.success).toBe(false);
			if (!result.success) expect(result.error.issues.map(({ code }) => code)).toEqual(['too_big']);
		}
		expect(parsedElements).toBe(0);
	});

	it('rejects oversized sets before parsing elements', () => {
		let parsedElements = 0;
		const element = zod4.string().refine(() => {
			parsedElements += 1;
			return false;
		});
		const result = zod4
			.set(element)
			.max(1)
			.safeParse(new Set(['first', 'second']));

		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.issues.map(({ code }) => code)).toEqual(['too_big']);
		expect(parsedElements).toBe(0);
	});

	it('rejects oversized arrays before starting asynchronous refinements', async () => {
		let parsedElements = 0;
		const element = zod4.string().refine(async () => {
			parsedElements += 1;
			return false;
		});
		const result = await zod4.array(element).max(1).safeParseAsync(['first', 'second']);

		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.issues.map(({ code }) => code)).toEqual(['too_big']);
		expect(parsedElements).toBe(0);
	});
});
