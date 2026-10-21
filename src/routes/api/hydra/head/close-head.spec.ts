import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { HydraHeadStatus, TransactionLayer, TransactionStatus } from '@/generated/prisma/client';
import { HydraCommandRejectedError, HydraTransportAmbiguousError, HydraTransportError } from '@/lib/hydra/hydra/errors';
import { HydraHeadInitObservationError } from '@/lib/hydra/hydra/head-init-validation';

type AnyMock = Mock<(...args: any[]) => any>;

const mockTransaction = jest.fn() as AnyMock;
const mockQueryRaw = jest.fn() as AnyMock;
const mockTransactionCount = jest.fn() as AnyMock;
const mockPaymentCount = jest.fn() as AnyMock;
const mockPurchaseCount = jest.fn() as AnyMock;
const mockTopupCount = jest.fn() as AnyMock;
const mockClaimClose = jest.fn() as AnyMock;
const mockFindHead = jest.fn() as AnyMock;
const mockUpdateHead = jest.fn() as AnyMock;
const mockReleaseClose = jest.fn() as AnyMock;
const mockCreateHeadError = jest.fn() as AnyMock;
const mockClose = jest.fn() as AnyMock;
const mockFlushHeadStatus = jest.fn() as AnyMock;
const mockReconcileEnabledState = jest.fn() as AnyMock;

const transactionClient = {
	$queryRaw: mockQueryRaw,
	transaction: { count: mockTransactionCount },
	paymentRequest: { count: mockPaymentCount },
	purchaseRequest: { count: mockPurchaseCount },
	hydraTopup: { count: mockTopupCount },
	hydraLocalParticipant: { findFirst: async () => null },
	hydraHead: { updateMany: mockClaimClose },
};

jest.unstable_mockModule('@masumi/payment-core/auth', () => ({
	adminAuthenticatedEndpointFactory: { build: (definition: unknown) => definition },
}));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		$transaction: mockTransaction,
		hydraHead: {
			findUnique: mockFindHead,
			update: mockUpdateHead,
			updateMany: mockReleaseClose,
		},
		hydraHeadError: { create: mockCreateHeadError },
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
		getHead: () => ({ close: mockClose }),
		flushHeadStatus: mockFlushHeadStatus,
		reconcileEnabledState: mockReconcileEnabledState,
	}),
}));

// Close and fanout live in the settlement module; enable/list stay in the route
// module, so this pulls from both rather than one barrel.
let beginHydraHeadClose: typeof import('./settlement').beginHydraHeadClose;
let updateHydraHeadEnabledState: typeof import('./index').updateHydraHeadEnabledState;
let closeHeadPost: typeof import('./settlement').closeHeadPost;
let getOrListHeadsGet: typeof import('./index').getOrListHeadsGet;

beforeAll(async () => {
	({ updateHydraHeadEnabledState, getOrListHeadsGet } = await import('./index'));
	({ beginHydraHeadClose, closeHeadPost } = await import('./settlement'));
});

const openHead = {
	id: 'head-1',
	status: HydraHeadStatus.Open,
	isEnabled: true,
	isClosing: false,
	initTxHash: 'a'.repeat(64),
	// The refusal message quotes this back. Omitting it let the message render
	// "NaN days" and the test still pass, because it only asserted on wording
	// that did not include the number.
	contestationPeriod: 86_400n,
};

beforeEach(() => {
	jest.clearAllMocks();
	mockTransaction.mockImplementation(
		async (operation: (tx: typeof transactionClient) => Promise<unknown>) => await operation(transactionClient),
	);
	mockQueryRaw.mockResolvedValue([openHead]);
	mockTransactionCount.mockResolvedValue(0);
	mockPaymentCount.mockResolvedValue(0);
	mockPurchaseCount.mockResolvedValue(0);
	mockTopupCount.mockResolvedValue(0);
	mockClaimClose.mockResolvedValue({ count: 1 });
	mockFindHead.mockResolvedValue(openHead);
	mockUpdateHead.mockResolvedValue(openHead);
	mockReleaseClose.mockResolvedValue({ count: 1 });
	mockCreateHeadError.mockResolvedValue({ id: 'error-1' });
	mockClose.mockResolvedValue(undefined);
	mockFlushHeadStatus.mockResolvedValue(undefined);
	mockReconcileEnabledState.mockResolvedValue(true);
});

describe('beginHydraHeadClose', () => {
	it('rejects close while a Pending L2 reservation exists', async () => {
		mockTransactionCount.mockResolvedValue(1);

		await expect(beginHydraHeadClose('head-1')).rejects.toMatchObject({ statusCode: 409 });
		expect(mockClaimClose).not.toHaveBeenCalled();
	});

	it('rejects an Open head whose independently verified InitTx binding is absent', async () => {
		mockQueryRaw.mockResolvedValue([{ ...openHead, initTxHash: null }]);

		await expect(beginHydraHeadClose('head-1')).rejects.toMatchObject({ statusCode: 409 });
		expect(mockTransactionCount).not.toHaveBeenCalled();
		expect(mockClaimClose).not.toHaveBeenCalled();
	});

	it('blocks both exact live outputs and unresolved terminal evidence', async () => {
		mockPaymentCount.mockResolvedValue(1);

		await expect(beginHydraHeadClose('head-1')).rejects.toMatchObject({ statusCode: 409 });
		expect(mockPaymentCount).toHaveBeenCalledWith({
			where: {
				layer: TransactionLayer.L2,
				CurrentTransaction: { is: { hydraHeadId: 'head-1', layer: TransactionLayer.L2 } },
				OR: [
					{
						currentHydraUtxoTxHash: { not: null },
						currentHydraUtxoOutputIndex: { not: null },
					},
					{ unresolvedHydraTerminalTxHash: { not: null } },
				],
			},
		});
		expect(mockPurchaseCount).toHaveBeenCalledWith(expect.objectContaining({ where: expect.any(Object) }));
		expect(mockClaimClose).not.toHaveBeenCalled();
	});

	/**
	 * Refusing by default is right; refusing absolutely is a trap.
	 *
	 * A head that is busy enough to be worth closing always has escrows in it,
	 * so an unconditional guard means it can never be closed at all. Closing
	 * fans them out to L1, where they stay collectible against the same datums
	 * and deadlines — a change of settlement layer, not a loss.
	 */
	it('closes with live escrows once the operator has acknowledged them', async () => {
		mockPaymentCount.mockResolvedValue(71);
		mockTransactionCount.mockResolvedValue(1);

		await expect(beginHydraHeadClose('head-1', true)).resolves.toBeUndefined();
		expect(mockClaimClose).toHaveBeenCalled();
	});

	// Without the acknowledgement the refusal stands, and says what closing would
	// do rather than only that it refused.
	// Closing does NOT settle a deposit the head never absorbed: it is not part
	// of the fanout, and it comes back only through Recover, which needs a live
	// session for this head. Waved through, the money stays at the L1 deposit
	// script with nothing left able to ask for it back — and head deletion is
	// then refused for naming it.
	it('refuses an unacknowledged close while a deposit is still outstanding', async () => {
		mockTopupCount.mockResolvedValue(1);

		await expect(beginHydraHeadClose('head-1')).rejects.toMatchObject({ statusCode: 409 });
		expect(mockClaimClose).not.toHaveBeenCalled();
		expect(mockTopupCount).toHaveBeenCalledWith({
			where: {
				hydraHeadId: 'head-1',
				OR: [
					{ depositTxHash: { not: null }, status: { notIn: ['Absorbed', 'Recovered', 'Failed'] } },
					// A deposit still being prepared lands on L1 after the close.
					{ status: 'Preparing', createdAt: { gte: expect.any(Date) } },
				],
			},
		});
	});

	it('says the deposit will not come back in the fanout', async () => {
		mockTopupCount.mockResolvedValue(1);

		await expect(beginHydraHeadClose('head-1')).rejects.toMatchObject({
			message: expect.stringContaining('NOT come back in the fanout'),
		});
	});

	it('says what closing would cost when it refuses', async () => {
		mockPaymentCount.mockResolvedValue(71);

		// The count and the wait are the two facts the operator decides on, so
		// assert both. Asserting the real duration is also what stops a missing
		// contestationPeriod rendering "NaN days" unnoticed.
		await expect(beginHydraHeadClose('head-1')).rejects.toMatchObject({
			statusCode: 409,
			message: expect.stringMatching(/71 escrows still holding funds[\s\S]*contestation period of 1 day/),
		});
		expect(mockClaimClose).not.toHaveBeenCalled();
	});

	it('claims the durable admission gate only after all blocking work is drained', async () => {
		await expect(beginHydraHeadClose('head-1')).resolves.toBeUndefined();

		expect(mockTransactionCount).toHaveBeenCalledWith({
			where: {
				hydraHeadId: 'head-1',
				layer: TransactionLayer.L2,
				status: TransactionStatus.Pending,
			},
		});
		expect(mockClaimClose).toHaveBeenCalledWith({
			where: {
				id: 'head-1',
				status: HydraHeadStatus.Open,
				isEnabled: true,
				isClosing: false,
				initTxHash: { not: null },
			},
			// `closingSince` is the latch's own timestamp. `closeRefusedAt` starts
			// empty: a refusal from an earlier attempt must not release this one.
			data: { isClosing: true, closingSince: expect.any(Date), closeRefusedAt: null },
		});
	});
});

describe('Hydra head state convergence', () => {
	it('does not bless an unverified InitTx as a side effect of GET', async () => {
		mockFindHead.mockResolvedValue({
			...openHead,
			headIdentifier: 'a'.repeat(56),
			initTxHash: null,
			HydraRelation: {},
		});
		const handler = (
			getOrListHeadsGet as unknown as {
				handler: (args: { input: { id: string } }) => Promise<{ heads: Array<{ initTxHash: string | null }> }>;
			}
		).handler;

		await expect(handler({ input: { id: 'head-1' } })).resolves.toMatchObject({
			heads: [{ initTxHash: null }],
		});
		expect(mockUpdateHead).not.toHaveBeenCalled();
	});

	it('clears stale InitTx admission evidence when disabling a head', async () => {
		const disabledHead = { ...openHead, isEnabled: false, initTxHash: null };
		mockFindHead.mockResolvedValueOnce(openHead).mockResolvedValueOnce(disabledHead);

		await expect(updateHydraHeadEnabledState('head-1', false)).resolves.toBe(disabledHead);

		expect(mockReleaseClose).toHaveBeenCalledWith({
			where: { id: 'head-1', retiredAt: null },
			data: { isEnabled: false, initTxHash: null, initChainSlot: null, initChainHash: null },
		});
		// The disable write is the only updateMany: the close latch is untouched.
		expect(mockReleaseClose).toHaveBeenCalledTimes(1);
		expect(mockReconcileEnabledState).toHaveBeenCalledTimes(1);
	});

	// Disabling clears the init anchors that a recovery of a retired head
	// restarts the node from.
	it.each([false, true])('refuses to set a retired head enabled=%s', async (isEnabled) => {
		mockFindHead.mockResolvedValue({ ...openHead, status: HydraHeadStatus.FanoutPossible, retiredAt: new Date() });

		await expect(updateHydraHeadEnabledState('head-1', isEnabled, jest.fn() as AnyMock)).rejects.toMatchObject({
			statusCode: 409,
		});
		expect(mockUpdateHead).not.toHaveBeenCalled();
		expect(mockReleaseClose).not.toHaveBeenCalled();
	});

	it('reports a head deleted during a disable as not found', async () => {
		mockReleaseClose.mockResolvedValue({ count: 0 });
		mockFindHead.mockResolvedValueOnce(openHead).mockResolvedValueOnce(null);

		await expect(updateHydraHeadEnabledState('head-1', false)).rejects.toMatchObject({ statusCode: 404 });
	});

	// A retire that commits between the read and the disable write must keep
	// the anchors: the guarded write matches nothing and the request fails.
	it('refuses a disable that races a retire', async () => {
		mockReleaseClose.mockResolvedValue({ count: 0 });

		await expect(updateHydraHeadEnabledState('head-1', false)).rejects.toMatchObject({ statusCode: 409 });
		expect(mockReconcileEnabledState).not.toHaveBeenCalled();
	});

	// Re-proving an enabled head meant disabling it first, which dropped the
	// live session and the counterparty with it.
	it('leaves an already enabled head enabled and only reconciles it', async () => {
		const liveHead = { ...openHead, headIdentifier: 'a'.repeat(56), initTxHash: 'b'.repeat(64) };
		mockFindHead.mockResolvedValue(liveHead);

		await expect(updateHydraHeadEnabledState('head-1', true, jest.fn() as AnyMock)).resolves.toBe(liveHead);

		expect(mockUpdateHead).not.toHaveBeenCalled();
		expect(mockReleaseClose).not.toHaveBeenCalled();
		// Reconnects a head that lost its session, without disabling it first.
		expect(mockReconcileEnabledState).toHaveBeenCalledWith('head-1');
	});

	it('freshly verifies an established head before re-enabling and reconnecting it', async () => {
		const staleHead = {
			...openHead,
			isEnabled: false,
			headIdentifier: 'a'.repeat(56),
			initTxHash: 'b'.repeat(64),
			updatedAt: new Date('2026-07-23T01:00:00Z'),
			contestationPeriod: 86_400n,
			HydraRelation: {},
		};
		const quarantinedHead = {
			...staleHead,
			isEnabled: false,
			initTxHash: null,
			updatedAt: new Date('2026-07-23T01:01:00Z'),
		};
		const enabledHead = { ...quarantinedHead, isEnabled: true, initTxHash: 'c'.repeat(64) };
		mockFindHead
			.mockResolvedValueOnce(staleHead)
			.mockResolvedValueOnce(quarantinedHead)
			.mockResolvedValueOnce(enabledHead);
		const verify = jest.fn<(headId: string) => Promise<{ headIdentifier: string; initTxHash: string }>>(async () => ({
			headIdentifier: staleHead.headIdentifier,
			initTxHash: 'c'.repeat(64),
		}));

		await expect(updateHydraHeadEnabledState('head-1', true, verify)).resolves.toBe(enabledHead);

		expect(mockReleaseClose).toHaveBeenCalledWith({
			where: { id: 'head-1', retiredAt: null },
			data: { isEnabled: false, initTxHash: null, initChainSlot: null, initChainHash: null },
		});
		expect(verify).toHaveBeenCalledWith('head-1');
		expect(mockReleaseClose).toHaveBeenCalledWith({
			where: {
				id: 'head-1',
				isEnabled: false,
				retiredAt: null,
				initTxHash: null,
				updatedAt: quarantinedHead.updatedAt,
				headIdentifier: staleHead.headIdentifier,
				contestationPeriod: 86_400n,
			},
			data: { isEnabled: true, initTxHash: 'c'.repeat(64) },
		});
		expect(mockReconcileEnabledState).toHaveBeenCalledTimes(2);
	});

	// Connecting starts the head's history replay. Awaited, a long history kept
	// the request open through it, and the response query then failed behind
	// the replay: the UI said "still disabled" for a head that was enabled.
	it('answers a re-enable once the flag is durable, without waiting for the head to connect', async () => {
		const staleHead = {
			...openHead,
			isEnabled: false,
			headIdentifier: 'a'.repeat(56),
			initTxHash: 'b'.repeat(64),
			updatedAt: new Date('2026-07-23T01:00:00Z'),
			contestationPeriod: 86_400n,
			HydraRelation: {},
		};
		const quarantinedHead = { ...staleHead, initTxHash: null, updatedAt: new Date('2026-07-23T01:01:00Z') };
		const enabledHead = { ...quarantinedHead, isEnabled: true, initTxHash: 'c'.repeat(64) };
		mockFindHead
			.mockResolvedValueOnce(staleHead)
			.mockResolvedValueOnce(quarantinedHead)
			.mockResolvedValueOnce(enabledHead);
		mockReleaseClose.mockResolvedValue({ count: 1 });
		// The quarantine reconcile settles; the connect after enable never does.
		mockReconcileEnabledState.mockResolvedValueOnce(false).mockReturnValueOnce(new Promise(() => undefined));
		const verify = jest.fn<(headId: string) => Promise<{ headIdentifier: string; initTxHash: string }>>(async () => ({
			headIdentifier: staleHead.headIdentifier,
			initTxHash: 'c'.repeat(64),
		}));

		await expect(updateHydraHeadEnabledState('head-1', true, verify)).resolves.toBe(enabledHead);
		expect(mockReconcileEnabledState).toHaveBeenCalledTimes(2);
	});

	it('answers a re-enable even when connecting the head fails', async () => {
		const liveHead = { ...openHead, headIdentifier: 'a'.repeat(56), initTxHash: 'b'.repeat(64) };
		mockFindHead.mockResolvedValue(liveHead);
		mockReconcileEnabledState.mockRejectedValueOnce(new Error('pool timeout'));

		await expect(updateHydraHeadEnabledState('head-1', true, jest.fn() as AnyMock)).resolves.toBe(liveHead);
		// The rejection is handled, not left unhandled for the process to crash on.
		await new Promise((resolve) => setImmediate(resolve));
	});

	it('leaves an established head disabled when fresh L1 evidence is still unavailable', async () => {
		const staleHead = {
			...openHead,
			isEnabled: false,
			headIdentifier: 'a'.repeat(56),
			initTxHash: 'b'.repeat(64),
			updatedAt: new Date('2026-07-23T01:00:00Z'),
			contestationPeriod: 86_400n,
			HydraRelation: {},
		};
		mockFindHead.mockResolvedValueOnce(staleHead).mockResolvedValueOnce({
			...staleHead,
			isEnabled: false,
			initTxHash: null,
			updatedAt: new Date('2026-07-23T01:01:00Z'),
		});
		const verify = jest.fn<(headId: string) => Promise<{ headIdentifier: string; initTxHash: string }>>(async () => {
			throw new HydraHeadInitObservationError('not indexed');
		});

		await expect(updateHydraHeadEnabledState('head-1', true, verify)).rejects.toMatchObject({ statusCode: 503 });

		// Only the quarantine write ran: the enable CAS never did.
		expect(mockReleaseClose).toHaveBeenCalledTimes(1);
		expect(mockReconcileEnabledState).toHaveBeenCalledTimes(1);
	});

	it('keeps Close fail-closed after a post-dispatch command rejection', async () => {
		mockClose.mockRejectedValue(new HydraCommandRejectedError('Close rejected'));
		const handler = (
			closeHeadPost as unknown as {
				handler: (args: { input: { headId: string } }) => Promise<unknown>;
			}
		).handler;

		await expect(handler({ input: { headId: 'head-1' } })).rejects.toBeInstanceOf(HydraCommandRejectedError);

		expect(mockClaimClose).toHaveBeenCalled();
		expect(mockReleaseClose).not.toHaveBeenCalled();
	});

	it('releases the admission gate when the transport proves Close was never sent', async () => {
		mockClose.mockRejectedValue(new HydraTransportError('not sent'));
		const handler = (
			closeHeadPost as unknown as {
				handler: (args: { input: { headId: string } }) => Promise<unknown>;
			}
		).handler;

		await expect(handler({ input: { headId: 'head-1' } })).rejects.toBeInstanceOf(HydraTransportError);

		expect(mockReleaseClose).toHaveBeenCalledWith({
			where: { id: 'head-1', status: HydraHeadStatus.Open, isClosing: true },
			data: { isClosing: false, closingSince: null, closeRefusedAt: null },
		});
	});

	// The node's refusal is the only proof the stalled-close reaper accepts that
	// this Close cannot still post. It is recorded, never acted on here: the head
	// may have been closed by the other party, which only L1 can rule out.
	it('records a node refusal of the dispatched Close and keeps the latch', async () => {
		mockClose.mockRejectedValue(
			new HydraTransportAmbiguousError('Hydra Close was rejected after dispatch', {
				cause: new HydraCommandRejectedError('hydra-node refused to post the Close transaction: NoSeedInput'),
			}),
		);
		const handler = (
			closeHeadPost as unknown as {
				handler: (args: { input: { headId: string } }) => Promise<unknown>;
			}
		).handler;

		await expect(handler({ input: { headId: 'head-1' } })).rejects.toBeInstanceOf(HydraTransportAmbiguousError);

		expect(mockReleaseClose).toHaveBeenCalledTimes(1);
		expect(mockReleaseClose).toHaveBeenCalledWith({
			where: { id: 'head-1', status: HydraHeadStatus.Open, isClosing: true },
			data: { closeRefusedAt: expect.any(Date) },
		});
	});

	// A timeout after dispatch is the parked-Close case: the node may still post
	// it. No refusal is recorded, so the reaper never releases the latch.
	it('records nothing when the dispatched Close only timed out', async () => {
		mockClose.mockRejectedValue(new HydraTransportAmbiguousError('Hydra Close outcome was not observed'));
		const handler = (
			closeHeadPost as unknown as {
				handler: (args: { input: { headId: string } }) => Promise<unknown>;
			}
		).handler;

		await expect(handler({ input: { headId: 'head-1' } })).rejects.toBeInstanceOf(HydraTransportAmbiguousError);

		expect(mockReleaseClose).not.toHaveBeenCalled();
	});
});
