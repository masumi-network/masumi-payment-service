import { describe, expect, it, jest } from '@jest/globals';
import { HydraHeadStatus } from '@/generated/prisma/client';

import { HydraCommandRejectedError } from './errors';
import { FanoutProgressState } from './node-fanout-progress';
import { extractStatusChangeData, handleWsResponse } from './node-frames';

const HEAD_ID = 'e'.repeat(56);
const OUTPUT = {
	address: 'addr_test1vz',
	value: { lovelace: 2_000_000 },
	referenceScript: null,
	inlineDatum: null,
	inlineDatumRaw: null,
	datum: null,
};
const ref = (byte: string) => `${byte.repeat(64)}#0`;

function step(seq: number | undefined, remainingRefs: string[]) {
	return {
		tag: 'HeadPartiallyFannedOut',
		headId: HEAD_ID,
		...(seq == null ? {} : { seq }),
		distributedUTxO: {},
		remainingUTxO: Object.fromEntries(remainingRefs.map((reference) => [reference, OUTPUT])),
		fanoutMode: 'AwaitingFanoutSelection',
	};
}

describe('FanoutProgressState', () => {
	// History replay re-reports every step on reconnect, after the live socket
	// may already have reported a newer one.
	it('keeps the newest step when replay re-reports an older one', () => {
		const state = new FanoutProgressState();
		state.record(step(12, [ref('a')]), () => {});
		state.record(step(9, [ref('a'), ref('b'), ref('c')]), () => {});

		expect(Object.keys(state.current()!.remainingUTxO)).toEqual([ref('a')]);
	});

	it('takes a newer step', () => {
		const state = new FanoutProgressState();
		state.record(step(9, [ref('a'), ref('b')]), () => {});
		state.record(step(12, [ref('a')]), () => {});

		expect(Object.keys(state.current()!.remainingUTxO)).toEqual([ref('a')]);
	});

	it('rejects a step for another head before it holds anything', () => {
		const state = new FanoutProgressState();
		const assertHead = jest.fn(() => {
			throw new Error('other head');
		});

		expect(() => state.record(step(1, [ref('a')]), assertHead)).toThrow('other head');
		expect(state.current()).toBeUndefined();
	});
});

describe('partial fanout frames', () => {
	it('reads a partial fanout step as FanningOut', () => {
		expect(extractStatusChangeData(JSON.stringify(step(3, [ref('a')])), HEAD_ID)).toMatchObject({
			status: HydraHeadStatus.FanningOut,
			headId: HEAD_ID,
		});
	});

	it('reads a FanningOut Greetings as FanningOut', () => {
		const greetings = { tag: 'Greetings', headStatus: 'FanningOut', hydraHeadId: HEAD_ID };
		expect(extractStatusChangeData(JSON.stringify(greetings), HEAD_ID)).toMatchObject({
			status: HydraHeadStatus.FanningOut,
		});
	});

	// A failed step used to fall through as an unrelated frame, and the command
	// waited out its full lifecycle deadline before it failed.
	it.each([
		['Fanout', 'PartialFanoutTx'],
		['Fanout', 'FinalPartialFanoutTx'],
		['PartialFanout', 'PartialFanoutTx'],
		['PartialFanout', 'FinalPartialFanoutTx'],
		['PartialFanout', 'FanoutTx'],
	])('fails the %s command when the node cannot post a %s', (command, postChainTxTag) => {
		const frame = {
			tag: 'PostTxOnChainFailed',
			headId: HEAD_ID,
			postChainTx: { tag: postChainTxTag },
			postTxError: { tag: 'FailedToConstructPartialFanoutTx' },
		};
		const outcome = handleWsResponse(JSON.stringify(frame), command, undefined, HEAD_ID);

		expect(outcome.kind).toBe('reject');
		expect(outcome.kind === 'reject' && outcome.error).toBeInstanceOf(HydraCommandRejectedError);
	});

	it('does not fail a Close over a fanout step failure', () => {
		const frame = { tag: 'PostTxOnChainFailed', headId: HEAD_ID, postChainTx: { tag: 'PartialFanoutTx' } };
		expect(handleWsResponse(JSON.stringify(frame), 'Close', undefined, HEAD_ID).kind).toBe('message');
	});
});
