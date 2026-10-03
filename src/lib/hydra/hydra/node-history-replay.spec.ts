import { describe, expect, it, jest } from '@jest/globals';
import type { Connection } from './connection';
import type { ConfirmedTransactionLedger } from './node-confirmed-ledger';
import { HydraHistoryReplay } from './node-history-replay';

/**
 * The flush of frames buffered before the head id was pinned.
 *
 * This is the one place the replay processes frames in a loop of its own rather
 * than one per socket event, so it is the one place a rejection has to stop
 * something. It could not: rejecting invalidates the socket, the socket's close
 * handler starts a fresh pass, and a fresh pass clears the failure flag the loop
 * was reading — all synchronously, inside the loop.
 */

const PINNED_HEAD_ID = 'a'.repeat(56);
const OTHER_HEAD_ID = 'b'.repeat(56);

function createReplay() {
	const verifyGreetingsPartyIdentity = jest.fn();
	const host = {
		expectedHeadId: undefined as string | undefined,
		trustLocalNodeSnapshotMetadata: true,
		persistenceRotationError: undefined,
		orderedSnapshotVerificationKeys: undefined,
		assertPersistenceReplayIsSupported: () => undefined,
		bindSnapshotPartyOrder: () => undefined,
		verifyGreetingsPartyIdentity,
		setNetworkConnected: () => undefined,
		recordFinalizedFanout: () => undefined,
		rememberReplayedDeposit: () => undefined,
		rememberReplayedDecommit: () => undefined,
		emitTxConfirmed: () => undefined,
		onProtocolDrift: () => undefined,
		onRotationReplayFailure: () => undefined,
		onReplayFailed: () => undefined,
	};

	const ledger = { trim: () => undefined, hasUnreconciled: false } as unknown as ConfirmedTransactionLedger;

	let replay: HydraHistoryReplay;
	const invalidate = jest.fn(() => {
		// What `HydraNode` wires up: the invalidated socket emits `close`
		// synchronously, and its handler starts a fresh pass.
		replay.resetPass();
	});
	const connection = { invalidate } as unknown as Connection;

	replay = new HydraHistoryReplay(connection, ledger, host);
	return { replay, host, invalidate, verifyGreetingsPartyIdentity };
}

describe('HydraHistoryReplay buffered flush', () => {
	it('stops at the first rejected frame instead of reading the rest as a fresh pass', () => {
		const { replay, host, invalidate, verifyGreetingsPartyIdentity } = createReplay();

		// Buffered: no head id is pinned yet, so nothing is judged.
		replay.processMessage(JSON.stringify({ tag: 'SnapshotConfirmed', headId: OTHER_HEAD_ID }));
		replay.processMessage(
			JSON.stringify({ tag: 'Greetings', headStatus: 'Open', headId: PINNED_HEAD_ID, snapshotUtxo: {} }),
		);

		host.expectedHeadId = PINNED_HEAD_ID;
		replay.processBufferedUnpinnedFrames();

		// The first frame names a different head, which is a rejection.
		expect(invalidate).toHaveBeenCalledTimes(1);
		// And the page's closing Greetings — the frame that would otherwise install
		// an anchor and mark the pass complete — is never reached.
		expect(verifyGreetingsPartyIdentity).not.toHaveBeenCalled();
		expect(replay.isComplete).toBe(false);
		expect(replay.sessionHeadId).toBeUndefined();
	});
});
