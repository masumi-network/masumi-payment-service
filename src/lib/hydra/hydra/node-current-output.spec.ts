import { describe, expect, it } from '@jest/globals';
import { HydraHeadStatus } from '@/generated/prisma/client';
import { HydraNode } from './node';

const reference = `${'ab'.repeat(32)}#0`;
function readOutput(
	verified: boolean,
	status: HydraHeadStatus,
	outputs = new Map([[reference, 'authenticated-bytes']]),
	expectedSnapshotNumber = 3n,
	partition: 'committedOutputs' | 'decommitOutputs' | null = null,
) {
	// Exercise the accessor independently from websocket transport. Signature
	// verification and replay authentication have their own integration suites.
	const context = {
		hasVerifiedPinnedSessions: verified,
		_live: { status },
		_replay: {
			verifiedSnapshot: {
				outputs,
				number: 3,
				committedOutputs: new Map(partition === 'committedOutputs' ? [[reference, 'authenticated-bytes']] : []),
				decommitOutputs: new Map(partition === 'decommitOutputs' ? [[reference, 'authenticated-bytes']] : []),
			},
		},
	};
	return HydraNode.prototype.getVerifiedCurrentOutput.call(
		context as unknown as HydraNode,
		reference,
		expectedSnapshotNumber,
	);
}

describe('Hydra current output evidence accessor', () => {
	it('returns authenticated current bytes from an open verified session', () => {
		expect(readOutput(true, HydraHeadStatus.Open)).toBe('authenticated-bytes');
	});
	it('rejects an unverified session', () => {
		expect(readOutput(false, HydraHeadStatus.Open)).toBeNull();
	});
	it('rejects a closed head even if history remains authenticated', () => {
		expect(readOutput(true, HydraHeadStatus.Closed)).toBeNull();
	});
	it('does not recover an output absent from current authenticated state', () => {
		expect(readOutput(true, HydraHeadStatus.Open, new Map())).toBeNull();
	});
	it('rejects replay evidence behind the durable snapshot tip', () => {
		expect(readOutput(true, HydraHeadStatus.Open, undefined, 4n)).toBeNull();
	});
	it.each(['committedOutputs', 'decommitOutputs'] as const)('rejects an output in the %s partition', (partition) => {
		expect(readOutput(true, HydraHeadStatus.Open, undefined, 3n, partition)).toBeNull();
	});
});

describe('Hydra pending-commit output accessor', () => {
	function isPendingCommit(
		verified: boolean,
		status: HydraHeadStatus,
		partition: 'committedOutputs' | null,
		expectedSnapshotNumber = 3n,
	) {
		const context = {
			hasVerifiedPinnedSessions: verified,
			_live: { status },
			_replay: {
				verifiedSnapshot: {
					outputs: new Map([[reference, 'authenticated-bytes']]),
					number: 3,
					committedOutputs: new Map(partition ? [[reference, 'authenticated-bytes']] : []),
					decommitOutputs: new Map(),
				},
			},
		};
		return HydraNode.prototype.isVerifiedPendingCommitOutput.call(
			context as unknown as HydraNode,
			reference,
			expectedSnapshotNumber,
		);
	}

	// A deposit the head folds in sits in `utxoToCommit` until the next signed
	// snapshot. Release has to tell that apart from a spent input.
	it('reports an output the verified snapshot still holds as a pending commit', () => {
		expect(isPendingCommit(true, HydraHeadStatus.Open, 'committedOutputs')).toBe(true);
	});
	it('does not report a spendable output', () => {
		expect(isPendingCommit(true, HydraHeadStatus.Open, null)).toBe(false);
	});
	it('reports nothing from an unverified session', () => {
		expect(isPendingCommit(false, HydraHeadStatus.Open, 'committedOutputs')).toBe(false);
	});
	it('reports nothing for a different snapshot number', () => {
		expect(isPendingCommit(true, HydraHeadStatus.Open, 'committedOutputs', 4n)).toBe(false);
	});
});

describe('Hydra verified snapshot number accessor', () => {
	const getter = Object.getOwnPropertyDescriptor(HydraNode.prototype, 'verifiedSnapshotNumber')!.get!;
	const read = (verified: boolean, verifiedSnapshot: { number: number } | undefined) =>
		getter.call({ hasVerifiedPinnedSessions: verified, _replay: { verifiedSnapshot } }) as bigint | undefined;

	it('returns the replay-verified snapshot number', () => {
		expect(read(true, { number: 3 })).toBe(3n);
	});
	it('is undefined for an unverified session', () => {
		expect(read(false, { number: 3 })).toBeUndefined();
	});
	it('is undefined before any snapshot is verified', () => {
		expect(read(true, undefined)).toBeUndefined();
	});
});
