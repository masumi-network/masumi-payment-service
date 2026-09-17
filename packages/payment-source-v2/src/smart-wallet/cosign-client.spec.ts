import { decodeCosignBodyEcho, parseCosignResponse } from './cosign-client';

const txBodyHash = 'a'.repeat(64);
const agent = 'b'.repeat(56);
const quorum = 'c'.repeat(56);
const expected = { txBodyHash, requiredSigners: [agent, quorum] };

const responses = [
	{
		status: 200,
		body: {
			decision: 'approved',
			txHash: txBodyHash,
			signatures: [{ vkh: quorum, witnessSet: 'a100' }],
			expiresAt: '2026-09-15T12:00:00Z',
		},
	},
	{
		status: 409,
		body: { decision: 'denied', code: 'POLICY_LIMIT_EXCEEDED', message: 'Limit exceeded', retryable: false, locks: [] },
	},
];

describe.each(responses)('co-sign response echoes (HTTP $status)', ({ status, body }) => {
	const parse = (value: object) => parseCosignResponse(status, JSON.stringify(value), expected);

	it('accepts the decoded signer set regardless of order', () => {
		expect(parse({ ...body, txBodyHash, requiredSigners: [quorum, agent] }).httpStatus).toBe(status);
	});

	it('rejects responses without the decoded body echo', () => {
		expect(() => parse(body)).toThrow();
	});

	it('rejects a response naming another body', () => {
		expect(() => parse({ ...body, ...expected, txBodyHash: 'd'.repeat(64) })).toThrow();
	});

	it('rejects a response missing the agent signer', () => {
		expect(() => parse({ ...body, ...expected, requiredSigners: [quorum] })).toThrow();
	});

	it('rejects additional or repeated signers', () => {
		for (const requiredSigners of [
			[agent, quorum, 'd'.repeat(56)],
			[agent, quorum, quorum],
		]) {
			expect(() => parse({ ...body, ...expected, requiredSigners })).toThrow();
		}
	});
});

describe('decoded co-sign body', () => {
	it('extracts the agent and quorum from CBOR instead of request hints', () => {
		// Transaction with empty inputs/outputs, zero fee, and two required signers.
		const txCbor = `84a40080018002000e82581c${agent}581c${quorum}a0f5f6`;
		expect(decodeCosignBodyEcho(txCbor)).toEqual({
			txBodyHash: 'b04decbe16e050c029e980afca83b951f3d4d08e26340c8c491ab2705716add1',
			requiredSigners: [agent, quorum],
		});
	});
});
