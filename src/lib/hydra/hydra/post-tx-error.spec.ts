/**
 * A refusal reason the node names must stay a string.
 *
 * The tag is node-supplied and the explanation table was a plain object, so
 * `EXPLANATIONS['toString']` answered with a function — which `??` does not
 * catch, because a function is not nullish. It was returned through a `string`
 * signature into `HydraDecommit.failureReason`, Prisma refused to write it, the
 * refusal was never recorded, and the withdrawal stayed Pending — which is the
 * state that makes every later withdrawal for that participant refuse because
 * one is "still settling". The same reader runs on the replay path, so it
 * recurred on every reconnect.
 */

import { describe, expect, it } from '@jest/globals';
import { describeDecommitInvalidReason, describePostTxError, postTxErrorTag } from './post-tx-error';

describe('describePostTxError', () => {
	it('explains a tag it knows', () => {
		expect(describePostTxError({ tag: 'NoSeedInput' })).not.toBe('NoSeedInput');
		expect(typeof describePostTxError({ tag: 'NoSeedInput' })).toBe('string');
	});

	it('falls through to the tag itself for one it does not', () => {
		expect(describePostTxError({ tag: 'SomethingNew' })).toBe('SomethingNew');
	});

	it.each(['toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty'])(
		'returns the tag itself for %s rather than an inherited member',
		(inherited) => {
			expect(describePostTxError({ tag: inherited })).toBe(inherited);
			expect(describeDecommitInvalidReason({ tag: inherited })).toBe(inherited);
		},
	);

	// The tag says what kind of failure; the node's own reason says which rule
	// broke. Dropping it left a failed contest with nothing an operator could act on.
	it("keeps the node's own reason next to the explanation", () => {
		expect(describePostTxError({ tag: 'FailedToPostTx', failureReason: 'BadInputsUTxO' })).toBe(
			'FailedToPostTx: the chain backend refused the transaction (BadInputsUTxO)',
		);
		expect(describePostTxError({ tag: 'InternalWalletError', reason: 'no change output' })).toContain(
			'(no change output)',
		);
		expect(describePostTxError({ tag: 'FailedToPostTx', failureReason: 42 })).toBe(
			'FailedToPostTx: the chain backend refused the transaction',
		);
	});

	it('explains the fuel tag in the spelling hydra-node sends', () => {
		expect(describePostTxError({ tag: 'NoFuelUTXOFound' })).toContain('Fund the node');
	});

	it('still reads a tag the node did put there', () => {
		expect(postTxErrorTag({ tag: 'NoSeedInput' })).toBe('NoSeedInput');
		expect(postTxErrorTag({})).toBeNull();
	});
});
