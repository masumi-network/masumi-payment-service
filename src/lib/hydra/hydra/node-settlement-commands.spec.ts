import { describe, expect, it } from '@jest/globals';

import { partialFanoutCommand } from './node-settlement-commands';

const OURS = `${'aa'.repeat(32)}#0`;
const THEIRS = `${'bb'.repeat(32)}#1`;

describe('partialFanoutCommand', () => {
	const { isComplete } = partialFanoutCommand({ [OURS]: {} as never }, 1_000);

	// A step already in flight when the command was sent reports outputs the
	// command did not select. Settling on it reported success for a selection
	// the node had not acted on.
	it('settles only on a step that distributed part of its own selection', () => {
		expect(isComplete({ tag: 'HeadPartiallyFannedOut', distributedUTxO: { [THEIRS]: {} } } as never)).toBe(false);
		expect(isComplete({ tag: 'HeadPartiallyFannedOut', distributedUTxO: { [OURS.toUpperCase()]: {} } } as never)).toBe(
			true,
		);
		expect(isComplete({ tag: 'HeadPartiallyFannedOut' })).toBe(false);
	});

	it('settles on the final step', () => {
		expect(isComplete({ tag: 'HeadIsFinalized' })).toBe(true);
	});
});
