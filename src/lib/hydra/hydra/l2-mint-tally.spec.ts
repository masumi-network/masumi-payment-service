import { describe, expect, it } from '@jest/globals';

import { recordL2TransactionMints } from './l2-mint-tally';
import { HydraTransactionType } from './types';

const POLICY = 'ab'.repeat(28);

/** A Conway transaction (one input, one 1 ADA output, zero fee) whose mint field is the CBOR map `mintHex`. */
function transactionWithMint(mintHex: string) {
	const output = `82581d61${'cd'.repeat(28)}1a000f4240`;
	const body = `a40081825820${'11'.repeat(32)}000181${output}020009${mintHex}`;
	return { type: HydraTransactionType.TxConwayEra, cborHex: `84${body}a0f5f6`, description: '' };
}

describe('recordL2TransactionMints', () => {
	// CSL lists a repeated policy key once per entry, and `get` returns every
	// group for that key on each lookup. Walking every key counted each group
	// once per repeat.
	it('counts each mint group once when a policy key repeats', () => {
		const tally = new Map<string, bigint>();
		// {P: {"a": 1}, P: {"b": 2}}
		const mint = `a2581c${POLICY}a1416101581c${POLICY}a1416202`;

		recordL2TransactionMints(tally, [transactionWithMint(mint)], 1);

		expect(tally).toEqual(
			new Map([
				[`${POLICY}61`, 1n],
				[`${POLICY}62`, 2n],
			]),
		);
	});
});
