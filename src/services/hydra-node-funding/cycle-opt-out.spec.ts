/**
 * The funding opt-out, asserted where it costs money.
 *
 * `autoFund: false` is offered on both invite endpoints and documented as "opt
 * out only if you fund that key yourself", but it only ever suppressed the
 * immediate pre-fund on redemption. The scheduled cycle then picked the same
 * node up — every node held by a live invite or a non-final head qualifies —
 * and sent it the target balance out of the operator's wallet, which is the
 * one outcome the flag exists to prevent.
 */

import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

type AnyMock = jest.Mock<(...args: any[]) => any>;

const mockFindParticipants = jest.fn() as AnyMock;
const mockFindInvites = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraLocalParticipant: { findMany: mockFindParticipants, findUniqueOrThrow: jest.fn() },
		hydraHeadInvite: { findMany: mockFindInvites },
		walletFundTransfer: { findFirst: jest.fn(), create: jest.fn() },
		$transaction: async (run: (tx: unknown) => Promise<unknown>) => await run({}),
	},
}));

jest.unstable_mockModule('@masumi/payment-core/serializable-semaphore', () => ({
	withSerializableSlotRetry: async (operation: () => Promise<unknown>) => await operation(),
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('@/utils/blockfrost', () => ({
	getBlockfrostInstance: () => ({
		addressesExtended: async () => ({ amount: [{ unit: 'lovelace', quantity: '0' }] }),
	}),
}));

jest.unstable_mockModule('./node-address', () => ({
	nodeCardanoAddress: () => 'addr_test1_node',
}));

let runHydraNodeFundingCycle: typeof import('./service').runHydraNodeFundingCycle;

beforeAll(async () => {
	({ runHydraNodeFundingCycle } = await import('./service'));
});

beforeEach(() => {
	jest.clearAllMocks();
	mockFindInvites.mockResolvedValue([]);
	mockFindParticipants.mockResolvedValue([]);
});

describe('runHydraNodeFundingCycle', () => {
	it('leaves nodes the operator said they would fund themselves alone', async () => {
		await runHydraNodeFundingCycle();

		expect(mockFindParticipants).toHaveBeenCalledTimes(1);
		const [{ where }] = mockFindParticipants.mock.calls[0] as [{ where: { autoFund?: boolean } }];
		// A filter, not a per-row skip: the row is never read, so nothing about it
		// can be mistaken for "it needs fuel" later in the pass.
		expect(where.autoFund).toBe(true);
	});
});
