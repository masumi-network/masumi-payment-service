import { describe, expect, it } from '@jest/globals';
import { serializeData, type UTxO } from '@meshsdk/core';
import { describeWalletUtxo } from './guarded-wallet';
import { assetValueData, cosignerKeyHashes, walletDatumData } from './wallet';

const POLICY = 'c'.repeat(56);
const STATE_TOKEN = `${POLICY}${'d'.repeat(64)}`;
const TUSDM = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d';
const OTHER = `${'e'.repeat(56)}abcd`;

function walletUtxo(amount: UTxO['output']['amount'], limit = [{ unit: 'lovelace', quantity: '50000000' }]): UTxO {
	const datum = walletDatumData({
		agent: 'a'.repeat(56),
		limit: assetValueData(limit),
		periodLength: 86_400_000n,
		periodStart: 0n,
		spentInPeriod: assetValueData(limit.map(({ unit }) => ({ unit, quantity: unit === TUSDM ? '7' : '0' }))),
		minBalanceLovelace: 2_000_000n,
	});
	return {
		input: { txHash: 'f'.repeat(64), outputIndex: 0 },
		output: { address: 'addr_test1script', amount, plutusData: serializeData(datum) },
	};
}

describe('describeWalletUtxo assets', () => {
	it('lists limits in datum order, then held but unlisted assets, without the state token', () => {
		const state = describeWalletUtxo(
			{ address: 'addr_test1script', policyId: POLICY },
			walletUtxo(
				[
					{ unit: 'lovelace', quantity: '75000000' },
					{ unit: STATE_TOKEN, quantity: '1' },
					{ unit: TUSDM, quantity: '50000000' },
					{ unit: OTHER, quantity: '3' },
				],
				[
					{ unit: 'lovelace', quantity: '50000000' },
					{ unit: TUSDM, quantity: '100000000' },
				],
			),
		);
		expect(state.assets).toEqual([
			{ unit: 'lovelace', quantity: 75_000_000n, limit: 50_000_000n, spentInPeriod: 0n },
			{ unit: TUSDM, quantity: 50_000_000n, limit: 100_000_000n, spentInPeriod: 7n },
			{ unit: OTHER, quantity: 3n, limit: null, spentInPeriod: null },
		]);
	});

	it('shows a listed asset the wallet does not hold yet with quantity 0', () => {
		const state = describeWalletUtxo(
			{ address: 'addr_test1script', policyId: POLICY },
			walletUtxo(
				[{ unit: 'lovelace', quantity: '5000000' }],
				[
					{ unit: 'lovelace', quantity: '1' },
					{ unit: TUSDM, quantity: '2' },
				],
			),
		);
		expect(state.assets.map(({ unit, quantity }) => [unit, quantity])).toEqual([
			['lovelace', 5_000_000n],
			[TUSDM, 0n],
		]);
	});
});

describe('cosignerKeyHashes', () => {
	const owner = '1'.repeat(56);
	const a = '2'.repeat(56);
	const b = '3'.repeat(56);

	it('takes the first threshold quorum keys', () => {
		expect(cosignerKeyHashes({ quorumVkhs: [a, b], threshold: 1 }, owner)).toEqual([a]);
	});

	// The owner never counts on chain and Exchain cannot sign for it.
	it('skips the owner key when it sits in the quorum', () => {
		expect(cosignerKeyHashes({ quorumVkhs: [owner, a, b], threshold: 2 }, owner)).toEqual([a, b]);
	});
});

describe('describeWalletUtxo origin', () => {
	it('keeps the hash of the tx that created the wallet UTxO', () => {
		const state = describeWalletUtxo(
			{ address: 'addr_test1script', policyId: POLICY },
			walletUtxo([
				{ unit: 'lovelace', quantity: '10000000' },
				{ unit: STATE_TOKEN, quantity: '1' },
			]),
		);
		expect(state.utxoTxHash).toBe('f'.repeat(64));
	});
});
