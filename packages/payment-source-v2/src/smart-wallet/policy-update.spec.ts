import { describe, expect, it } from '@jest/globals';
import { planPolicyUpdate, PolicyUpdateRefusedError, withMinLovelace } from './policy-update';
import { assetValueData, assetValueEntries, type WalletDatum } from './wallet';

const STATE_POLICY = 'c'.repeat(56);
const STATE_TOKEN = `${STATE_POLICY}${'d'.repeat(64)}`;
const TUSDM = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d';
const TUSDM_ID = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde.0014df10745553444d';
const OTHER = `${'0'.repeat(56)}abcd`;

const datum: WalletDatum = {
	agent: 'a'.repeat(56),
	limit: assetValueData([{ unit: 'lovelace', quantity: '50000000' }]),
	periodLength: 86_400_000n,
	periodStart: 123n,
	spentInPeriod: assetValueData([{ unit: 'lovelace', quantity: '7000000' }]),
	minBalanceLovelace: 2_000_000n,
};
const walletAmount = [
	{ unit: 'lovelace', quantity: '75000000' },
	{ unit: STATE_TOKEN, quantity: '1' },
];
const limits = [
	{ unit: 'lovelace', quantity: '50000000' },
	{ unit: TUSDM, quantity: '100000000' },
];

function plan(overrides: Partial<Parameters<typeof planPolicyUpdate>[0]> = {}) {
	return planPolicyUpdate({
		datum,
		walletAmount,
		stateTokenPolicyId: STATE_POLICY,
		limits,
		deposit: [{ unit: TUSDM, quantity: '50000000' }],
		governedAsset: 'lovelace',
		isRegisteredWithExchain: true,
		...overrides,
	});
}

function refusal(overrides: Partial<Parameters<typeof planPolicyUpdate>[0]>): string {
	try {
		plan(overrides);
	} catch (error) {
		if (error instanceof PolicyUpdateRefusedError) return error.message;
		throw error;
	}
	throw new Error('expected a refusal');
}

describe('planPolicyUpdate', () => {
	it('adds a token limit, keeps the old counter, starts the new one at 0', () => {
		const { nextDatum } = plan();
		expect(assetValueEntries(nextDatum.limit)).toEqual([
			{ policyId: '', assetName: '', quantity: 50_000_000n },
			{ policyId: TUSDM.slice(0, 56), assetName: TUSDM.slice(56), quantity: 100_000_000n },
		]);
		expect(assetValueEntries(nextDatum.spentInPeriod).map(({ quantity }) => quantity)).toEqual([7_000_000n, 0n]);
		expect(nextDatum).toMatchObject({ agent: datum.agent, periodStart: 123n, minBalanceLovelace: 2_000_000n });
	});

	it('lists limit and spent_in_period in the same order whatever order limits came in', () => {
		const { nextDatum } = plan({ limits: [...limits].reverse() });
		const keys = (value: WalletDatum['limit']) => assetValueEntries(value).map((e) => e.policyId + e.assetName);
		expect(keys(nextDatum.limit)).toEqual(keys(nextDatum.spentInPeriod));
		expect(keys(nextDatum.limit)[0]).toBe('');
	});

	it('adds the deposit to the wallet value and keeps the state token', () => {
		expect(plan().continuingAmount).toEqual([
			{ unit: 'lovelace', quantity: '75000000' },
			{ unit: STATE_TOKEN, quantity: '1' },
			{ unit: TUSDM, quantity: '50000000' },
		]);
	});

	it.each([
		['no lovelace', { limits: [{ unit: TUSDM, quantity: '1' }] }, /must list lovelace/],
		['a repeated asset', { limits: [...limits, { unit: '', quantity: '1' }] }, /twice/],
		['the state token', { limits: [...limits, { unit: STATE_TOKEN, quantity: '1' }] }, /state token/],
		[
			'a held asset dropped',
			{ walletAmount: [...walletAmount, { unit: OTHER, quantity: '3' }] },
			new RegExp(`holds ${OTHER}`),
		],
		['an unlisted deposit', { deposit: [{ unit: OTHER, quantity: '3' }] }, /would be frozen/],
		['a zero deposit', { deposit: [{ unit: TUSDM, quantity: '0' }] }, /positive/],
		[
			'the payment asset missing',
			{ governedAsset: TUSDM_ID, limits: [{ unit: 'lovelace', quantity: '1' }] },
			/asset agents pay in/,
		],
		[
			'a registered payment-asset limit changed',
			{ limits: [{ unit: 'lovelace', quantity: '60000000' }, limits[1]] },
			/mandate is fixed/,
		],
	])('refuses %s', (_label, overrides, message) => {
		expect(refusal(overrides)).toMatch(message);
	});

	it('lets an unregistered wallet change its payment-asset limit', () => {
		const { nextDatum } = plan({
			limits: [{ unit: 'lovelace', quantity: '60000000' }, limits[1]],
			isRegisteredWithExchain: false,
		});
		expect(assetValueEntries(nextDatum.limit)[0].quantity).toBe(60_000_000n);
	});
});

describe('withMinLovelace', () => {
	it('tops lovelace up to the minimum and leaves enough alone', () => {
		const amount = [
			{ unit: 'lovelace', quantity: '1000000' },
			{ unit: TUSDM, quantity: '5' },
		];
		expect(withMinLovelace(amount, 1_500_000n)).toEqual([
			{ unit: TUSDM, quantity: '5' },
			{ unit: 'lovelace', quantity: '1500000' },
		]);
		expect(withMinLovelace(amount, 900_000n)).toBe(amount);
	});
});
