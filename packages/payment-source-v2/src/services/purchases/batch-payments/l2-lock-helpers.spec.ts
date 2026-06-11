import { describe, it, expect } from '@jest/globals';
import { SmartContractState } from '@masumi/payment-core/smart-contract-state';
import {
	buildL2LockDatumParams,
	mapPaidFundsToAssets,
	resolveL2BuyerReturnAddress,
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
