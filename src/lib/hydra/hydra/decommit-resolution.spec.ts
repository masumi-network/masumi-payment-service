/**
 * A decommit transaction has to reach the conservation walk exactly once.
 *
 * Not zero times — then a legitimate withdrawal reads as value vanishing. And
 * not twice: the partition that names it is carried by every snapshot signed
 * while the L1 decrement settles, and re-applying a transaction whose inputs
 * the previous state no longer holds fails the transition, which fails the
 * whole history, which leaves every L2 escrow operation failing closed against
 * a head that is up and Open.
 */

import { describe, expect, it } from '@jest/globals';
import { resolveNewlyDeclaredDecommitTransactions } from './decommit-resolution';
import { HydraTransactionType, type HydraTransaction } from './types';

const DECOMMIT_TX_ID = 'ab'.repeat(32);
const OTHER_TX_ID = 'cd'.repeat(32);

const decommitTx: HydraTransaction = {
	txId: DECOMMIT_TX_ID,
	cborHex: '00',
	type: HydraTransactionType.TxConwayEra,
	description: 'decommit',
};

function lookup(txId: string): HydraTransaction | undefined {
	return txId === DECOMMIT_TX_ID ? decommitTx : undefined;
}

/** A previous snapshot's canonical references; only membership is read. */
function outputs(...references: string[]): Map<string, string> {
	return new Map(references.map((reference) => [reference, 'output']));
}

describe('resolveNewlyDeclaredDecommitTransactions', () => {
	it('supplies the transaction on the transition that first declares the decommit', () => {
		const resolved = resolveNewlyDeclaredDecommitTransactions(
			[`${DECOMMIT_TX_ID}#0`],
			outputs(`${OTHER_TX_ID}#0`),
			lookup,
		);
		expect(resolved).toEqual([decommitTx]);
	});

	// The defect this exists for. A decommit stays pending for minutes, so the
	// same partition arrives on every snapshot in between.
	it('supplies nothing while the same decommit stays pending', () => {
		const resolved = resolveNewlyDeclaredDecommitTransactions(
			[`${DECOMMIT_TX_ID}#0`],
			outputs(`${OTHER_TX_ID}#0`, `${DECOMMIT_TX_ID}#0`),
			lookup,
		);
		expect(resolved).toEqual([]);
	});

	it('supplies a multi-output decommit once, not once per output', () => {
		const resolved = resolveNewlyDeclaredDecommitTransactions(
			[`${DECOMMIT_TX_ID}#0`, `${DECOMMIT_TX_ID}#1`],
			outputs(),
			lookup,
		);
		expect(resolved).toEqual([decommitTx]);
	});

	// Case references are not normalised by the node, and a reference that
	// compares unequal only by case would look new on every single snapshot.
	it('matches a previously declared reference regardless of case', () => {
		const resolved = resolveNewlyDeclaredDecommitTransactions(
			[`${DECOMMIT_TX_ID.toUpperCase()}#0`],
			outputs(`${DECOMMIT_TX_ID}#0`),
			lookup,
		);
		expect(resolved).toEqual([]);
	});

	// The transaction is only ever taken from what the signed state names, so a
	// decommit whose `DecommitRequested` frame was never seen contributes
	// nothing rather than something unauthenticated.
	it('supplies nothing for a decommit whose transaction was never seen', () => {
		const resolved = resolveNewlyDeclaredDecommitTransactions([`${OTHER_TX_ID}#0`], outputs(), lookup);
		expect(resolved).toEqual([]);
	});

	it('ignores a malformed reference rather than treating it as a transaction id', () => {
		const resolved = resolveNewlyDeclaredDecommitTransactions(['#0', '', DECOMMIT_TX_ID], outputs(), lookup);
		expect(resolved).toEqual([]);
	});
});
