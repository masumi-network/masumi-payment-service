import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Connection } from './connection';
import type { ConfirmedTransactionLedger } from './node-confirmed-ledger';
import type { HydraHistoryReplay as HydraHistoryReplayType } from './node-history-replay';

const mockWarn = jest.fn();
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { debug: jest.fn(), info: jest.fn(), warn: mockWarn, error: jest.fn() },
}));

const { HydraHistoryReplay } = await import('./node-history-replay');

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
		setNetworkConnected: (_connected: boolean): void => undefined,
		recordFinalizedFanout: () => undefined,
		recordPartialFanout: () => undefined,
		rememberReplayedDeposit: () => undefined,
		rememberReplayedDecommit: () => undefined,
		emitTxConfirmed: () => undefined,
		onProtocolDrift: () => undefined,
		onRotationReplayFailure: () => undefined,
		onReplayFailed: () => undefined,
	};

	const ledger = { trim: () => undefined, hasUnreconciled: false } as unknown as ConfirmedTransactionLedger;

	let replay: HydraHistoryReplayType;
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

describe('HydraHistoryReplay slow-work reporting', () => {
	beforeEach(() => {
		mockWarn.mockClear();
	});

	const NETWORK_CONNECTED_FRAME = JSON.stringify({ tag: 'NetworkConnected' });

	/** A replay whose frame handling advances a fake clock by `costMs` per frame. */
	function createTimedReplay(costMs: number) {
		let clockMs = 1_000_000;
		const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => clockMs);
		const created = createReplay();
		created.host.setNetworkConnected = () => {
			clockMs += costMs;
		};
		return {
			...created,
			warnSpy: mockWarn,
			restore: () => nowSpy.mockRestore(),
		};
	}

	it('reports one pinned frame that held the event loop', () => {
		const { replay, host, warnSpy, restore } = createTimedReplay(2_500);
		host.expectedHeadId = PINNED_HEAD_ID;
		replay.processMessage(NETWORK_CONNECTED_FRAME);
		restore();
		expect(warnSpy).toHaveBeenCalledWith(
			'[HydraNode] One history frame held the event loop',
			expect.objectContaining({ headId: PINNED_HEAD_ID, elapsedMs: 2_500 }),
		);
	});

	// Worked through back to back, a long history starved every timer and socket
	// in the process: database pool connects timed out and every job failed.
	it('yields to the event loop once a slice of frames has spent its budget', async () => {
		let processed = 0;
		const { replay, host, restore } = createTimedReplay(40);
		const advance = host.setNetworkConnected;
		host.setNetworkConnected = (connected) => {
			processed += 1;
			advance(connected);
		};
		for (let index = 0; index < 5; index += 1) replay.processMessage(NETWORK_CONNECTED_FRAME);
		host.expectedHeadId = PINNED_HEAD_ID;
		replay.processBufferedUnpinnedFrames();

		// 40 ms each against a 50 ms budget: two frames, then a yield.
		expect(processed).toBe(2);
		await new Promise((resolve) => setImmediate(resolve));
		expect(processed).toBe(4);
		await new Promise((resolve) => setImmediate(resolve));
		expect(processed).toBe(5);
		restore();
		expect(mockWarn).not.toHaveBeenCalled();
	});

	it('stays quiet for fast frames', () => {
		const { replay, host, warnSpy, restore } = createTimedReplay(5);
		host.expectedHeadId = PINNED_HEAD_ID;
		replay.processMessage(NETWORK_CONNECTED_FRAME);
		replay.processMessage(NETWORK_CONNECTED_FRAME);
		restore();
		expect(warnSpy).not.toHaveBeenCalled();
	});
});
