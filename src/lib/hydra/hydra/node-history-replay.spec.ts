import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Connection } from './connection';
import type { ConfirmedTransactionLedger } from './node-confirmed-ledger';
import type { HydraHistoryReplay as HydraHistoryReplayType } from './node-history-replay';
import { HydraProtocolError } from './errors';
import { MAX_HYDRA_WS_FRAME_BYTES } from './schemas';

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
const PRE_PIN_FRAME_LIMIT = 4_096;
const NETWORK_CONNECTED_FRAME = JSON.stringify({ tag: 'NetworkConnected' });

function createReplay() {
	const verifyGreetingsPartyIdentity = jest.fn();
	const onIdleWithoutFinalization = jest.fn();
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
		onIdleWithoutFinalization,
		onPassClosed: jest.fn(),
		rememberReplayedDeposit: () => undefined,
		rememberReplayedDecommit: () => undefined,
		emitTxConfirmed: () => undefined,
		reportL2MintOutstanding: () => undefined,
		onProtocolDrift: () => undefined,
		onRotationReplayFailure: () => undefined,
		onReplayFailed: () => undefined,
	};

	const ledger = { trim: () => undefined, hasUnreconciled: false } as unknown as ConfirmedTransactionLedger;

	let replay: HydraHistoryReplayType;
	const invalidate = jest.fn<Connection['invalidate']>(() => {
		// What `HydraNode` wires up: the invalidated socket emits `close`
		// synchronously, and its handler starts a fresh pass.
		replay.resetPass();
	});
	const connection = { invalidate } as unknown as Connection;

	replay = new HydraHistoryReplay(connection, ledger, host);
	return { replay, host, invalidate, verifyGreetingsPartyIdentity, onIdleWithoutFinalization };
}

describe('HydraHistoryReplay buffered flush', () => {
	it('exhausts the pre-pin frame count below the byte bound and starts the next pass empty', () => {
		const { replay, host, invalidate } = createReplay();
		// Keep the failed pass visible until the transport closes it.
		invalidate.mockImplementationOnce(() => undefined);
		for (let index = 0; index < PRE_PIN_FRAME_LIMIT; index += 1) replay.processMessage(NETWORK_CONNECTED_FRAME);
		expect(invalidate).not.toHaveBeenCalled();
		expect(Buffer.byteLength(NETWORK_CONNECTED_FRAME) * (PRE_PIN_FRAME_LIMIT + 1)).toBeLessThan(8 * 1024 * 1024);

		replay.processMessage(NETWORK_CONNECTED_FRAME);
		expect(invalidate).toHaveBeenCalledWith(expect.any(HydraProtocolError));
		expect(replay.isFailed).toBe(true);
		expect(replay.isComplete).toBe(false);
		expect(replay.error?.message).toMatch(/bounded buffer/);
		replay.processMessage(NETWORK_CONNECTED_FRAME);
		expect(invalidate).toHaveBeenCalledTimes(1);

		const connected = jest.fn();
		host.setNetworkConnected = connected;
		host.expectedHeadId = PINNED_HEAD_ID;
		replay.processBufferedUnpinnedFrames();
		expect(connected).not.toHaveBeenCalled();

		// Socket close resets the count, not just the failure flag.
		replay.resetPass();
		host.expectedHeadId = undefined;
		for (let index = 0; index < PRE_PIN_FRAME_LIMIT; index += 1) replay.processMessage(NETWORK_CONNECTED_FRAME);
		expect(invalidate).toHaveBeenCalledTimes(1);
		replay.resetPass();
		replay.processMessage(NETWORK_CONNECTED_FRAME);
		host.expectedHeadId = PINNED_HEAD_ID;
		replay.processBufferedUnpinnedFrames();
		expect(connected).toHaveBeenCalledTimes(1);
	});

	it('still exhausts the pre-pin byte bound with only three maximum-size frames', () => {
		const { replay, invalidate } = createReplay();
		const maximumFrame = 'x'.repeat(MAX_HYDRA_WS_FRAME_BYTES);
		replay.processMessage(maximumFrame);
		replay.processMessage(maximumFrame);
		expect(invalidate).not.toHaveBeenCalled();
		replay.processMessage(maximumFrame);
		expect(invalidate).toHaveBeenCalledWith(expect.any(HydraProtocolError));
	});

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

// The contest watch compares this with the verified snapshot. A contest that is
// missed here reads as a gap that never closes; one kept across passes reads a
// stale chain state as current.
describe('HydraHistoryReplay closed snapshot number', () => {
	it('follows the newest close or contest, and starts over with each pass', () => {
		const { replay, host } = createReplay();
		host.expectedHeadId = PINNED_HEAD_ID;
		const deadline = '2026-10-22T12:00:00Z';
		replay.processMessage(
			JSON.stringify({
				tag: 'HeadIsClosed',
				headId: PINNED_HEAD_ID,
				snapshotNumber: 3,
				contestationDeadline: deadline,
			}),
		);
		expect(replay.closedSnapshotNumber).toBe(3);
		replay.processMessage(
			JSON.stringify({
				tag: 'HeadIsContested',
				headId: PINNED_HEAD_ID,
				snapshotNumber: 5,
				contestationDeadline: deadline,
			}),
		);
		expect(replay.closedSnapshotNumber).toBe(5);
		// The contest was rolled back. The next live chain observation names the
		// older Close again; the last observed state, not the largest number, wins.
		replay.processMessage(
			JSON.stringify({
				tag: 'HeadIsClosed',
				headId: PINNED_HEAD_ID,
				snapshotNumber: 3,
				contestationDeadline: deadline,
			}),
		);
		expect(replay.closedSnapshotNumber).toBe(3);
		replay.resetPass();
		expect(replay.closedSnapshotNumber).toBeUndefined();
	});
});

/**
 * hydra-node is Idle again once a head is finalized, so the history of a
 * finalized head closes with a Greetings that names no head. After a restart,
 * that history is the only proof the service can finish the fanout handoff on.
 */
describe('HydraHistoryReplay after a finalized head', () => {
	const FINALIZED_FRAME = JSON.stringify({ tag: 'HeadIsFinalized', headId: PINNED_HEAD_ID, finalizedUTxO: {} });
	const HEADLESS_IDLE_GREETINGS = JSON.stringify({ tag: 'Greetings', headStatus: 'Idle' });

	it('completes a pinned pass that closes Idle after finalizing the pinned head', () => {
		const { replay, host, invalidate, onIdleWithoutFinalization } = createReplay();
		host.expectedHeadId = PINNED_HEAD_ID;

		replay.processMessage(FINALIZED_FRAME);
		// Not proof yet: the pass has not accepted its Greetings.
		expect(replay.finalizedHeadId).toBeUndefined();
		replay.processMessage(HEADLESS_IDLE_GREETINGS);

		expect(invalidate).not.toHaveBeenCalled();
		expect(onIdleWithoutFinalization).not.toHaveBeenCalled();
		expect(host.onPassClosed).toHaveBeenCalledTimes(1);
		expect(replay.isComplete).toBe(true);
		expect(replay.sessionHeadId).toBe(PINNED_HEAD_ID);
		expect(replay.finalizedHeadId).toBe(PINNED_HEAD_ID);
	});

	it('fails a pinned pass that closes Idle without finalizing, and reports it', () => {
		const { replay, host, invalidate, onIdleWithoutFinalization } = createReplay();
		host.expectedHeadId = PINNED_HEAD_ID;

		replay.processMessage(JSON.stringify({ tag: 'HeadIsInitializing', headId: PINNED_HEAD_ID, parties: [] }));
		replay.processMessage(HEADLESS_IDLE_GREETINGS);

		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(onIdleWithoutFinalization).toHaveBeenCalledTimes(1);
		expect(host.onPassClosed).not.toHaveBeenCalled();
		expect(replay.isComplete).toBe(false);
		expect(replay.sessionHeadId).toBeUndefined();
	});

	it('does not carry a finalization into the next pass', () => {
		const { replay, host, invalidate, onIdleWithoutFinalization } = createReplay();
		host.expectedHeadId = PINNED_HEAD_ID;

		replay.processMessage(FINALIZED_FRAME);
		replay.resetPass();
		replay.processMessage(HEADLESS_IDLE_GREETINGS);

		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(onIdleWithoutFinalization).toHaveBeenCalledTimes(1);
		expect(replay.isComplete).toBe(false);
	});
});
