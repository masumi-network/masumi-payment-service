import { describe, expect, it } from '@jest/globals';
import type { UTxO } from '@meshsdk/core';
import type { WalletDatum } from '../../../smart-wallet/wallet';
import { agentCanFundGuardedLock, guardedSpendableLovelace } from './guarded-packing';

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
		expect(guardedSpendableLovelace(datum(), utxo(200n * ADA), IN_PERIOD)).toBe(195n * ADA);
	});

	it('is capped by the budget left in the period', () => {
		const spent = datum({ spentInPeriod: lovelaceValue(990n * ADA) });
		expect(guardedSpendableLovelace(spent, utxo(200n * ADA), IN_PERIOD)).toBe(10n * ADA);
	});

	it('counts the full limit again once the window starts after the period', () => {
		const spent = datum({ spentInPeriod: lovelaceValue(1_000n * ADA), limit: lovelaceValue(50n * ADA) });
		expect(guardedSpendableLovelace(spent, utxo(200n * ADA), AFTER_PERIOD)).toBe(50n * ADA);
	});

	it('still charges the old period when the window starts before its end', () => {
		const spent = datum({ spentInPeriod: lovelaceValue(1_000n * ADA) });
		expect(guardedSpendableLovelace(spent, utxo(200n * ADA), AFTER_PERIOD - 1n)).toBe(0n);
	});

	it('never goes negative below the reserve', () => {
		expect(guardedSpendableLovelace(datum(), utxo(3n * ADA), IN_PERIOD)).toBe(0n);
	});

	it('treats a wallet without a lovelace limit as frozen', () => {
		expect(guardedSpendableLovelace(datum({ limit: new Map() }), utxo(200n * ADA), IN_PERIOD)).toBe(0n);
	});
});

describe('agentCanFundGuardedLock', () => {
	it('needs a UTxO the builder accepts as collateral', () => {
		expect(agentCanFundGuardedLock([utxo(2n * ADA)])).toBe(false);
		expect(agentCanFundGuardedLock([utxo(10n * ADA)])).toBe(true);
	});
});
