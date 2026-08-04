import { describe, expect, it } from '@jest/globals';
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
});
