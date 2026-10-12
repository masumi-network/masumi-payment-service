import { describe, expect, it } from '@jest/globals';
import type { CosignRequest } from '../../src/smart-wallet/cosign-client';
import { verifyIntentAgainstBody, type DecodedOutput, type DecodedTxBody } from './cosign-policy';

const WALLET_ADDRESS = 'addr_test1zwallet';
const WALLET_REF = `${'aa'.repeat(32)}#1`;
const STATE_TOKEN = `${'98'.repeat(28)}${'cb'.repeat(32)}`;
const OTHER_WALLET_TOKEN = `${'98'.repeat(28)}${'dd'.repeat(32)}`;

const continuing = (singleUnits: string[]): DecodedOutput => ({
	address: WALLET_ADDRESS,
	lovelace: 90n,
	hasOtherAssets: true,
	singleUnits,
	paymentKeyHash: null,
	lock: null,
});

const body = (singleUnits: string[]): DecodedTxBody => ({
	inputs: [{ txHash: 'aa'.repeat(32), outputIndex: 1 }],
	outputs: [continuing(singleUnits)],
	requiredSigners: ['m1'],
	fee: 0n,
	hasBalanceFields: false,
	validityStart: 100,
	ttl: 200,
});

const request = { batchId: 'b', walletUtxoRef: WALLET_REF, intents: [] } as unknown as CosignRequest;
const policy = {
	memberVkhs: ['m1'],
	threshold: 1,
	maxOutflowLovelace: 10n,
	maxPerIntentLovelace: 10n,
	maxValiditySlots: 1000,
	agentVkhs: [],
	escrowAddresses: [],
};
const verify = (singleUnits: string[]) =>
	verifyIntentAgainstBody({
		request,
		body: body(singleUnits),
		walletInput: { address: WALLET_ADDRESS, lovelace: 100n, stateTokenUnit: STATE_TOKEN },
		policy,
		nowMs: 0,
	});

describe('continuing state-token check', () => {
	it("refuses a body whose continuing output carries another wallet's state token", () => {
		// Wallets of one configuration share an address, and snapshot refs are not
		// signed: a relabelled ref could make the body spend another wallet.
		expect(verify([OTHER_WALLET_TOKEN])).toMatchObject({
			kind: 'batch-denied',
			code: 'body_mismatch',
			reasonEnglish: expect.stringContaining('state token'),
		});
	});

	it('passes the check when the continuing output carries the wallet state token', () => {
		const outcome = verify([STATE_TOKEN]);
		expect(outcome.kind === 'batch-denied' ? outcome.reasonEnglish : '').not.toContain('state token');
	});
});

describe('in-head body shape check', () => {
	// A snapshot proof may be stale, so the body must spend only the wallet and
	// create only the continuing and intent outputs: then the real outflow is
	// the declared outflow, whatever the wallet holds now.
	const shapeVerify = (change: Partial<DecodedTxBody>, inHead = true) =>
		verifyIntentAgainstBody({
			request,
			body: { ...body([STATE_TOKEN]), ...change },
			walletInput: { address: WALLET_ADDRESS, lovelace: 90n, stateTokenUnit: inHead ? STATE_TOKEN : undefined },
			policy,
			nowMs: 0,
		});
	const reason = (outcome: ReturnType<typeof verifyIntentAgainstBody>) =>
		outcome.kind === 'batch-denied' ? outcome.reasonEnglish : '';
	const agentChange: DecodedOutput = {
		...continuing([]),
		address: 'addr_test1agent',
		lovelace: 7n,
		hasOtherAssets: false,
	};

	it('refuses a second input', () => {
		const inputs = [...body([]).inputs, { txHash: 'bb'.repeat(32), outputIndex: 0 }];
		expect(reason(shapeVerify({ inputs }))).toContain('only the wallet');
	});

	it('refuses an output that is neither the continuing output nor an intent output', () => {
		expect(reason(shapeVerify({ outputs: [continuing([STATE_TOKEN]), agentChange] }))).toContain('only the wallet');
	});

	it('refuses a nonzero fee', () => {
		expect(reason(shapeVerify({ fee: 1n }))).toContain('only the wallet');
	});

	it('refuses certificates, withdrawals, mint or treasury fields (deposits and donation move value too)', () => {
		expect(reason(shapeVerify({ hasBalanceFields: true }))).toContain('only the wallet');
	});

	it('passes the honest shape', () => {
		expect(reason(shapeVerify({}))).not.toContain('only the wallet');
	});

	it('does not apply to an L1 spend (no state token named)', () => {
		expect(reason(shapeVerify({ fee: 1n }, false))).not.toContain('only the wallet');
	});
});
