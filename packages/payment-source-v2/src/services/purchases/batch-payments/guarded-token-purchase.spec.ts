import { describe, expect, it, jest } from '@jest/globals';
import type { UTxO } from '@meshsdk/core';
import { assetValueData, type WalletDatum } from '../../../smart-wallet/wallet';

jest.unstable_mockModule('@masumi/payment-core/db', () => ({ prisma: {} }));

const { guardedPurchaseFits, guardedSpendableToken } = await import('./guarded-packing');
const { guardedLockValue, cosignIntentFor } = await import('./guarded-cosign-purchase');
const { isPackableForWallet } = await import('./packing-eligibility');

const TUSDM = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d';
const TUSDM_ID = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde.0014df10745553444d';
const OTHER = `${'0'.repeat(56)}abcd`;
const PERIOD_START = 1_000n;
const PERIOD_LENGTH = 86_400_000n;
const IN_PERIOD = PERIOD_START + 1n;
const AFTER_PERIOD = PERIOD_START + PERIOD_LENGTH;

function datum(tokenLimit: bigint, tokenSpent: bigint): WalletDatum {
	return {
		agent: 'a'.repeat(56),
		limit: assetValueData([
			{ unit: 'lovelace', quantity: '50000000' },
			{ unit: TUSDM, quantity: tokenLimit.toString() },
		]),
		periodLength: PERIOD_LENGTH,
		periodStart: PERIOD_START,
		spentInPeriod: assetValueData([
			{ unit: 'lovelace', quantity: '0' },
			{ unit: TUSDM, quantity: tokenSpent.toString() },
		]),
		minBalanceLovelace: 2_000_000n,
	};
}

function walletUtxo(tokens: bigint): UTxO {
	return {
		input: { txHash: 'b'.repeat(64), outputIndex: 0 },
		output: {
			address: 'addr_test1script',
			amount: [
				{ unit: 'lovelace', quantity: '20000000' },
				{ unit: TUSDM, quantity: tokens.toString() },
			],
		},
	};
}

describe('guardedPurchaseFits', () => {
	it.each([
		['lovelace', [{ unit: '' }], true],
		['lovelace', [{ unit: 'lovelace' }], true],
		['lovelace', [{ unit: TUSDM }], false],
		['lovelace', [{ unit: '' }, { unit: TUSDM }], false],
		[TUSDM_ID, [{ unit: TUSDM }], true],
		[TUSDM_ID, [{ unit: '' }], false],
		[TUSDM_ID, [{ unit: '' }, { unit: TUSDM }], false],
		[TUSDM_ID, [{ unit: OTHER }], false],
		['lovelace', [], false],
	])('a %s wallet and a price in %j fits: %s', (governedAsset, paidFunds, fits) => {
		expect(guardedPurchaseFits(governedAsset, paidFunds)).toBe(fits);
	});
});

describe('guardedSpendableToken', () => {
	it('is capped by the balance', () => {
		expect(guardedSpendableToken(datum(100n, 0n), walletUtxo(40n), IN_PERIOD, TUSDM)).toEqual({
			spendable: 40n,
			isBudgetBound: false,
		});
	});

	it('is capped by the budget left, and budget-bound while the period runs', () => {
		expect(guardedSpendableToken(datum(100n, 90n), walletUtxo(40n), IN_PERIOD, TUSDM)).toEqual({
			spendable: 10n,
			isBudgetBound: true,
		});
	});

	it('counts the full limit again after the period', () => {
		expect(guardedSpendableToken(datum(100n, 90n), walletUtxo(40n), AFTER_PERIOD, TUSDM).spendable).toBe(40n);
	});

	it('is zero for an unlisted token, which the contract freezes', () => {
		expect(guardedSpendableToken(datum(100n, 0n), walletUtxo(40n), IN_PERIOD, OTHER).spendable).toBe(0n);
	});
});

describe('guardedLockValue', () => {
	it('carries the token and its min-UTxO lovelace, and shows the co-signer the token amount', () => {
		const value = guardedLockValue(
			{
				id: 'p1',
				PaidFunds: [
					{ unit: TUSDM, amount: 5_000_000n },
					{ unit: '', amount: 1_400_000n },
				],
			},
			TUSDM_ID,
		);
		expect(value).toEqual({
			amount: [
				{ unit: TUSDM, quantity: '5000000' },
				{ unit: 'lovelace', quantity: '1400000' },
			],
			governedAmount: 5_000_000n,
		});
	});

	it('sums repeated lovelace units for a lovelace wallet', () => {
		const value = guardedLockValue(
			{
				id: 'p1',
				PaidFunds: [
					{ unit: '', amount: 3n },
					{ unit: 'lovelace', amount: 2n },
				],
			},
			'lovelace',
		);
		expect(value).toEqual({ amount: [{ unit: 'lovelace', quantity: '5' }], governedAmount: 5n });
	});

	it('refuses a unit the wallet does not pay in', () => {
		expect(() => guardedLockValue({ id: 'p1', PaidFunds: [{ unit: TUSDM, amount: 5n }] }, 'lovelace')).toThrow(
			/pays in lovelace/,
		);
	});

	it('refuses a token purchase that carries only lovelace', () => {
		expect(() => guardedLockValue({ id: 'p1', PaidFunds: [{ unit: '', amount: 5n }] }, TUSDM_ID)).toThrow(/pays no/);
	});
});

describe('cosignIntentFor', () => {
	it('names the payment asset and its amount', () => {
		const intent = cosignIntentFor(
			{
				id: 'p1',
				nextActionId: 'a1',
				agentIdentifier: 'agent-1',
				blockchainIdentifier: 'bid',
				inputHash: 'c'.repeat(64),
				PaidFunds: [],
				SellerWallet: { walletVkey: 'd'.repeat(56) },
			},
			2,
			TUSDM_ID,
			5_000_000n,
		);
		expect(intent).toMatchObject({ outputIndex: 2, asset: TUSDM_ID, amount: '5000000' });
	});
});

describe('isPackableForWallet', () => {
	const request = (paidFunds: Array<{ unit: string }>, limitedTo: string[] | null = null) => ({
		isLimitedToHotWallets: limitedTo != null,
		HotWalletLimit: (limitedTo ?? []).map((id) => ({ id })),
		PaidFunds: paidFunds,
	});

	it('lets a plain wallet take any price', () => {
		expect(isPackableForWallet(request([{ unit: TUSDM }]), { walletId: 'w1', guarded: null })).toBe(true);
	});

	it('keeps a token price away from a lovelace guarded wallet', () => {
		const wallet = { walletId: 'w1', guarded: { governedAsset: 'lovelace' } };
		expect(isPackableForWallet(request([{ unit: TUSDM }]), wallet)).toBe(false);
		expect(isPackableForWallet(request([{ unit: '' }]), wallet)).toBe(true);
	});

	it('still honours the hot wallet limit', () => {
		const wallet = { walletId: 'w1', guarded: { governedAsset: TUSDM_ID } };
		expect(isPackableForWallet(request([{ unit: TUSDM }], ['w2']), wallet)).toBe(false);
		expect(isPackableForWallet(request([{ unit: TUSDM }], ['w1']), wallet)).toBe(true);
	});
});
