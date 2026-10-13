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
	assets: new Map(singleUnits.map((unit) => [unit, 1n])),
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
	governedAsset: 'lovelace',
	maxOutflow: 10n,
	maxPerIntent: 10n,
	maxRideAlongLovelace: 0n,
	maxValiditySlots: 1000,
	agentVkhs: [],
	escrowAddresses: [],
};
const verify = (singleUnits: string[]) =>
	verifyIntentAgainstBody({
		request,
		body: body(singleUnits),
		walletInput: { address: WALLET_ADDRESS, lovelace: 100n, assets: new Map(), stateTokenUnit: STATE_TOKEN },
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
			walletInput: {
				address: WALLET_ADDRESS,
				lovelace: 90n,
				assets: new Map([[STATE_TOKEN, 1n]]),
				stateTokenUnit: inHead ? STATE_TOKEN : undefined,
			},
			policy,
			nowMs: 0,
		});
	const reason = (outcome: ReturnType<typeof verifyIntentAgainstBody>) =>
		outcome.kind === 'batch-denied' ? outcome.reasonEnglish : '';
	const agentChange: DecodedOutput = {
		...continuing([]),
		address: 'addr_test1agent',
		lovelace: 7n,
		assets: new Map(),
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

describe('token wallet', () => {
	// A wallet that pays in tUSDM: 100 tUSDM and 50 ADA in, one 5 tUSDM lock out.
	const TUSDM = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d';
	const TUSDM_ID = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde.0014df10745553444d';
	const ESCROW = 'addr_test1escrow';
	const SELLER = 'e'.repeat(56);
	const AGENT = 'f'.repeat(56);
	const lockOutput = (lovelace: bigint, assets: Array<[string, bigint]>): DecodedOutput => ({
		address: ESCROW,
		lovelace,
		assets: new Map(assets),
		paymentKeyHash: null,
		lock: { blockchainIdentifier: 'bid', buyerPaymentKeyHash: AGENT, sellerPaymentKeyHash: SELLER, fundsLocked: true },
	});
	const tokenVerify = (params: {
		lock?: DecodedOutput;
		continuingLovelace?: bigint;
		continuingTokens?: bigint;
		asset?: string;
		amount?: string;
		/** Another token the wallet holds that the body does not keep. */
		leakedToken?: [string, bigint];
	}) =>
		verifyIntentAgainstBody({
			request: {
				batchId: 'b',
				walletUtxoRef: WALLET_REF,
				intents: [
					{
						purchaseId: 'p1',
						outputIndex: 1,
						counterparty: `sellerVkeyHash:${SELLER}`,
						amount: params.amount ?? '5000000',
						asset: params.asset ?? TUSDM_ID,
						jobHash: 'j',
						agentIdentifier: 'a',
					},
				],
			} as unknown as CosignRequest,
			body: {
				...body([STATE_TOKEN]),
				outputs: [
					{
						...continuing([STATE_TOKEN]),
						lovelace: params.continuingLovelace ?? 48_500_000n,
						assets: new Map([
							[STATE_TOKEN, 1n],
							[TUSDM, params.continuingTokens ?? 95_000_000n],
						]),
					},
					params.lock ?? lockOutput(1_500_000n, [[TUSDM, 5_000_000n]]),
				],
			},
			walletInput: {
				address: WALLET_ADDRESS,
				lovelace: 50_000_000n,
				assets: new Map([
					[STATE_TOKEN, 1n],
					[TUSDM, 100_000_000n],
					...(params.leakedToken == null ? [] : [params.leakedToken]),
				]),
			},
			policy: {
				...policy,
				governedAsset: TUSDM_ID,
				maxOutflow: 40_000_000n,
				maxPerIntent: 20_000_000n,
				maxRideAlongLovelace: 3_000_000n,
				agentVkhs: [AGENT],
				escrowAddresses: [ESCROW],
			},
			nowMs: 0,
		});
	const reason = (outcome: ReturnType<typeof verifyIntentAgainstBody>) =>
		outcome.kind === 'batch-denied' ? `${outcome.code}: ${outcome.reasonEnglish}` : outcome.kind;

	it('admits a token lock with its ride-along lovelace', () => {
		expect(reason(tokenVerify({}))).toBe('allow');
	});

	it('refuses an intent in another asset', () => {
		expect(reason(tokenVerify({ asset: 'lovelace' }))).toMatch(/^asset_not_listed/);
	});

	it('refuses a lock output that carries a token the mandate does not list', () => {
		const lock = lockOutput(1_500_000n, [
			[TUSDM, 5_000_000n],
			[`${'0'.repeat(56)}ab`, 1n],
		]);
		expect(reason(tokenVerify({ lock }))).toMatch(/^asset_not_listed/);
	});

	it('refuses a token amount other than the declared one', () => {
		expect(reason(tokenVerify({ amount: '4000000' }))).toMatch(/^body_mismatch: Purchase p1 declares/);
	});

	it('refuses a zero intent, whose ride-along lovelace no cap would count', () => {
		const lock = lockOutput(3_000_000n, []);
		expect(
			reason(tokenVerify({ lock, amount: '0', continuingLovelace: 47_000_000n, continuingTokens: 100_000_000n })),
		).toMatch(/declares no amount/);
	});

	it('refuses ride-along lovelace above the cap', () => {
		const lock = lockOutput(4_000_000n, [[TUSDM, 5_000_000n]]);
		expect(reason(tokenVerify({ lock, continuingLovelace: 46_000_000n }))).toMatch(/beside the token/);
	});

	it('refuses lovelace that leaves the wallet beyond the ride-along', () => {
		expect(reason(tokenVerify({ continuingLovelace: 48_000_000n }))).toMatch(/wallet loses 2\.000000 tADA/);
	});

	it('refuses tokens that leave the wallet beyond the declared amount', () => {
		expect(reason(tokenVerify({ continuingTokens: 94_000_000n }))).toMatch(/wallet loses 6\.000000 tUSDM/);
	});

	it('refuses a body that lets another held token leave the wallet', () => {
		const leakedToken: [string, bigint] = [`${'1'.repeat(56)}4f54484552`, 3_000_000n];
		expect(reason(tokenVerify({ leakedToken }))).toMatch(/wallet loses 3\.000000 OTHER/);
	});
});
