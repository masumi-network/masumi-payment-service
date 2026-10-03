import { describe, expect, it } from '@jest/globals';
import type { UTxO } from '@meshsdk/core';
import type { WalletDatum } from '../../../smart-wallet/wallet';
import { agentCanFundGuardedLock, guardedSpendableLovelace, isGuardedBudgetBound } from './guarded-packing';

const ADA = 1_000_000n;
const PERIOD_START = 1_000_000n;
const PERIOD_LENGTH = 86_400_000n;

function lovelaceValue(quantity: bigint) {
	return new Map([['', new Map([['', quantity]])]]);
}

function datum(overrides: Partial<WalletDatum> = {}): WalletDatum {
	return {
		agent: 'a'.repeat(56),
		limit: lovelaceValue(1_000n * ADA),
		periodLength: PERIOD_LENGTH,
		periodStart: PERIOD_START,
		spentInPeriod: lovelaceValue(0n),
		minBalanceLovelace: 5n * ADA,
		...overrides,
	};
}

function utxo(lovelace: bigint, index = 0): UTxO {
	return {
		input: { txHash: 'b'.repeat(64), outputIndex: index },
		output: { address: 'addr_test1', amount: [{ unit: 'lovelace', quantity: lovelace.toString() }] },
	};
}

const IN_PERIOD = PERIOD_START + 1n;
const AFTER_PERIOD = PERIOD_START + PERIOD_LENGTH;

describe('guardedSpendableLovelace', () => {
	it('is capped by the balance above the reserve', () => {
		expect(guardedSpendableLovelace(datum(), utxo(200n * ADA), IN_PERIOD, 0n)).toBe(195n * ADA);
	});

	it('is capped by the budget left in the period', () => {
		const spent = datum({ spentInPeriod: lovelaceValue(990n * ADA) });
		expect(guardedSpendableLovelace(spent, utxo(200n * ADA), IN_PERIOD, 0n)).toBe(10n * ADA);
	});

	it('counts the full limit again once the window starts after the period', () => {
		const spent = datum({ spentInPeriod: lovelaceValue(1_000n * ADA), limit: lovelaceValue(50n * ADA) });
		expect(guardedSpendableLovelace(spent, utxo(200n * ADA), AFTER_PERIOD, 0n)).toBe(50n * ADA);
	});

	it('still charges the old period when the window starts before its end', () => {
		const spent = datum({ spentInPeriod: lovelaceValue(1_000n * ADA) });
		expect(guardedSpendableLovelace(spent, utxo(200n * ADA), AFTER_PERIOD - 1n, 0n)).toBe(0n);
	});

	it('never goes negative below the reserve', () => {
		expect(guardedSpendableLovelace(datum(), utxo(3n * ADA), IN_PERIOD, 0n)).toBe(0n);
	});

	it('keeps the continuing output min-UTxO when it is above the datum reserve', () => {
		const noReserve = datum({ minBalanceLovelace: 0n });
		expect(guardedSpendableLovelace(noReserve, utxo(10n * ADA), IN_PERIOD, 2n * ADA)).toBe(8n * ADA);
	});

	it('treats a wallet without a lovelace limit as frozen', () => {
		expect(guardedSpendableLovelace(datum({ limit: new Map() }), utxo(200n * ADA), IN_PERIOD, 0n)).toBe(0n);
	});
});

describe('agentCanFundGuardedLock', () => {
	it('needs a UTxO the builder accepts as collateral', () => {
		expect(agentCanFundGuardedLock([utxo(2n * ADA)])).toBe(false);
		expect(agentCanFundGuardedLock([utxo(10n * ADA)])).toBe(true);
	});
});

describe('isGuardedBudgetBound', () => {
	it('is true while a partly used budget holds back a funded wallet', () => {
		const spent = datum({ spentInPeriod: lovelaceValue(990n * ADA) });
		expect(isGuardedBudgetBound(spent, utxo(200n * ADA), IN_PERIOD, 0n)).toBe(true);
	});

	it('is false when the balance, not the budget, is short', () => {
		const spent = datum({ spentInPeriod: lovelaceValue(990n * ADA) });
		expect(isGuardedBudgetBound(spent, utxo(12n * ADA), IN_PERIOD, 0n)).toBe(false);
	});

	it('is false for an unused budget and for a frozen wallet', () => {
		expect(isGuardedBudgetBound(datum(), utxo(2_000n * ADA), IN_PERIOD, 0n)).toBe(false);
		expect(isGuardedBudgetBound(datum({ limit: new Map() }), utxo(200n * ADA), IN_PERIOD, 0n)).toBe(false);
	});
});
