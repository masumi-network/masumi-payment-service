import { describe, it, expect } from '@jest/globals';
import { OnChainState } from '@/generated/prisma/client';
import { SmartContractState } from '@masumi/payment-core/smart-contract-state';
import type { DecodedV1ContractDatum } from '@/utils/converter/string-datum-convert';
import {
	datumMatchesRequest,
	smartContractStateToOnChainState,
	validateL2InitialLock,
	type ReconcileMatchFields,
} from './index';

describe('smartContractStateToOnChainState', () => {
	it('maps every live contract state 1:1', () => {
		expect(smartContractStateToOnChainState(SmartContractState.FundsLocked)).toBe(OnChainState.FundsLocked);
		expect(smartContractStateToOnChainState(SmartContractState.ResultSubmitted)).toBe(OnChainState.ResultSubmitted);
		expect(smartContractStateToOnChainState(SmartContractState.RefundRequested)).toBe(OnChainState.RefundRequested);
		expect(smartContractStateToOnChainState(SmartContractState.Disputed)).toBe(OnChainState.Disputed);
		expect(smartContractStateToOnChainState(SmartContractState.WithdrawAuthorized)).toBe(
			OnChainState.WithdrawAuthorized,
		);
		expect(smartContractStateToOnChainState(SmartContractState.RefundAuthorized)).toBe(OnChainState.RefundAuthorized);
	});

	it('returns null for an unknown state (no datum → terminal/invalid)', () => {
		expect(smartContractStateToOnChainState(999 as SmartContractState)).toBeNull();
	});

	it('does NOT fold FundsLocked+resultHash into ResultSubmitted (strict on state)', () => {
		// The fold is deliberately absent here; a FundsLocked datum maps to
		// FundsLocked regardless of resultHash. validateL2InitialLock catches the
		// spoof separately.
		expect(smartContractStateToOnChainState(SmartContractState.FundsLocked)).toBe(OnChainState.FundsLocked);
	});
});

describe('datumMatchesRequest', () => {
	const decoded = {
		inputHash: 'aa',
		resultTime: 100n,
		unlockTime: 200n,
		externalDisputeUnlockTime: 300n,
		payByTime: 50n,
		buyerAddress: 'addr-buyer',
		sellerAddress: 'addr-seller',
		buyerReturnAddress: 'addr-buyer-return',
		sellerReturnAddress: 'addr-seller-return',
		buyerVkey: 'buyer-vkey',
		sellerVkey: 'seller-vkey',
	} as unknown as DecodedV1ContractDatum;

	const request: ReconcileMatchFields = {
		inputHash: 'aa',
		submitResultTime: 100n,
		unlockTime: 200n,
		externalDisputeUnlockTime: 300n,
		payByTime: 50n,
		buyerAddress: 'addr-buyer',
		sellerAddress: 'addr-seller',
		buyerReturnAddress: 'addr-buyer-return',
		sellerReturnAddress: 'addr-seller-return',
		buyerVkey: 'buyer-vkey',
		sellerVkey: 'seller-vkey',
	};

	it('matches when every field agrees (state deliberately not checked)', () => {
		expect(datumMatchesRequest(decoded, request)).toBe(true);
	});

	it('accepts a null request.payByTime as "unknown" (does not force datum===0)', () => {
		// Legacy pre-backfill rows have payByTime IS NULL; a real datum has a
		// non-zero payByTime, so forcing equality with 0 would wrongly block them.
		expect(datumMatchesRequest(decoded, { ...request, payByTime: null })).toBe(true);
	});

	it('still compares payByTime when the request carries it', () => {
		expect(datumMatchesRequest(decoded, { ...request, payByTime: 51n })).toBe(false);
	});

	it('rejects on inputHash mismatch', () => {
		expect(datumMatchesRequest(decoded, { ...request, inputHash: 'bb' })).toBe(false);
	});

	it('rejects on a time-field mismatch', () => {
		expect(datumMatchesRequest(decoded, { ...request, submitResultTime: 101n })).toBe(false);
		expect(datumMatchesRequest(decoded, { ...request, unlockTime: 201n })).toBe(false);
		expect(datumMatchesRequest(decoded, { ...request, externalDisputeUnlockTime: 301n })).toBe(false);
	});

	it('rejects on a party-vkey mismatch (spoofing guard)', () => {
		expect(datumMatchesRequest(decoded, { ...request, buyerVkey: 'other' })).toBe(false);
		expect(datumMatchesRequest(decoded, { ...request, sellerVkey: 'other' })).toBe(false);
	});

	it('rejects changed participant and payout addresses', () => {
		expect(datumMatchesRequest(decoded, { ...request, buyerAddress: 'other' })).toBe(false);
		expect(datumMatchesRequest(decoded, { ...request, sellerAddress: 'other' })).toBe(false);
		expect(datumMatchesRequest(decoded, { ...request, buyerReturnAddress: 'other' })).toBe(false);
		expect(datumMatchesRequest(decoded, { ...request, sellerReturnAddress: 'other' })).toBe(false);
	});

	it('checks a stored null return address but permits an explicitly unknown one', () => {
		expect(datumMatchesRequest(decoded, { ...request, buyerReturnAddress: null })).toBe(false);
		expect(datumMatchesRequest(decoded, { ...request, buyerReturnAddress: undefined })).toBe(true);
	});

	it('skips the vkey check when the request vkey is null (unknown, not mismatch)', () => {
		// L2-native lock path leaves payment.BuyerWallet (→ buyerVkey) null; a null
		// vkey means "unknown" and must NOT block reconciliation (mirrors L1).
		expect(datumMatchesRequest(decoded, { ...request, buyerVkey: null })).toBe(true);
		expect(datumMatchesRequest(decoded, { ...request, sellerVkey: null })).toBe(true);
		expect(datumMatchesRequest(decoded, { ...request, buyerVkey: null, sellerVkey: null })).toBe(true);
	});
});

describe('validateL2InitialLock', () => {
	const decoded = {
		resultHash: null,
		buyerCooldownTime: 0n,
		sellerCooldownTime: 0n,
		collateralReturnLovelace: 0n,
		payByTime: 1_000n,
	} as unknown as DecodedV1ContractDatum;

	const expectedFunds = [{ unit: 'lovelace', amount: 10_000_000n }];
	const outputAmounts = [{ unit: 'lovelace', quantity: '10000000' }];

	it('accepts a well-formed initial lock (correct amount, no resultHash, zero cooldowns)', () => {
		expect(validateL2InitialLock(decoded, expectedFunds, outputAmounts, 999n)).toEqual({
			valid: true,
			errorNote: null,
		});
	});

	it('rejects an underfunded lock', () => {
		const result = validateL2InitialLock(decoded, expectedFunds, [{ unit: 'lovelace', quantity: '9000000' }], 999n);
		expect(result.valid).toBe(false);
		expect(result.errorNote).toContain('Payment amounts do not match');
	});

	it('rejects collateralReturnLovelace greater than the locked ADA (bricks the seller)', () => {
		const bricking = { ...decoded, collateralReturnLovelace: 20_000_000n } as unknown as DecodedV1ContractDatum;
		expect(validateL2InitialLock(bricking, expectedFunds, outputAmounts, 999n).valid).toBe(false);
	});

	it('rejects a resultHash set on an initial lock (the FundsLocked+resultHash spoof)', () => {
		const withHash = { ...decoded, resultHash: 'deadbeef' } as unknown as DecodedV1ContractDatum;
		const result = validateL2InitialLock(withHash, expectedFunds, outputAmounts, 999n);
		expect(result.valid).toBe(false);
		expect(result.errorNote).toContain('Result hash was set');
	});

	it('rejects non-zero cooldown times', () => {
		const buyerCd = { ...decoded, buyerCooldownTime: 5n } as unknown as DecodedV1ContractDatum;
		const sellerCd = { ...decoded, sellerCooldownTime: 5n } as unknown as DecodedV1ContractDatum;
		expect(validateL2InitialLock(buyerCd, expectedFunds, outputAmounts, 999n).valid).toBe(false);
		expect(validateL2InitialLock(sellerCd, expectedFunds, outputAmounts, 999n).valid).toBe(false);
	});

	it('rejects a mismatched token count', () => {
		const withToken = [
			{ unit: 'lovelace', quantity: '10000000' },
			{ unit: 'policy.tok', quantity: '1' },
		];
		const result = validateL2InitialLock(decoded, expectedFunds, withToken, 999n);
		expect(result.valid).toBe(false);
		expect(result.errorNote).toContain('Token counts do not match');
	});

	it('does not mutate the caller-supplied arrays', () => {
		const funds = [{ unit: 'lovelace', amount: 10_000_000n }];
		const out = [{ unit: 'lovelace', quantity: '10000000' }];
		validateL2InitialLock(decoded, funds, out, 999n);
		expect(funds[0].unit).toBe('lovelace');
		expect(out[0].unit).toBe('lovelace');
	});

	it('rejects a lock confirmed after payByTime or without a trustworthy confirmation time', () => {
		expect(validateL2InitialLock(decoded, expectedFunds, outputAmounts, 1_001n).errorNote).toContain(
			'confirmed after payByTime',
		);
		expect(validateL2InitialLock(decoded, expectedFunds, outputAmounts, null).errorNote).toContain(
			'confirmation time is unavailable',
		);
	});
});
