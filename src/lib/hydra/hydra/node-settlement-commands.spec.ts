import { describe, expect, it } from '@jest/globals';

import { partialFanoutCommand } from './node-settlement-commands';

const OURS = `${'aa'.repeat(32)}#0`;
const THEIRS = `${'bb'.repeat(32)}#1`;

describe('partialFanoutCommand', () => {
	const ours = { address: 'addr_test1ours', value: { lovelace: 2_000_000n } };
	const theirs = { address: 'addr_test1theirs', value: { lovelace: 2_000_000 } };
	const { isComplete } = partialFanoutCommand({ [OURS]: ours as never }, 1_000);

	// A step already in flight when the command was sent reports outputs the
	// command did not select. Settling on it reported success for a selection
	// the node had not acted on.
	it('settles only on a step that distributed part of its own selection', () => {
		expect(isComplete({ tag: 'HeadPartiallyFannedOut', distributedUTxO: { [THEIRS]: theirs } } as never)).toBe(false);
		expect(isComplete({ tag: 'HeadPartiallyFannedOut', distributedUTxO: { [OURS.toUpperCase()]: {} } } as never)).toBe(
			true,
		);
		expect(isComplete({ tag: 'HeadPartiallyFannedOut' })).toBe(false);
	});

	// Of two identical outputs the node may report the other one as moved.
	// Matching by reference alone then timed out a step that had landed.
	it('settles on a step that moved an identical output under another reference', () => {
		const output = { address: 'addr_test1vz', value: { lovelace: 2_000_000n }, datum: null };
		const command = partialFanoutCommand({ [OURS]: output as never }, 1_000);
		const frame = {
			tag: 'HeadPartiallyFannedOut',
			// Raw JSON: a number quantity, keys in another order, an extra null.
			distributedUTxO: { [THEIRS]: { value: { lovelace: 2_000_000 }, referenceScript: null, address: 'addr_test1vz' } },
		};
		expect(command.isComplete(frame as never)).toBe(true);
		expect(
			command.isComplete({
				...frame,
				distributedUTxO: { [THEIRS]: { address: 'addr_test1vz', value: { lovelace: 3_000_000 } } },
			} as never),
		).toBe(false);
	});

	it('settles on the final step', () => {
		expect(isComplete({ tag: 'HeadIsFinalized' })).toBe(true);
	});
});
