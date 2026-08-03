import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { HydraHeadStatus, HydraInviteRole } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindHead = jest.fn() as AnyMock;
const mockConnect = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/auth', () => ({
	adminAuthenticatedEndpointFactory: { build: (definition: unknown) => definition },
}));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraHead: { findUnique: mockFindHead, update: jest.fn(), updateMany: jest.fn() },
		hydraHeadError: { create: jest.fn() },
	},
}));

jest.unstable_mockModule('@masumi/payment-core/serializable-semaphore', () => ({
	withSerializableSlotRetry: async (operation: () => Promise<unknown>) => await operation(),
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({
		connect: mockConnect,
		getHead: () => ({ init: jest.fn() }),
		flushHeadStatus: jest.fn(),
		reconcileEnabledState: jest.fn(),
	}),
}));

// The endpoint factory is mocked down to the definition object, so the handler
// is reached through a cast, as elsewhere in these route specs.
let initHeadPost: { handler: (args: { input: { headId: string } }) => Promise<unknown> };

beforeAll(async () => {
	const routes = await import('./index');
	initHeadPost = routes.initHeadPost as unknown as typeof initHeadPost;
});

const idleHead = {
	id: 'head-1',
	status: HydraHeadStatus.Idle,
	isEnabled: true,
	LocalParticipant: { id: 'participant-1' },
	Invite: { role: HydraInviteRole.Redeemer },
};

beforeEach(() => {
	jest.clearAllMocks();
	mockFindHead.mockResolvedValue(idleHead);
	mockConnect.mockResolvedValue(undefined);
});

/**
 * Exactly one side may open a head and nothing in the protocol arbitrates it.
 * Two Inits race for the same seed inputs: one lands, the other is rejected on
 * chain, and the loser sits Initializing against a head that does not exist.
 */
describe('initHeadPost, on the issuing side', () => {
	it('refuses, because the redeemer opens', async () => {
		mockFindHead.mockResolvedValue({ ...idleHead, Invite: { role: HydraInviteRole.Issuer } });

		await expect(initHeadPost.handler({ input: { headId: 'head-1' } })).rejects.toMatchObject({
			statusCode: 409,
		});
		// Refused before the node is touched: the point is not to post at all.
		expect(mockConnect).not.toHaveBeenCalled();
	});

	// The refusal is the only place an operator learns why their button did
	// nothing, so it has to name who acts instead.
	it('says who opens it instead', async () => {
		mockFindHead.mockResolvedValue({ ...idleHead, Invite: { role: HydraInviteRole.Issuer } });

		await expect(initHeadPost.handler({ input: { headId: 'head-1' } })).rejects.toMatchObject({
			message: expect.stringContaining('counterparty'),
		});
	});
});

describe('initHeadPost, elsewhere', () => {
	it('lets the redeeming side through', async () => {
		await initHeadPost.handler({ input: { headId: 'head-1' } }).catch(() => undefined);

		expect(mockConnect).toHaveBeenCalled();
	});

	// Heads that predate invites, and any head created another way, keep working:
	// the rule is about the exchange, not about Init.
	it('lets a head with no invite through', async () => {
		mockFindHead.mockResolvedValue({ ...idleHead, Invite: null });

		await initHeadPost.handler({ input: { headId: 'head-1' } }).catch(() => undefined);

		expect(mockConnect).toHaveBeenCalled();
	});
});
