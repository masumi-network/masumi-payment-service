/**
 * A frame that names someone else's head must not be read as an attack on ours.
 *
 * The pinned-head check exists because a frame carrying a different head id is
 * normally evidence the socket is bound to the wrong node. `IgnoredHeadInitializing`
 * is the exception the check could not survive: it is the node saying it saw
 * ANOTHER head being initialized and declined to join, so the id it carries is
 * the ignored head's and the mismatch is the ordinary case.
 *
 * The cost of getting this wrong is total. On the history socket the throw fails
 * the replay, and history replays from the beginning on every reconnect — so the
 * frame is rejected forever, the head never gets a verified session, and every
 * L2 escrow operation on it fails closed. On the live socket it clears the
 * session, the party verification, the head clock and every held-back deposit
 * and decommit outcome.
 */

import { describe, expect, it } from '@jest/globals';
import { assertExpectedFrameHeadId, readDecommitSettled } from './node-frames';

const OURS = 'a'.repeat(56);
const THEIRS = 'b'.repeat(56);

describe('assertExpectedFrameHeadId', () => {
	it('accepts a foreign head id on the frame that reports one', () => {
		expect(() => assertExpectedFrameHeadId({ tag: 'IgnoredHeadInitializing', headId: THEIRS }, OURS)).not.toThrow();
	});

	it('still rejects a foreign head id on a frame that speaks for our head', () => {
		expect(() => assertExpectedFrameHeadId({ tag: 'SnapshotConfirmed', headId: THEIRS }, OURS)).toThrow(
			/did not match the pinned head/,
		);
	});

	it('still requires our own frames to name a head at all', () => {
		expect(() => assertExpectedFrameHeadId({ tag: 'HeadIsOpen' }, OURS)).toThrow(/omitted its head identifier/);
	});
});

describe('readDecommitSettled', () => {
	// The schema checks the cborHex is hex of a plausible length, not that it
	// decodes — and this reader runs inside the replay, where a throw is permanent.
	it('drops an undecodable DecommitInvalid rather than failing the replay', () => {
		const outcome = readDecommitSettled('DecommitInvalid', {
			tag: 'DecommitInvalid',
			headId: OURS,
			decommitTx: { txId: 'cd'.repeat(32), type: 'Tx ConwayEra', description: '', cborHex: 'ff'.repeat(64) },
			decommitInvalidReason: { tag: 'DecommitTxInvalid' },
		});

		expect(outcome).toBeUndefined();
	});
});
