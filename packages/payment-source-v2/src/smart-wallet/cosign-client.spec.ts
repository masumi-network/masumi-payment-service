import { decodeCosignBody, decodeCosignBodyEcho, parseCosignResponse, withDigestPrefix } from './cosign-client';

const txBodyHash = 'a'.repeat(64);
const agent = 'b'.repeat(56);
const quorum = 'c'.repeat(56);
const batchId = '7f0c3d2e-9a4b-4c1d-8e2f-3a4b5c6d7e8f';
const purchaseIds = ['pur-1', 'pur-2'];
const expected = { txBodyHash, requiredSigners: [agent, quorum], batchId, purchaseIds };

const envelope = { asOf: '2026-09-16T12:00:00.000Z', schemaVersion: '1.1', chainTip: null };
const members = purchaseIds.map((purchaseId, outputIndex) => ({ purchaseId, outputIndex, verdict: 'allowed' }));

const approvedBody = {
	...envelope,
	decisionId: 'dec_01J9XK3M4N5P6Q7R8S9T0V1W2X',
	quorumMembers: ['exchain-eu-1a'],
	witnessSetHex: 'a100',
	witnesses: [{ member: 'exchain-eu-1a', vkeyHex: 'd'.repeat(64), signatureHex: 'e'.repeat(128) }],
	members,
	boundsRemaining: {},
	journalRef: 'https://journal.example.com/dec_01J9XK3M4N5P6Q7R8S9T0V1W2X',
};

const deniedBody = {
	...envelope,
	decisionId: 'dec_01J9XK3M4N5P6Q7R8S9T0V1W2X',
	denied: 'member_denied',
	members: [
		members[0],
		{
			purchaseId: purchaseIds[1],
			outputIndex: 1,
			verdict: 'denied',
			denied: 'per_tx_cap',
			reasonEnglish: 'Over the per-payment cap.',
			bound: '1',
			used: '0',
			attempted: '2',
		},
	],
	rebuild: { keep: [purchaseIds[0]], batchId, heldUntil: '2026-09-16T12:02:00.000Z' },
	alarm: false,
	journalRef: 'https://journal.example.com/dec_01J9XK3M4N5P6Q7R8S9T0V1W2X',
};

const responses = [
	{ status: 200, body: approvedBody as Record<string, unknown> },
	{ status: 409, body: deniedBody as Record<string, unknown> },
];

describe.each(responses)('co-sign response echoes (HTTP $status)', ({ status, body }) => {
	const echo = { txBodyHash: withDigestPrefix(txBodyHash), requiredSigners: [agent, quorum] };
	const parse = (value: object) => parseCosignResponse(status, JSON.stringify(value), expected);

	it('accepts the decoded signer set regardless of order', () => {
		expect(parse({ ...body, ...echo, requiredSigners: [quorum, agent] }).httpStatus).toBe(status);
	});

	it('rejects responses without the decoded body echo', () => {
		expect(() => parse(body)).toThrow();
	});

	it('rejects a response naming another body', () => {
		expect(() => parse({ ...body, ...echo, txBodyHash: withDigestPrefix('d'.repeat(64)) })).toThrow();
	});

	it('rejects a response missing the agent signer', () => {
		expect(() => parse({ ...body, ...echo, requiredSigners: [quorum] })).toThrow();
	});

	it('rejects additional or repeated signers', () => {
		for (const requiredSigners of [
			[agent, quorum, 'd'.repeat(56)],
			[agent, quorum, quorum],
		]) {
			expect(() => parse({ ...body, ...echo, requiredSigners })).toThrow();
		}
	});

	it('rejects verdicts that do not answer the purchases we submitted', () => {
		const replied = body.members as Array<Record<string, unknown>>;
		const renamed = replied.map((member, index) => ({
			...member,
			purchaseId: index === 0 ? 'pur-other' : member.purchaseId,
		}));
		expect(() => parse({ ...body, ...echo, members: renamed })).toThrow();
		expect(() => parse({ ...body, ...echo, members: [replied[0]] })).toThrow();
	});
});

describe('member denials', () => {
	const echo = { txBodyHash: withDigestPrefix(txBodyHash), requiredSigners: [agent, quorum] };
	const denial = { ...deniedBody, ...echo };

	it('requires a rebuild set that names our batch and only our purchases', () => {
		expect(parseCosignResponse(409, JSON.stringify(denial), expected).httpStatus).toBe(409);
		const cases = [
			{ ...denial, rebuild: undefined },
			{ ...denial, rebuild: { ...denial.rebuild, batchId: '00000000-0000-4000-8000-000000000000' } },
			{ ...denial, rebuild: { ...denial.rebuild, keep: ['pur-not-ours'] } },
		];
		for (const value of cases) {
			expect(() => parseCosignResponse(409, JSON.stringify(value), expected)).toThrow();
		}
	});

	it('requires a batch-level denial to leave every member unevaluated', () => {
		const batchDenial = { ...denial, denied: 'utxo_unknown', reasonEnglish: 'unknown wallet', rebuild: undefined };
		expect(() => parseCosignResponse(409, JSON.stringify(batchDenial), expected)).toThrow();
		const unevaluated = purchaseIds.map((purchaseId, outputIndex) => ({
			purchaseId,
			outputIndex,
			verdict: 'not_evaluated',
		}));
		expect(
			parseCosignResponse(409, JSON.stringify({ ...batchDenial, members: unevaluated }), expected).httpStatus,
		).toBe(409);
	});
});

describe('quorum outage', () => {
	it('is a decision arm of its own, so nothing is submitted and the batch id is reused', () => {
		const outage = { ...envelope, error: 'quorum_unavailable', reachable: 1, threshold: 2, retryAfterSec: 5 };
		const decision = parseCosignResponse(503, JSON.stringify(outage), expected);
		expect(decision).toEqual({ httpStatus: 503, unavailable: outage });
	});
});

describe('decoded co-sign body', () => {
	// Transaction with empty inputs/outputs, zero fee, and two required signers.
	const txCbor = `84a40080018002000e82581c${agent}581c${quorum}a0f5f6`;

	it('extracts the agent and quorum from CBOR instead of request hints', () => {
		expect(decodeCosignBodyEcho(txCbor)).toEqual({
			txBodyHash: 'b04decbe16e050c029e980afca83b951f3d4d08e26340c8c491ab2705716add1',
			requiredSigners: [agent, quorum],
		});
	});

	it('sends the body alone, whose hash is the transaction hash', () => {
		const body = decodeCosignBody(txCbor);
		expect(body.txBodyHex).toBe(`a40080018002000e82581c${agent}581c${quorum}`);
		expect(txCbor).toBe(`84${body.txBodyHex}a0f5f6`);
		expect(body.txBodyHash).toBe('b04decbe16e050c029e980afca83b951f3d4d08e26340c8c491ab2705716add1');
	});
});
