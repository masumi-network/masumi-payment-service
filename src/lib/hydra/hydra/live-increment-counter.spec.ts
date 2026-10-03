/**
 * `CommitRecovered` must not spend a pending deposit's fold-in slot.
 *
 * Recovery is the path for a deposit the head declined, so a recovered deposit
 * was never `CommitApproved` and never incremented the counter. Decrementing on
 * recovery therefore released an unrelated, still-in-flight deposit's slot: the
 * fold-in UTxO set was cleared while that deposit was still being folded in, and
 * every L2 transaction built against those outputs came back "all inputs are
 * spent" — a race that reads like a bug in the transaction.
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it } from '@jest/globals';
import { LiveFrameProcessor, type LiveFrameHost } from './node-live-frames';
import { HydraNodeEvent } from './types';

const HEAD_ID = 'e'.repeat(56);
const DEPOSIT_REFERENCE = `${'c'.repeat(64)}#0`;

function makeProcessor(): { processor: LiveFrameProcessor; increments: number[] } {
	const host: LiveFrameHost = {
		expectedHeadId: undefined,
		persistenceRotationError: undefined,
		configuredKeyCount: 0,
		assertPersistenceReplayIsSupported: () => {},
		bindSnapshotPartyOrder: () => {},
		verifyGreetingsPartyIdentity: () => {},
		recordFinalizedFanout: () => {},
		clearFinalizedFanout: () => {},
		setNetworkConnected: () => {},
		onRotationError: () => {},
		invalidateLiveConnection: () => {},
	};
	const emitter = new EventEmitter();
	const increments: number[] = [];
	emitter.on(HydraNodeEvent.IncrementFinalized, () => increments.push(increments.length));
	return { processor: new LiveFrameProcessor(host, emitter), increments };
}

describe('pending increment accounting', () => {
	it('keeps an approved deposit pending when an unrelated deposit is recovered', () => {
		const { processor, increments } = makeProcessor();

		processor.processStatus(
			JSON.stringify({
				tag: 'CommitApproved',
				headId: HEAD_ID,
				utxoToCommit: { [DEPOSIT_REFERENCE]: { address: 'addr_test1abc' } },
			}),
		);
		expect(processor.hasPendingIncrement).toBe(true);
		expect([...processor.pendingIncrementUtxoRefs]).toEqual([DEPOSIT_REFERENCE.toLowerCase()]);

		processor.processStatus(JSON.stringify({ tag: 'CommitRecovered', headId: HEAD_ID }));

		expect(processor.hasPendingIncrement).toBe(true);
		expect([...processor.pendingIncrementUtxoRefs]).toEqual([DEPOSIT_REFERENCE.toLowerCase()]);
		// Still re-checked by whoever was waiting: the recovery did change what the
		// head holds, it just did not settle the deposit this counter tracks.
		expect(increments).toHaveLength(1);
	});

	it('releases the slot on the finalization that actually settles the deposit', () => {
		const { processor } = makeProcessor();

		processor.processStatus(
			JSON.stringify({
				tag: 'CommitApproved',
				headId: HEAD_ID,
				utxoToCommit: { [DEPOSIT_REFERENCE]: { address: 'addr_test1abc' } },
			}),
		);
		processor.processStatus(JSON.stringify({ tag: 'CommitFinalized', headId: HEAD_ID }));

		expect(processor.hasPendingIncrement).toBe(false);
		expect([...processor.pendingIncrementUtxoRefs]).toEqual([]);
	});

	it('holds both deposits until the last finalization when two are in flight', () => {
		const { processor } = makeProcessor();
		const second = `${'d'.repeat(64)}#1`;

		processor.processStatus(
			JSON.stringify({
				tag: 'CommitApproved',
				headId: HEAD_ID,
				utxoToCommit: { [DEPOSIT_REFERENCE]: { address: 'addr_test1abc' } },
			}),
		);
		processor.processStatus(
			JSON.stringify({
				tag: 'CommitApproved',
				headId: HEAD_ID,
				utxoToCommit: { [second]: { address: 'addr_test1abc' } },
			}),
		);
		processor.processStatus(JSON.stringify({ tag: 'CommitFinalized', headId: HEAD_ID }));

		expect(processor.hasPendingIncrement).toBe(true);
		expect([...processor.pendingIncrementUtxoRefs].sort()).toEqual([DEPOSIT_REFERENCE, second].sort());

		processor.processStatus(JSON.stringify({ tag: 'CommitFinalized', headId: HEAD_ID }));
		expect(processor.hasPendingIncrement).toBe(false);
	});
});
