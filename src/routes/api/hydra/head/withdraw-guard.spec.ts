/**
 * A withdrawal is refused to the operator's face, not to a log file.
 *
 * The endpoint answers before the work runs, and the executor raises six
 * refusals ahead of the block that records anything. This handler mirrored four
 * of them: a head with no local participant, and a node still replaying its
 * chain history, both answered `accepted: true`. The UI then toasted
 * "Withdrawal started. It appears below" and pointed at a list that stayed
 * empty forever — no `HydraDecommit` row, no head error, one log line.
 *
 * The three refusals the executor decides inside its slot claim have the same
 * problem: a withdrawal already in progress, a collateral drain with escrows
 * still live, and a wallet another transaction holds. Each answered
 * `accepted: true` and was refused a moment later, with the reason in the head's
 * error list, or in a log alone for the wallet.
 */

import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import createHttpError from 'http-errors';
import { HydraDecommitStatus, HydraHeadStatus } from '@/generated/prisma/client';
import { PENDING_STALE_AFTER_MS, PREPARING_STALE_AFTER_MS } from '@/services/hydra-decommit/stale';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindHead = jest.fn() as AnyMock;
const mockFindWithdrawals = jest.fn() as AnyMock;
const mockFindActive = jest.fn() as AnyMock;
const mockWalletCount = jest.fn() as AnyMock;
const mockCountLiveEscrows = jest.fn() as AnyMock;
const mockGetHead = jest.fn() as AnyMock;
const mockAssertReady = jest.fn() as AnyMock;
const mockExecute = jest.fn() as AnyMock;
const mockLoggerError = jest.fn() as AnyMock;

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
		hydraHead: { findUnique: mockFindHead },
		hydraDecommit: { findMany: mockFindWithdrawals, findFirst: mockFindActive },
		hotWallet: { count: mockWalletCount },
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: mockLoggerError, debug: jest.fn() },
}));

jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({ getHead: mockGetHead }),
}));

jest.unstable_mockModule('@/routes/api/hydra/head', () => ({
	assertNodeReadyForDeposit: mockAssertReady,
}));

jest.unstable_mockModule('@/services/hydra-decommit/execute', () => ({ executeHydraDecommit: mockExecute }));

jest.unstable_mockModule('@/services/hydra-decommit/live-escrows', () => ({
	countLiveInHeadEscrows: mockCountLiveEscrows,
}));

let listWithdrawalsGet: { handler: (args: { input: unknown }) => Promise<unknown> };
let withdrawHeadPost: { handler: (args: { input: unknown }) => Promise<unknown> };
let withdrawInput: { safeParse: (input: unknown) => { success: boolean } };

beforeAll(async () => {
	({ withdrawHeadPost, listWithdrawalsGet, withdrawInput } = (await import('./withdraw')) as never);
});

beforeEach(() => {
	jest.clearAllMocks();
	mockFindHead.mockResolvedValue({
		isEnabled: true,
		status: HydraHeadStatus.Open,
		headIdentifier: 'a'.repeat(64),
		LocalParticipant: { id: 'participant-1', walletId: 'wallet-1' },
	});
	mockGetHead.mockReturnValue({});
	mockAssertReady.mockResolvedValue(undefined);
	mockExecute.mockResolvedValue({ decommitId: 'decommit-1' });
	mockFindActive.mockResolvedValue(null);
	mockCountLiveEscrows.mockResolvedValue(0);
	mockWalletCount.mockResolvedValue(1);
});

const input = { headId: 'head-1', lovelace: '10000000', drain: false };

describe('withdrawHeadPost pre-flight', () => {
	it('accepts once the head, the session and the node all answer', async () => {
		await expect(withdrawHeadPost.handler({ input })).resolves.toMatchObject({ accepted: true });
		expect(mockExecute).toHaveBeenCalled();
	});

	// The node is up but behind. A withdrawal has no L1 deadline to miss, but it
	// needs the head to sign a snapshot and a node still catching up will not —
	// so the request only ever becomes a reservation nobody resolves.
	it('refuses while the node is still catching up', async () => {
		mockAssertReady.mockRejectedValue(Object.assign(new Error('still catching up'), { statusCode: 409 }));

		await expect(withdrawHeadPost.handler({ input })).rejects.toMatchObject({ message: 'still catching up' });
		expect(mockExecute).not.toHaveBeenCalled();
	});

	it('refuses a head with no node on this side', async () => {
		mockFindHead.mockResolvedValue({
			isEnabled: true,
			status: HydraHeadStatus.Open,
			headIdentifier: 'a'.repeat(64),
			LocalParticipant: null,
		});

		await expect(withdrawHeadPost.handler({ input })).rejects.toMatchObject({ statusCode: 400 });
		expect(mockAssertReady).not.toHaveBeenCalled();
		expect(mockExecute).not.toHaveBeenCalled();
	});
});

describe('withdrawHeadPost slot refusals', () => {
	const ago = (ms: number) => new Date(Date.now() - ms);
	const active = (overrides: Record<string, unknown>) => ({
		id: 'decommit-0',
		status: HydraDecommitStatus.Preparing,
		decommitTxId: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	});

	it('refuses while a withdrawal from this participant is in progress', async () => {
		mockFindActive.mockResolvedValue(active({}));

		await expect(withdrawHeadPost.handler({ input })).rejects.toMatchObject({
			statusCode: 409,
			message: expect.stringContaining('already in progress'),
		});
		expect(mockFindActive).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ hydraLocalParticipantId: 'participant-1' }),
			}),
		);
		expect(mockExecute).not.toHaveBeenCalled();
	});

	it('refuses while a prior withdrawal is still settling on L1', async () => {
		mockFindActive.mockResolvedValue(active({ status: HydraDecommitStatus.Approved }));

		await expect(withdrawHeadPost.handler({ input })).rejects.toMatchObject({
			statusCode: 409,
			message: expect.stringContaining('still settling on L1'),
		});
		expect(mockExecute).not.toHaveBeenCalled();
	});

	// The executor expires these itself, and the Pending one only on the node's
	// word, so refusing them here would block a withdrawal that works today.
	it.each([
		['a Preparing row nothing resolved', { createdAt: ago(PREPARING_STALE_AFTER_MS + 1000) }],
		[
			'an old Pending row the node must be asked about',
			{ status: HydraDecommitStatus.Pending, updatedAt: ago(PENDING_STALE_AFTER_MS + 1000) },
		],
	])('still accepts over %s', async (_label, overrides) => {
		mockFindActive.mockResolvedValue(active(overrides));

		await expect(withdrawHeadPost.handler({ input })).resolves.toMatchObject({ accepted: true });
		expect(mockExecute).toHaveBeenCalled();
	});

	it('refuses a collateral drain while escrows are still live, naming how many', async () => {
		mockCountLiveEscrows.mockResolvedValue(2);

		await expect(withdrawHeadPost.handler({ input: { ...input, drain: true } })).rejects.toMatchObject({
			statusCode: 409,
			message: expect.stringContaining('(2 found)'),
		});
		expect(mockCountLiveEscrows).toHaveBeenCalledWith(expect.anything(), 'head-1');
		expect(mockExecute).not.toHaveBeenCalled();
	});

	it('accepts a collateral drain once no escrow is live', async () => {
		await expect(withdrawHeadPost.handler({ input: { ...input, drain: true } })).resolves.toMatchObject({
			accepted: true,
		});
		expect(mockExecute).toHaveBeenCalled();
	});

	it('counts no escrows for a withdrawal that leaves the collateral alone', async () => {
		mockCountLiveEscrows.mockResolvedValue(2);

		await expect(withdrawHeadPost.handler({ input })).resolves.toMatchObject({ accepted: true });
		expect(mockCountLiveEscrows).not.toHaveBeenCalled();
	});

	it('refuses while another transaction holds the wallet', async () => {
		mockWalletCount.mockResolvedValue(0);

		await expect(withdrawHeadPost.handler({ input })).rejects.toMatchObject({
			statusCode: 409,
			message: expect.stringContaining('wallet is busy'),
		});
		expect(mockWalletCount).toHaveBeenCalledWith({
			where: { id: 'wallet-1', deletedAt: null, lockedAt: null, pendingTransactionId: null, lockPurpose: null },
		});
		expect(mockExecute).not.toHaveBeenCalled();
	});
});

describe('withdraw amount limits', () => {
	const unit = 'ab'.repeat(30);

	it.each([
		['the largest lovelace amount a BigInt column holds', { lovelace: '9223372036854775807' }, true],
		['one more than that', { lovelace: '9223372036854775808' }, false],
		['the largest token amount', { assetUnit: unit, assetAmount: '18446744073709551615' }, true],
		['one more than that', { assetUnit: unit, assetAmount: '18446744073709551616' }, false],
	])('reads %s', (_label, amount, accepted) => {
		expect(withdrawInput.safeParse({ headId: 'head-1', ...amount }).success).toBe(accepted);
	});
});

describe('withdrawal list paging', () => {
	it('resumes from an inclusive cursor in a fixed newest-first order', async () => {
		mockFindHead.mockResolvedValue({ id: 'head-1' });
		mockFindWithdrawals.mockResolvedValue([]);
		await listWithdrawalsGet.handler({ input: { headId: 'head-1', limit: 10, cursorId: 'decommit-9' } });
		expect(mockFindWithdrawals).toHaveBeenCalledWith({
			where: { hydraHeadId: 'head-1' },
			orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
			take: 10,
			cursor: { id: 'decommit-9' },
		});
	});
});

describe('withdrawHeadPost answers on acceptance', () => {
	it('W-R1 answers with the executor refusal when it refuses before accepting', async () => {
		mockExecute.mockRejectedValue(
			createHttpError(
				400,
				'Only 115000000 lovelace is eligible to withdraw, which is less than the 1000000000 requested',
			),
		);
		await expect(withdrawHeadPost.handler({ input })).rejects.toMatchObject({
			statusCode: 400,
			message: expect.stringContaining('is eligible to withdraw'),
		});
		expect(mockLoggerError).not.toHaveBeenCalled();
	});

	// In production an unexposed 5xx answers with only its default message.
	it('W-R1b shows the reason of a 5xx refusal before accepting', async () => {
		mockExecute.mockRejectedValue(createHttpError(504, 'The in-head split abc was not confirmed within 60s'));
		await expect(withdrawHeadPost.handler({ input })).rejects.toMatchObject({ statusCode: 504, expose: true });
	});

	it('W-R1c answers an unexpected error before accepting with its reason', async () => {
		mockExecute.mockRejectedValue(new Error('TxInvalid: split input unknown'));
		await expect(withdrawHeadPost.handler({ input })).rejects.toMatchObject({
			statusCode: 500,
			expose: true,
			message: 'TxInvalid: split input unknown',
		});
	});

	it('W-R2 does not answer before the executor accepts', async () => {
		let accept: () => void = () => undefined;
		mockExecute.mockImplementation((params: { onAccepted: () => void }) => {
			accept = params.onAccepted;
			return new Promise(() => undefined); // keeps running after the answer
		});
		let answered = false;
		const answer = withdrawHeadPost.handler({ input }).then(() => {
			answered = true;
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(answered).toBe(false);
		accept();
		await answer;
		expect(answered).toBe(true);
		expect(mockExecute).toHaveBeenCalledWith(
			expect.objectContaining({ headId: 'head-1', onAccepted: expect.any(Function) }),
		);
	});

	it('W-R3 still answers accepted when the node rejects after acceptance, and logs it', async () => {
		mockExecute.mockImplementation(async (params: { onAccepted: () => void }) => {
			params.onAccepted();
			throw new Error('Hydra node rejected the withdrawal: DecommitInvalid');
		});
		await expect(withdrawHeadPost.handler({ input })).resolves.toMatchObject({ accepted: true });
		await new Promise((resolve) => setImmediate(resolve));
		expect(mockLoggerError).toHaveBeenCalledWith(expect.stringContaining('DecommitInvalid'));
	});
});
