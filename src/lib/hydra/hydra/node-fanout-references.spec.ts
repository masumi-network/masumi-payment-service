import { describe, expect, it } from '@jest/globals';
import { readFinalSnapshotOutput, type FanoutResolutionContext } from './node-fanout-references';
import type { VerifiedHydraSnapshot } from './snapshot-verification';

const inHead = `${'ab'.repeat(32)}#0`;
const fanoutRef = `${'cd'.repeat(32)}#0`;

function context(
	options: {
		partition?: 'committedOutputs' | 'decommitOutputs';
		fanoutOutputs?: Map<string, string>;
	} = {},
): FanoutResolutionContext {
	const verifiedSnapshot = {
		headId: 'head',
		number: 3,
		version: 0,
		outputs: new Map([[inHead, 'bytes']]),
		outputMultiset: new Map([['bytes', 1]]),
		committedOutputs: new Map(options.partition === 'committedOutputs' ? [[inHead, 'bytes']] : []),
		decommitOutputs: new Map(options.partition === 'decommitOutputs' ? [[inHead, 'bytes']] : []),
	} satisfies VerifiedHydraSnapshot;
	return {
		verifiedSnapshot,
		finalizedFanoutOutputs: options.fanoutOutputs ?? new Map([[fanoutRef, 'bytes']]),
		getConfirmedTransaction: () => null,
	};
}

describe('readFinalSnapshotOutput', () => {
	it('returns the output the fanned-out final snapshot holds as spendable state', () => {
		expect(readFinalSnapshotOutput(context(), inHead)).toBe('bytes');
	});

	it('returns null for an output the final snapshot does not hold', () => {
		expect(readFinalSnapshotOutput(context(), `${'ef'.repeat(32)}#1`)).toBeNull();
	});

	// A Final head whose observed fanout does not match the snapshot proves
	// nothing about that snapshot being the last state.
	it('returns null when the observed fanout does not match the snapshot', () => {
		expect(readFinalSnapshotOutput(context({ fanoutOutputs: new Map([[fanoutRef, 'other']]) }), inHead)).toBeNull();
	});

	// No signed snapshot folded the deposit in, so no confirmed body spent it.
	it('returns a deposit still pending in the final snapshot', () => {
		expect(readFinalSnapshotOutput(context({ partition: 'committedOutputs' }), inHead)).toBe('bytes');
	});

	it('returns null for an output pending decommit', () => {
		expect(readFinalSnapshotOutput(context({ partition: 'decommitOutputs' }), inHead)).toBeNull();
	});
});
