import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { HydraHeadStatus, HydraInviteRole } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindHead = jest.fn() as AnyMock;
const mockConnect = jest.fn() as AnyMock;
const mockInit = jest.fn() as AnyMock;
const mockFlush = jest.fn() as AnyMock;
const mockReadNodeState = jest.fn() as AnyMock;
const mockRecordHeadError = jest.fn() as AnyMock;

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

jest.unstable_mockModule('@/services/hydra-host/node-state', () => ({
	readParticipantNodeState: mockReadNodeState,
}));

jest.unstable_mockModule('@/services/hydra-head-error/record', () => ({
	recordHeadError: mockRecordHeadError,
}));

jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({
		connect: mockConnect,
		getHead: () => ({ init: mockInit }),
		flushHeadStatus: mockFlush,
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

/** The status the second findUnique (inside the timeout catch) reports. */
let observedStatus: (typeof HydraHeadStatus)[keyof typeof HydraHeadStatus] = HydraHeadStatus.Idle;

beforeEach(() => {
	jest.clearAllMocks();
	observedStatus = HydraHeadStatus.Idle;
	// The handler reads the head twice: the full row up front, then just its
	// status inside the timeout catch. Tell them apart by the projection.
	mockFindHead.mockImplementation(async (args: { select?: Record<string, unknown> }) => {
		const select = args?.select;
		if (select && Object.keys(select).length === 1 && select.status) {
			return { status: observedStatus };
		}
		return idleHead;
	});
	mockConnect.mockResolvedValue(undefined);
	mockInit.mockResolvedValue(undefined);
	mockFlush.mockResolvedValue(undefined);
	// Caught up by default, so a timeout with nothing else set is a real failure.
	mockReadNodeState.mockResolvedValue({
		state: 'Running',
		isReady: false,
		reason: null,
		chainSynced: true,
		driftSeconds: 0,
	});
	mockRecordHeadError.mockResolvedValue(undefined);
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
		mockFindHead.mockImplementation(async (args: { select?: Record<string, unknown> }) => {
			if (args?.select?.status && Object.keys(args.select).length === 1) return { status: observedStatus };
			return { ...idleHead, Invite: null };
		});

		await initHeadPost.handler({ input: { headId: 'head-1' } }).catch(() => undefined);

		expect(mockConnect).toHaveBeenCalled();
	});
});

/**
 * An Init that never confirms within the wait has two causes the timeout cannot
 * tell apart: the chain backend dropped the transaction, or the node is simply
 * behind and has not reached that block. The first is a real head error; the
 * second is a self-resolving state that must not be recorded as one.
 */
describe('initHeadPost, when Init does not confirm in time', () => {
	beforeEach(() => {
		mockInit.mockRejectedValue(new Error('Head did not reach Initializing within 300s'));
	});

	it('records a head error when the node is caught up and saw nothing', async () => {
		// Caught up (the default node state) and still no Init: a genuine failure.
		await expect(initHeadPost.handler({ input: { headId: 'head-1' } })).rejects.toMatchObject({
			statusCode: 504,
		});

		expect(mockRecordHeadError).toHaveBeenCalledTimes(1);
	});

	it('does not record a head error when the node is only behind', async () => {
		mockReadNodeState.mockResolvedValue({
			state: 'Running',
			isReady: false,
			reason: 'catching up',
			chainSynced: false,
			driftSeconds: 14_571,
		});

		await expect(initHeadPost.handler({ input: { headId: 'head-1' } })).rejects.toMatchObject({
			statusCode: 504,
			// The Init was posted; re-posting would race the first one for the seed.
			message: expect.stringMatching(/race the first one/),
		});

		expect(mockRecordHeadError).not.toHaveBeenCalled();
	});

	it('falls back to a failure when the diagnosis itself cannot run', async () => {
		// The diagnosis reads the database and the Host. If that throws, the
		// original init error must not be swallowed or surface as a 500: it stays
		// the actionable 504 it was before the diagnosis branch existed.
		mockFlush.mockRejectedValueOnce(new Error('connection manager is gone'));

		await expect(initHeadPost.handler({ input: { headId: 'head-1' } })).rejects.toMatchObject({
			statusCode: 504,
		});

		expect(mockRecordHeadError).toHaveBeenCalledTimes(1);
	});

	// The observed case (a late frame showing the head already moved) falls
	// through to the normal post-init verification, so it is covered where the
	// decision is made -- classifyInitObservation in init-observation.spec.ts --
	// rather than by threading it through that unrelated path here.
});
