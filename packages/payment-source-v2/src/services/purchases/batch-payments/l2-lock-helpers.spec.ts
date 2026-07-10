import { describe, it, expect } from '@jest/globals';
import { SmartContractState } from '@masumi/payment-core/smart-contract-state';
import {
	buildL2LockDatumParams,
	mapPaidFundsToAssets,
	resolveL2BuyerReturnAddress,
	selectInHeadFundingUtxos,
	type L2FundingUtxo,
	type L2LockRequestFields,
} from './l2-lock-helpers';

describe('resolveL2BuyerReturnAddress', () => {
	it('uses the request buyer return address when present', () => {
		expect(resolveL2BuyerReturnAddress('addr_buyer', 'addr_collection')).toBe('addr_buyer');
	});

	it('falls back to the wallet collection address when the request has none', () => {
		expect(resolveL2BuyerReturnAddress(null, 'addr_collection')).toBe('addr_collection');
	});

	it('treats an empty-string request address as a real value (no fallback)', () => {
		// `??` only falls back on null/undefined — an empty string is preserved.
		expect(resolveL2BuyerReturnAddress('', 'addr_collection')).toBe('');
	});

	it('returns null when neither request nor wallet has an address', () => {
		expect(resolveL2BuyerReturnAddress(null, null)).toBeNull();
	});
});

describe('mapPaidFundsToAssets', () => {
	it('normalises an empty unit to lovelace', () => {
		expect(mapPaidFundsToAssets([{ unit: '', amount: 5_000_000n }])).toEqual([
			{ unit: 'lovelace', quantity: '5000000' },
		]);
	});

	it('preserves native asset units and stringifies bigint amounts', () => {
		expect(
			mapPaidFundsToAssets([
				{ unit: '', amount: 2_000_000n },
				{ unit: 'policy.assetname', amount: 42n },
			]),
		).toEqual([
			{ unit: 'lovelace', quantity: '2000000' },
			{ unit: 'policy.assetname', quantity: '42' },
		]);
	});

	it('returns an empty array for no funds', () => {
		expect(mapPaidFundsToAssets([])).toEqual([]);
	});
});

describe('buildL2LockDatumParams', () => {
	const request: L2LockRequestFields = {
		buyerReturnAddress: 'addr_buyer_return',
		sellerReturnAddress: 'addr_seller_return',
		blockchainIdentifier: 'bid-123',
		inputHash: 'inputhash-abc',
		payByTime: 1000n,
		submitResultTime: 2000n,
		unlockTime: 3000n,
		externalDisputeUnlockTime: 4000n,
	};

	const baseArgs = {
		request,
		buyerAddress: 'addr_buyer',
		sellerAddress: 'addr_seller',
		buyerReturnAddress: 'addr_buyer_return',
	};

	it('produces the initial FundsLocked state with no result', () => {
		const params = buildL2LockDatumParams(baseArgs);
		expect(params.state).toBe(SmartContractState.FundsLocked);
		expect(params.resultHash).toBeNull();
	});

	it('zeroes collateral return (head is zero-fee) and both cooldowns', () => {
		const params = buildL2LockDatumParams(baseArgs);
		expect(params.collateralReturnLovelace).toBe(0n);
		expect(params.newCooldownTimeSeller).toBe(0n);
		expect(params.newCooldownTimeBuyer).toBe(0n);
	});

	it('maps addresses and identifiers through unchanged', () => {
		const params = buildL2LockDatumParams(baseArgs);
		expect(params.buyerAddress).toBe('addr_buyer');
		expect(params.sellerAddress).toBe('addr_seller');
		expect(params.buyerReturnAddress).toBe('addr_buyer_return');
		expect(params.sellerReturnAddress).toBe('addr_seller_return');
		expect(params.blockchainIdentifier).toBe('bid-123');
		expect(params.inputHash).toBe('inputhash-abc');
	});

	it('carries the request time windows through verbatim', () => {
		const params = buildL2LockDatumParams(baseArgs);
		expect(params.payByTime).toBe(1000n);
		expect(params.resultTime).toBe(2000n);
		expect(params.unlockTime).toBe(3000n);
		expect(params.externalDisputeUnlockTime).toBe(4000n);
	});

	it('uses the resolved buyerReturnAddress argument, not the raw request field', () => {
		const params = buildL2LockDatumParams({
			...baseArgs,
			request: { ...request, buyerReturnAddress: null },
			buyerReturnAddress: 'addr_collection_fallback',
		});
		expect(params.buyerReturnAddress).toBe('addr_collection_fallback');
	});
});

describe('selectInHeadFundingUtxos', () => {
	const SPLITTER = 5_000_000n;
	const MIN_CHANGE = 2_000_000n;
	const TOKEN = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d';
	const ada = (n: bigint) => ({ unit: 'lovelace', quantity: n.toString() });
	const asset = (unit: string, n: bigint) => ({ unit, quantity: n.toString() });
	const utxo = (
		idx: number,
		amount: Array<{ unit: string; quantity: string }>,
		plutusData?: string,
	): L2FundingUtxo => ({
		input: { txHash: `tx${idx}`, outputIndex: idx },
		output: { address: 'addr_buyer', amount, plutusData: plutusData ?? null },
	});
	const lovelacePaid = (n: bigint) => [{ unit: '', amount: n }];

	it('selects a single pure-ADA UTxO that covers lock + splitter + change', () => {
		const utxos = [utxo(0, [ada(20_000_000n)])];
		const selected = selectInHeadFundingUtxos(utxos, lovelacePaid(5_000_000n), SPLITTER, MIN_CHANGE);
		expect(selected).toHaveLength(1);
		expect(selected[0].input.txHash).toBe('tx0');
	});

	it('selects an asset-carrying UTxO for an ADA payment (faucet token no longer disqualifies it)', () => {
		// The buyer's only funds ride on a UTxO that also carries a faucet token.
		const utxos = [utxo(0, [ada(20_000_000n), asset(TOKEN, 1_000_000_000n)])];
		const selected = selectInHeadFundingUtxos(utxos, lovelacePaid(5_000_000n), SPLITTER, MIN_CHANGE);
		expect(selected).toHaveLength(1);
		expect(selected[0].input.txHash).toBe('tx0');
	});

	it('pulls the token-bearing UTxO when the payment itself is in a native token', () => {
		const pureAda = utxo(0, [ada(20_000_000n)]);
		const tokenUtxo = utxo(1, [ada(3_000_000n), asset(TOKEN, 100n)]);
		const selected = selectInHeadFundingUtxos(
			[pureAda, tokenUtxo],
			[
				{ unit: TOKEN, amount: 100n },
				{ unit: '', amount: 5_000_000n },
			],
			SPLITTER,
			MIN_CHANGE,
		);
		const hashes = selected.map((u) => u.input.txHash);
		expect(hashes).toContain('tx1'); // the token UTxO must be selected to cover the token
	});

	it('combines multiple small UTxOs to reach the target (any UTxO form)', () => {
		const utxos = [utxo(0, [ada(4_000_000n)]), utxo(1, [ada(5_000_000n)]), utxo(2, [ada(6_000_000n)])];
		// need 5 + 5 + 2 = 12 ADA; largest-first: 6 + 5 = 11 (<12) + 4 = 15 (>=12)
		const selected = selectInHeadFundingUtxos(utxos, lovelacePaid(5_000_000n), SPLITTER, MIN_CHANGE);
		expect(selected).toHaveLength(3);
	});

	it('ignores script (plutusData) UTxOs — they are escrow outputs, not spendable', () => {
		const utxos = [utxo(0, [ada(50_000_000n)], 'd8799fff')];
		expect(() => selectInHeadFundingUtxos(utxos, lovelacePaid(5_000_000n), SPLITTER, MIN_CHANGE)).toThrow(
			/no spendable/i,
		);
	});

	it('throws with the lovelace shortfall when ADA is insufficient', () => {
		const utxos = [utxo(0, [ada(5_000_000n)])]; // needs 12 ADA
		expect(() => selectInHeadFundingUtxos(utxos, lovelacePaid(5_000_000n), SPLITTER, MIN_CHANGE)).toThrow(
			/insufficient in-head funds/i,
		);
	});

	it('throws when a required token is not present in any UTxO', () => {
		const utxos = [utxo(0, [ada(50_000_000n)])];
		expect(() =>
			selectInHeadFundingUtxos(
				utxos,
				[
					{ unit: TOKEN, amount: 100n },
					{ unit: '', amount: 5_000_000n },
				],
				SPLITTER,
				MIN_CHANGE,
			),
		).toThrow(/insufficient in-head funds/i);
	});
});
