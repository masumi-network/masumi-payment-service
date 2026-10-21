import { FixedTransaction } from '@emurgo/cardano-serialization-lib-nodejs';
import { describe, expect, it } from '@jest/globals';

import { recordL2TransactionMints, type L2MintTally } from './l2-mint-tally';
import { HydraTransactionType } from './types';

const POLICY = 'ab'.repeat(28);
const MINT_A = `a1581c${POLICY}a1416101`; // {P: {"a": 1}}
const MINT_B = `a1581c${POLICY}a1416202`; // {P: {"b": 2}}
const BURN_A = `a1581c${POLICY}a1416120`; // {P: {"a": -1}}
const BURN_B = `a1581c${POLICY}a1416221`; // {P: {"b": -2}}

/**
 * A Conway transaction (one input, one 1 ADA output, zero fee) whose mint field
 * is the CBOR map `mintHex`. `inputSeed` makes otherwise equal transactions distinct.
 */
function transactionWithMint(mintHex: string, inputSeed = '11') {
	const output = `82581d61${'cd'.repeat(28)}1a000f4240`;
	const body = `a40081825820${inputSeed.repeat(32)}000181${output}020009${mintHex}`;
	return { type: HydraTransactionType.TxConwayEra, cborHex: `84${body}a0f5f6`, description: '' };
}

function hashOf(transaction: { cborHex: string }): string {
	return FixedTransaction.from_hex(transaction.cborHex).transaction_hash().to_hex();
}

function emptyTally(): L2MintTally {
	return { units: new Map() };
}

describe('recordL2TransactionMints', () => {
	// CSL lists a repeated policy key once per entry, and `get` returns every
	// group for that key on each lookup. Walking every key counted each group
	// once per repeat.
	it('counts each mint group once when a policy key repeats', () => {
		const tally = emptyTally();
		// {P: {"a": 1}, P: {"b": 2}}
		const mint = `a2581c${POLICY}a1416101581c${POLICY}a1416202`;

		recordL2TransactionMints(tally, [transactionWithMint(mint)], 1);

		expect(tally.units).toEqual(
			new Map([
				[`${POLICY}61`, 1n],
				[`${POLICY}62`, 2n],
			]),
		);
	});

	// The incident keys the operator record, so it has to name the transaction
	// that started the nonzero balance, stay put while the balance stays
	// nonzero, and start over only after the balance was back at zero.
	it('names the transaction that took the balance from zero', () => {
		const tally = emptyTally();
		const mintA = transactionWithMint(MINT_A, '11');
		const mintB = transactionWithMint(MINT_B, '12');

		recordL2TransactionMints(tally, [mintA, mintB], 1);
		const opened = tally.openedBy;
		expect(opened).toEqual({
			txHash: hashOf(mintA),
			snapshotNumber: 1,
			netUnits: { count: 2, sample: [`${POLICY}61 +1`, `${POLICY}62 +2`] },
		});

		recordL2TransactionMints(tally, [transactionWithMint(BURN_A, '13')], 2);
		expect(tally.openedBy).toBe(opened);

		recordL2TransactionMints(tally, [transactionWithMint(BURN_B, '14')], 3);
		expect(tally.openedBy).toBeUndefined();

		// Back at zero inside one snapshot, then nonzero again: a new incident.
		const reopen = transactionWithMint(MINT_B, '17');
		recordL2TransactionMints(tally, [transactionWithMint(MINT_A, '15'), transactionWithMint(BURN_A, '16'), reopen], 4);
		expect(tally.openedBy?.txHash).toBe(hashOf(reopen));
	});

	// Burning a committed L1 token leaves a negative net. That is not an
	// unburned mint, so the record must show the sign rather than call it one.
	it('keeps the sign of a burned committed token', () => {
		const tally = emptyTally();

		recordL2TransactionMints(tally, [transactionWithMint(BURN_A)], 1);

		expect(tally.openedBy?.netUnits.sample).toEqual([`${POLICY}61 -1`]);
	});
});
