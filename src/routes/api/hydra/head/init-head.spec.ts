import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { HydraHeadStatus, HydraInviteRole } from '@/generated/prisma/client';
import {
	HydraCommandRejectedError,
	HydraPostTxRejectedError,
	HydraProtocolError,
	HydraTransportError,
} from '@/lib/hydra';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindHead = jest.fn() as AnyMock;
const mockConnect = jest.fn() as AnyMock;
const mockInit = jest.fn() as AnyMock;
const mockNodeGet = jest.fn() as AnyMock;
const mockFlush = jest.fn() as AnyMock;
const mockWarn = jest.fn() as AnyMock;
const mockReadNodeState = jest.fn() as AnyMock;
const mockRecordHeadError = jest.fn() as AnyMock;

jest.unstable_mockModule('@/services/hydra-host/pause', () => ({
	assertHydraHeadHostNotPaused: jest.fn(async () => undefined),
	isHydraHeadOnPausedHost: jest.fn(async () => false),
	isHydraHeadOnPausedHostLocked: jest.fn(async () => false),
	HYDRA_HOST_PAUSED_MESSAGE: 'hydra host is paused for maintenance',
}));

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
	logger: { info: jest.fn(), warn: mockWarn, error: jest.fn(), debug: jest.fn() },
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
		getHead: () => ({ init: mockInit, mainNode: { get: mockNodeGet } }),
		flushHeadStatus: mockFlush,
		reconcileEnabledState: jest.fn(),
	}),
}));

// The endpoint factory is mocked down to the definition object, so the handler
// is reached through a cast, as elsewhere in these route specs.
let initHeadPost: { handler: (args: { input: { headId: string } }) => Promise<unknown> };

beforeAll(async () => {
	const routes = await import('./lifecycle');
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
	mockNodeGet.mockResolvedValue({ maxTxSize: 15_000 });
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

// Whatever Host the node runs on, an older build included, a head opened on an
// L2 maxTxSize above the shipped one can hold an output fanout cannot move.
describe('initHeadPost, on a node with unsafe L2 params', () => {
	it('refuses before posting Init', async () => {
		mockNodeGet.mockResolvedValue({ maxTxSize: 16_384 });

		await expect(initHeadPost.handler({ input: { headId: 'head-1' } })).rejects.toMatchObject({
			statusCode: 409,
			message: expect.stringContaining('L2 maxTxSize of 16384, above 15000'),
		});
		expect(mockNodeGet).toHaveBeenCalledWith('/protocol-parameters');
		expect(mockInit).not.toHaveBeenCalled();
	});

	// A node that is down is not a failed Init, so it must not land on the head as an error.
	it('answers 502 without a head error when the params cannot be read', async () => {
		// The shape fetch gives for localhost: the socket error sits two levels down, with only a code.
		const refused = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' });
		mockNodeGet.mockRejectedValue(
			new HydraTransportError('Hydra HTTP GET failed before a response was received', {
				cause: Object.assign(new TypeError('fetch failed'), { cause: refused }),
			}),
		);

		await expect(initHeadPost.handler({ input: { headId: 'head-1' } })).rejects.toMatchObject({
			statusCode: 502,
			expose: true,
			message: expect.stringContaining('failed before a response was received: ECONNREFUSED'),
		});
		expect(mockRecordHeadError).not.toHaveBeenCalled();
		expect(mockInit).not.toHaveBeenCalled();
	});

	it('records a protocol fault from the params read instead of asking for a retry', async () => {
		const protocolFault = new HydraProtocolError('Hydra HTTP response was not valid JSON');
		mockNodeGet.mockRejectedValue(protocolFault);

		await expect(initHeadPost.handler({ input: { headId: 'head-1' } })).rejects.toBe(protocolFault);
		expect(mockRecordHeadError).toHaveBeenCalledWith(
			'head-1',
			expect.anything(),
			expect.anything(),
			protocolFault,
			'Init',
		);
		expect(mockInit).not.toHaveBeenCalled();
	});
});

// A transport failure in connect happens before anything is sent, so it is not a failed Init.
describe('initHeadPost, when the node cannot be reached', () => {
	it('answers an exposed 502 that names the cause, without a head error', async () => {
		// The node wraps the reason a session closed before Greetings; the reason is the useful part.
		mockConnect.mockRejectedValue(
			new HydraTransportError('Hydra live session closed before identity verification', {
				cause: new HydraTransportError('Connection closed unexpectedly (code 1006)'),
			}),
		);

		await expect(initHeadPost.handler({ input: { headId: 'head-1' } })).rejects.toMatchObject({
			statusCode: 502,
			expose: true,
			// A node still starting and a wrong URL can fail alike; the cause tells them apart.
			message: expect.stringContaining(
				'closed before identity verification: Connection closed unexpectedly (code 1006)',
			),
		});
		expect(mockRecordHeadError).not.toHaveBeenCalled();
		expect(mockInit).not.toHaveBeenCalled();
	});

	it('names a probe failure that wraps nothing', async () => {
		mockConnect.mockRejectedValue(new HydraTransportError('Local Hydra node unreachable for head head-1'));

		await expect(initHeadPost.handler({ input: { headId: 'head-1' } })).rejects.toMatchObject({
			statusCode: 502,
			message: expect.stringContaining('Local Hydra node unreachable for head head-1. Retry'),
		});
	});

	// Only a transport failure is mapped: any other connect failure is still a head error.
	it('still records any other connect failure', async () => {
		mockConnect.mockRejectedValue(new Error('Hydra head head-1 transport was revoked while connecting'));

		await expect(initHeadPost.handler({ input: { headId: 'head-1' } })).rejects.toThrow('revoked');
		expect(mockRecordHeadError).toHaveBeenCalledTimes(1);
	});

	// A retry cannot fix a node that breaks the protocol, so it must not read as unreachable.
	it('records a protocol fault that closed the session before Greetings', async () => {
		const protocolFault = new HydraProtocolError('Hydra websocket sent a non-text frame');
		mockConnect.mockRejectedValue(
			new HydraTransportError('Hydra live session closed before identity verification', { cause: protocolFault }),
		);

		await expect(initHeadPost.handler({ input: { headId: 'head-1' } })).rejects.toBe(protocolFault);
		// The head error must name the fault, not the closed session that reads like a passing drop.
		expect(mockRecordHeadError).toHaveBeenCalledWith(
			'head-1',
			expect.anything(),
			expect.anything(),
			protocolFault,
			'Init',
		);
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

	// The node refused the InitTx outright. Nothing is parked, so a node that is
	// behind must not turn this into "wait, do not re-post": that verdict wrote no
	// row, and the waiting Init is the only place this refusal is recorded.
	it('records an outright refusal without diagnosing it as a wait', async () => {
		mockInit.mockRejectedValue(
			new HydraPostTxRejectedError('hydra-node refused to post the Init transaction: NoSeedInput'),
		);
		mockReadNodeState.mockResolvedValue({
			state: 'Running',
			isReady: false,
			reason: 'catching up',
			chainSynced: false,
			driftSeconds: 14_571,
		});

		await expect(initHeadPost.handler({ input: { headId: 'head-1' } })).rejects.toMatchObject({
			statusCode: 504,
			message: expect.stringContaining('NoSeedInput'),
		});

		expect(mockRecordHeadError).toHaveBeenCalledTimes(1);
		expect(mockReadNodeState).not.toHaveBeenCalled();
	});

	// The node also answers CommandFailed when the head initialized while Init
	// waited for the node to catch up, and only the diagnosis can see the head
	// moved. Short of that it is a refusal: nothing was posted, so a node that is
	// behind must not turn it into "wait, do not re-post".
	it('records a CommandFailed from a node that is behind, without saying to wait', async () => {
		mockInit.mockRejectedValue(new HydraCommandRejectedError('Command Init failed'));
		mockReadNodeState.mockResolvedValue({
			state: 'Running',
			isReady: false,
			reason: 'catching up',
			chainSynced: false,
			driftSeconds: 14_571,
		});

		await expect(initHeadPost.handler({ input: { headId: 'head-1' } })).rejects.toMatchObject({
			statusCode: 504,
			message: 'Command Init failed',
		});

		expect(mockFlush).toHaveBeenCalled();
		expect(mockReadNodeState).toHaveBeenCalled();
		expect(mockRecordHeadError).toHaveBeenCalledTimes(1);
		expect(mockWarn).not.toHaveBeenCalledWith(expect.stringMatching(/race/), expect.anything());
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
