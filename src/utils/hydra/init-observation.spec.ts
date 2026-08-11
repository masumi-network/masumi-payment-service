import { describe, expect, it } from '@jest/globals';

import { HydraHeadStatus } from '@/generated/prisma/client';
import { classifyInitObservation } from './init-observation';

const SYNCED = { chainSynced: true, driftSeconds: 0 };
const BEHIND = { chainSynced: false, driftSeconds: 14_571 };
/** The Host could not be asked at all, which is not evidence of anything. */
const UNKNOWN = { chainSynced: null, driftSeconds: null };

describe('classifyInitObservation', () => {
	it('is not a failure when the head advanced while we were deciding', () => {
		for (const headStatus of [HydraHeadStatus.Initializing, HydraHeadStatus.Open]) {
			expect(classifyInitObservation({ headStatus, ...SYNCED })).toEqual({ kind: 'observed' });
		}
	});

	it('recognises a late observation even from a node that is behind', () => {
		// The status is the stronger evidence: if the frame arrived, the node saw
		// it, whatever its drift said a moment earlier.
		expect(classifyInitObservation({ headStatus: HydraHeadStatus.Open, ...BEHIND })).toEqual({ kind: 'observed' });
	});

	it('blames the follower when the node says it has not caught up', () => {
		const verdict = classifyInitObservation({ headStatus: HydraHeadStatus.Idle, ...BEHIND });

		expect(verdict.kind).toBe('awaiting-node');
		expect(verdict.kind === 'awaiting-node' && verdict.message).toContain('4 hours behind the chain');
	});

	it('tells the operator not to re-post, which is the actual hazard', () => {
		// Two Inits race for the same seed input and one loses on chain, so the
		// message has to stop the retry the old error invited.
		const verdict = classifyInitObservation({ headStatus: HydraHeadStatus.Idle, ...BEHIND });

		expect(verdict.kind === 'awaiting-node' && verdict.message).toMatch(/race the first one/);
	});

	it('still calls it a failure when the node is caught up and saw nothing', () => {
		expect(classifyInitObservation({ headStatus: HydraHeadStatus.Idle, ...SYNCED })).toEqual({ kind: 'failed' });
	});

	it('falls through to failure when the node could not be asked', () => {
		// Silence from the Host is not evidence the node is behind, and guessing
		// otherwise would bury a genuinely dropped InitTx.
		expect(classifyInitObservation({ headStatus: HydraHeadStatus.Idle, ...UNKNOWN })).toEqual({ kind: 'failed' });
	});

	it('scales the drift wording rather than reading the same at every distance', () => {
		const at = (driftSeconds: number | null) => {
			const verdict = classifyInitObservation({ headStatus: HydraHeadStatus.Idle, chainSynced: false, driftSeconds });
			return verdict.kind === 'awaiting-node' ? verdict.message : '';
		};

		expect(at(45)).toContain('45 seconds behind');
		expect(at(600)).toContain('10 minutes behind');
		expect(at(10_800)).toContain('3 hours behind');
		expect(at(null)).toContain('still catching up');
	});
});
