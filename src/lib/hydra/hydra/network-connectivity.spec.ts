import { describe, expect, it } from '@jest/globals';
import { messageSchema } from './schemas';
import { MessageTag } from './types';

/**
 * What "connected" means under the etcd network layer, and what it does not.
 *
 * Hydra's ADR 032 changed peer connectivity from per-peer to cluster-wide:
 * a node reports connected when it is in the majority cluster, because that is
 * the condition under which it can send and receive at all. For a two-party
 * head the majority is both parties, so our node saying it is connected is
 * evidence that the counterparty's node is up and reachable.
 *
 * It is not evidence that their node has finished syncing the chain. A node
 * joins the cluster long before its chain follower catches up, and a node that
 * is behind still refuses commands. That distinction is why this is surfaced as
 * a reading rather than used to gate opening a head.
 */
describe('the connectivity frames we act on', () => {
	it('are the ones hydra actually emits', () => {
		expect(MessageTag.NetworkConnected).toBe('NetworkConnected');
		expect(MessageTag.NetworkDisconnected).toBe('NetworkDisconnected');
		expect(MessageTag.PeerConnected).toBe('PeerConnected');
		expect(MessageTag.PeerDisconnected).toBe('PeerDisconnected');
	});

	/**
	 * Chain-sync is a separate axis from cluster membership, and Hydra 2.4 moved
	 * where it is reported: the `SyncedStatusReport` server output was removed,
	 * and a node now announces crossing the threshold with these transitions
	 * (the same state is also on `Greetings.chainSyncedStatus`).
	 *
	 * This service reports them and gates nothing on them. A node that has fallen
	 * behind refuses client input by itself, and the guards that matter — the head
	 * clock's freshness check and the Host's drift watchdog — already fail closed
	 * without these frames. Their value is telling an operator why a head went
	 * quiet, which before 2.4 left no trace in our logs at all.
	 */
	it('distinguishes chain-sync transitions from cluster membership', () => {
		expect(MessageTag.NodeSynced).toBe('NodeSynced');
		expect(MessageTag.NodeUnsynced).toBe('NodeUnsynced');
		expect(MessageTag.NodeSynced).not.toBe(MessageTag.NetworkConnected);
		expect(MessageTag.NodeUnsynced).not.toBe(MessageTag.NetworkDisconnected);
	});

	/**
	 * Both frames as a real hydra-node 2.4.1 emitted them, recorded 2026-09-07
	 * from a live devnet head: the chain feed was stalled for 20s while the chain
	 * kept forging, so the node resumed on a backlog of old blocks, crossed its
	 * 1.5s unsynced period, and reported both the fall-behind and the catch-up.
	 *
	 * Worth pinning because the enum assertions above only say we spell the tags
	 * the same way hydra does. They say nothing about the payload, and the payload
	 * is the part an operator reads: without `drift` a NodeUnsynced tells them the
	 * head went quiet but not whether it is seconds or minutes behind.
	 */
	it('parses the sync transitions a 2.4.1 node actually emits, drift included', () => {
		const unsynced = {
			chainSlot: 1790,
			chainTime: '2026-09-07T08:16:29Z',
			drift: 18.453509,
			seq: 1754,
			tag: 'NodeUnsynced',
			timestamp: '2026-09-07T08:16:47.456188Z',
		};
		const synced = { ...unsynced, chainSlot: 1807, drift: 1.480703, seq: 1772, tag: 'NodeSynced' };

		expect(messageSchema.parse(unsynced).tag).toBe(MessageTag.NodeUnsynced);
		expect(messageSchema.parse(synced).tag).toBe(MessageTag.NodeSynced);
		// Loose parsing must not drop the drift reading these frames exist to carry.
		expect(messageSchema.parse(unsynced).drift).toBe(18.453509);
	});
});
