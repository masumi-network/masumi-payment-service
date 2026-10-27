/**
 * Task 7 ruling: a node `POST /commit` rejection carrying `DepositTooLarge`
 * (hydra-node 2.4.1's `HTTPServer.hs` dry-runs the increment and can answer
 * HTTP 400 with that tag) must surface as a clean, terminal `Failed` top-up —
 * the node's reason recorded, the hot wallet released, and no reservation
 * retained. The node refuses BEFORE anything is signed or submitted, so there
 * is no ambiguous in-flight body to reconcile; wedging the wallet for it would
 * be pure cost.
 *
 * This is a regression/characterization test, not a red-green pair: the
 * existing draft-refusal path in `executeHydraTopup` (the `try { ... } catch
 * (flowError) { ... } throw flowError` around `buildValidatedHydraCommit`,
 * plus the outer catch-all that fails the `Preparing` row and the `finally`
 * that releases the wallet) already handles ANY draft-time rejection this way
 * — no new branch was added here. What DID need a real fix is one layer down,
 * in `node-frames.ts` (see `node.spec.ts`): before that fix, the recorded
 * reason was the generic "Hydra HTTP request failed with 400 Bad Request",
 * with no way to tell DepositTooLarge from any other 4xx. This test proves the
 * plumbing ABOVE that point treats whatever reason reaches it correctly.
 */

import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { Prisma } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindUniqueHead = jest.fn() as AnyMock;
const mockCreateHeadError = jest.fn() as AnyMock;
const mockFindUniqueOrThrowHotWallet = jest.fn() as AnyMock;
const mockUpdateManyTopup = jest.fn() as AnyMock;
const mockUpdateTopup = jest.fn() as AnyMock;
const mockFindFirstTopup = jest.fn() as AnyMock;
const mockUpdateHead = jest.fn() as AnyMock;
const mockTxFindFirst = jest.fn() as AnyMock;
const mockTxCreate = jest.fn() as AnyMock;

const mockAssertNodeReadyForDeposit = jest.fn() as AnyMock;
const mockRecordHeadError = jest.fn() as AnyMock;
const mockVerifyPersistedHydraHeadOnChain = jest.fn() as AnyMock;
const mockGetHead = jest.fn() as AnyMock;
const mockGenerateWalletExtended = jest.fn() as AnyMock;
const mockBuildValidatedHydraCommit = jest.fn() as AnyMock;
const mockSelectCommitUtxos = jest.fn() as AnyMock;
const mockClaimHotWalletForL1 = jest.fn() as AnyMock;
const mockReleaseHotWalletAfterL1 = jest.fn() as AnyMock;
const mockReserveAndSubmitHydraTopup = jest.fn() as AnyMock;
const mockReconcilePendingHydraTopup = jest.fn() as AnyMock;
const mockInterpretCardanoTxSubmitResult = jest.fn() as AnyMock;
const mockLoggerError = jest.fn() as AnyMock;
const mockCarveExactUtxo = jest.fn() as AnyMock;

/** A stand-in for `HydraHttpResponseError`, without pulling in the real HTTP stack. */
class FakeHydraHttpResponseError extends Error {
	override readonly name = 'HydraHttpResponseError';
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

class FakeHydraCommitFlowError extends Error {
	override readonly name = 'HydraCommitFlowError';
}

jest.unstable_mockModule('@/services/hydra-host/pause', () => ({
	assertHydraHeadHostNotPaused: jest.fn(async () => undefined),
	isHydraHeadOnPausedHost: jest.fn(async () => false),
	isHydraHeadOnPausedHostLocked: jest.fn(async () => false),
	HYDRA_HOST_PAUSED_MESSAGE: 'hydra host is paused for maintenance',
}));

jest.unstable_mockModule('@/utils/hydra/deposit-admission', () => ({
	lockOpenHydraHeadForDeposit: jest.fn(async () => undefined),
}));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraHead: { findUnique: mockFindUniqueHead, update: mockUpdateHead },
		hydraHeadError: { create: mockCreateHeadError },
		hotWallet: { findUniqueOrThrow: mockFindUniqueOrThrowHotWallet },
		hydraTopup: {
			update: mockUpdateTopup,
			updateMany: mockUpdateManyTopup,
			findFirst: mockFindFirstTopup,
		},
		$transaction: (fn: (tx: unknown) => Promise<unknown>) =>
			fn({ hydraTopup: { findFirst: mockTxFindFirst, create: mockTxCreate, updateMany: jest.fn() } }),
	},
	Prisma: { TransactionIsolationLevel: { Serializable: 'Serializable' } },
}));

jest.unstable_mockModule('@masumi/payment-core/serializable-semaphore', () => ({
	withSerializableSlotRetry: (fn: () => Promise<unknown>) => fn(),
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: mockLoggerError, debug: jest.fn() },
}));

jest.unstable_mockModule('@/lib/hydra', () => ({
	buildValidatedHydraCommit: mockBuildValidatedHydraCommit,
	HydraCommitFlowError: FakeHydraCommitFlowError,
	HydraTransactionType: { TxConwayEra: 'TxConwayEra', UnwitnessedTxConwayEra: 'UnwitnessedTxConwayEra' },
	interpretCardanoTxSubmitResult: mockInterpretCardanoTxSubmitResult,
	selectCommitUtxos: mockSelectCommitUtxos,
}));

jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({ getHead: mockGetHead }),
}));

jest.unstable_mockModule('@/utils/generator/wallet-generator', () => ({
	generateWalletExtended: mockGenerateWalletExtended,
}));

jest.unstable_mockModule('@/utils/converter/network-convert', () => ({
	convertNetwork: (network: unknown) => network,
}));

jest.unstable_mockModule('@/utils/hydra/l2-slot-context', () => ({
	resolveHydraL2EvidenceSlotConfig: () => ({ zeroTime: 0, zeroSlot: 0, slotLength: 1000 }),
}));

jest.unstable_mockModule('@/services/hydra-topup-reconciliation', () => ({
	HydraTopupReservationConflictError: class extends Error {},
	reconcilePendingHydraTopup: mockReconcilePendingHydraTopup,
	reserveAndSubmitHydraTopup: mockReserveAndSubmitHydraTopup,
}));

jest.unstable_mockModule('@/routes/api/hydra/head/commit-flow-deps', () => ({
	buildHydraCommitFlowDeps: () => ({}),
}));

jest.unstable_mockModule('@/routes/api/hydra/head', () => ({
	assertNodeReadyForDeposit: mockAssertNodeReadyForDeposit,
	recordHeadError: mockRecordHeadError,
	verifyPersistedHydraHeadOnChain: mockVerifyPersistedHydraHeadOnChain,
}));

jest.unstable_mockModule('./pre-split', () => ({
	CARVE_VALIDITY_MS: 10 * 60 * 1000,
	carveExactUtxo: mockCarveExactUtxo,
	HydraPreSplitError: class extends Error {},
}));

jest.unstable_mockModule('@/utils/db/hot-wallet-lock', () => ({
	claimHotWalletForL1: mockClaimHotWalletForL1,
	releaseHotWalletAfterL1: mockReleaseHotWalletAfterL1,
}));

let executeHydraTopup: typeof import('./execute').executeHydraTopup;

beforeAll(async () => {
	const { recordHeadError } = await import('@/services/hydra-head-error/record');
	mockRecordHeadError.mockImplementation(recordHeadError);
	({ executeHydraTopup } = await import('./execute'));
});

const HEAD_ID = 'head-1';
const PARTICIPANT_ID = 'participant-1';
const WALLET_ID = 'wallet-1';
const TOPUP_ID = 'topup-1';

beforeEach(() => {
	jest.clearAllMocks();
	mockCreateHeadError.mockResolvedValue({});

	mockFindUniqueHead.mockResolvedValue({
		id: HEAD_ID,
		isEnabled: true,
		status: 'Open',
		headIdentifier: 'a'.repeat(64),
		LocalParticipant: { id: PARTICIPANT_ID, walletId: WALLET_ID },
	});
	mockGetHead.mockReturnValue({ commit: jest.fn(), cardanoTransaction: jest.fn() });
	mockAssertNodeReadyForDeposit.mockResolvedValue(undefined);
	mockClaimHotWalletForL1.mockResolvedValue('claim-token-1');
	mockVerifyPersistedHydraHeadOnChain.mockResolvedValue({ headIdentifier: 'a'.repeat(64) });
	mockFindUniqueOrThrowHotWallet.mockResolvedValue({
		id: WALLET_ID,
		Secret: { encryptedMnemonic: 'enc-mnemonic' },
		PaymentSource: { network: 'Preprod', PaymentSourceConfig: { rpcProviderApiKey: 'key' } },
	});
	mockTxFindFirst.mockResolvedValue(null); // no active top-up
	mockTxCreate.mockResolvedValue({ id: TOPUP_ID });
	mockUpdateTopup.mockResolvedValue({ id: TOPUP_ID });
	mockGenerateWalletExtended.mockResolvedValue({
		wallet: {},
		address: 'addr_test1...',
		utxos: [
			{
				input: { txHash: 'a'.repeat(64), outputIndex: 0 },
				output: { address: 'addr_test1...', amount: [{ unit: 'lovelace', quantity: '5000000' }] },
			},
		],
		vKey: 'vkey',
		blockchainProvider: {},
	});
	mockSelectCommitUtxos.mockImplementation((utxos: unknown[]) => ({ commitUtxos: utxos }));
	mockFindFirstTopup.mockResolvedValue(null); // nothing else outstanding, in the `finally` probe
	mockUpdateManyTopup.mockResolvedValue({ count: 1 });
	mockUpdateHead.mockResolvedValue(undefined);
	mockReleaseHotWalletAfterL1.mockResolvedValue(undefined);
});

describe('executeHydraTopup pre-split', () => {
	it('stores the signed hash and bound before submission, then releases a confirmed carve after a draft refusal', async () => {
		const carved = {
			input: { txHash: 'a'.repeat(64), outputIndex: 0 },
			output: { address: 'addr_test1...', amount: [{ unit: 'lovelace', quantity: '5000000' }] },
		};
		const wallet = { getUtxos: jest.fn(async () => [carved]) };
		mockGenerateWalletExtended.mockResolvedValue({
			wallet,
			address: 'addr_test1...',
			utxos: [carved],
			vKey: 'vkey',
			blockchainProvider: {},
		});
		mockCarveExactUtxo.mockImplementation(
			async (params: { onCarveSubmitted: (hash: string, slot: bigint) => Promise<void> }) => {
				await params.onCarveSubmitted('b'.repeat(64), 600n);
				return carved;
			},
		);
		mockBuildValidatedHydraCommit.mockRejectedValue(new FakeHydraCommitFlowError('draft rejected'));

		await expect(
			executeHydraTopup({ headId: HEAD_ID, filter: 'ada-only', exact: { unit: 'lovelace', amount: 5_000_000n } }),
		).rejects.toThrow('draft rejected');
		expect(mockUpdateTopup).toHaveBeenCalledWith({
			where: { id: TOPUP_ID, status: 'Preparing' },
			data: { splitTxHash: 'b'.repeat(64), splitInvalidHereafterSlot: 600n },
		});
		expect(mockReleaseHotWalletAfterL1).toHaveBeenCalledWith(WALLET_ID, 'claim-token-1');
	});
});

describe('executeHydraTopup deposit claim', () => {
	it('refuses a second deposit while the earlier L1 deposit is confirmed but not absorbed', async () => {
		mockTxFindFirst.mockImplementation(async (query: { where: { status: { in?: string[] } | string } }) => {
			const status = query.where.status;
			return typeof status === 'object' && status.in?.includes('Confirmed')
				? { id: 'earlier-topup', status: 'Confirmed' }
				: null;
		});

		await expect(executeHydraTopup({ headId: HEAD_ID, filter: 'all' })).rejects.toMatchObject({
			status: 409,
			message: expect.stringContaining('not been absorbed or recovered'),
		});

		expect(mockTxFindFirst).toHaveBeenCalledWith({
			where: {
				hydraLocalParticipantId: PARTICIPANT_ID,
				status: { in: ['Pending', 'Confirmed'] },
			},
			orderBy: { createdAt: 'desc' },
		});
		expect(mockTxCreate).not.toHaveBeenCalled();
		expect(mockGenerateWalletExtended).not.toHaveBeenCalled();
		expect(mockReleaseHotWalletAfterL1).toHaveBeenCalledWith(WALLET_ID, 'claim-token-1');
	});
});

describe('executeHydraTopup — DepositTooLarge draft refusal', () => {
	it('fails the top-up cleanly, records the node reason, and releases the wallet — no reservation retained', async () => {
		const depositTooLarge = new FakeHydraHttpResponseError(
			'Hydra HTTP request failed with 400 Bad Request (DepositTooLarge)',
			400,
		);
		mockBuildValidatedHydraCommit.mockRejectedValue(depositTooLarge);

		await expect(executeHydraTopup({ headId: HEAD_ID, filter: 'all' })).rejects.toThrow('DepositTooLarge');

		// Confirms the failure genuinely came from the draft-refusal path (the
		// node's own commit draft), not an earlier, unrelated short-circuit that
		// happens to also satisfy the assertions below.
		expect(mockClaimHotWalletForL1).toHaveBeenCalled();
		expect(mockBuildValidatedHydraCommit).toHaveBeenCalled();

		// Terminal Failed status on the row this call created — not left Preparing
		// or Pending for a reconciler that has nothing to reconcile.
		expect(mockUpdateManyTopup).toHaveBeenCalledWith({
			where: { id: TOPUP_ID, status: 'Preparing' },
			data: { status: 'Failed' },
		});

		// The node's own reason, not just a generic failure, ends up in the
		// recorded head error.
		expect(mockRecordHeadError).toHaveBeenCalledWith(
			HEAD_ID,
			'Open',
			'CommandFailed',
			expect.objectContaining({ message: expect.stringContaining('DepositTooLarge') }),
			'Topup',
		);

		// Nothing else was left outstanding (the row is Failed) and no carve ran
		// (whole-UTxO top-up), so the wallet is handed back rather than wedged.
		expect(mockReleaseHotWalletAfterL1).toHaveBeenCalledWith(WALLET_ID, 'claim-token-1');
	});
});

describe('executeHydraTopup wallet release ownership', () => {
	const signedDeposit = {
		txId: 'b'.repeat(64),
		invalidHereafterSlot: 1_000n,
		signedCommitTx: 'signed-deposit',
		committedValue: new Map([['lovelace', 5_000_000n]]),
	};

	beforeEach(() => {
		mockBuildValidatedHydraCommit.mockResolvedValue(signedDeposit);
		mockReserveAndSubmitHydraTopup.mockImplementation(
			async (reservation: { topupId: string }, submit: () => Promise<unknown>) => ({
				topupId: reservation.topupId,
				submitResult: await submit(),
			}),
		);
		mockInterpretCardanoTxSubmitResult.mockReturnValue({ ok: true });
	});

	it('refuses a deposit when chain sync is lost while the draft is built', async () => {
		const cardanoTransaction = jest.fn();
		const noLongerReady = Object.assign(new Error('chain observation is stale'), { status: 503 });
		mockGetHead.mockReturnValue({ cardanoTransaction });
		mockBuildValidatedHydraCommit.mockImplementation(async () => {
			mockAssertNodeReadyForDeposit.mockRejectedValue(noLongerReady);
			return signedDeposit;
		});

		await expect(executeHydraTopup({ headId: HEAD_ID, filter: 'all' })).rejects.toBe(noLongerReady);

		expect(mockAssertNodeReadyForDeposit).toHaveBeenCalledTimes(2);
		expect(mockReserveAndSubmitHydraTopup).not.toHaveBeenCalled();
		expect(cardanoTransaction).not.toHaveBeenCalled();
		expect(mockUpdateManyTopup).toHaveBeenCalledWith({
			where: { id: TOPUP_ID, status: 'Preparing' },
			data: { status: 'Failed' },
		});
	});

	it('refuses a deposit when chain sync is lost during reservation', async () => {
		const cardanoTransaction = jest.fn();
		const noLongerReady = Object.assign(new Error('chain observation is stale'), { status: 503 });
		mockGetHead.mockReturnValue({ cardanoTransaction });
		mockReserveAndSubmitHydraTopup.mockImplementation(async (_reservation: unknown, submit: () => Promise<unknown>) => {
			mockAssertNodeReadyForDeposit.mockRejectedValueOnce(noLongerReady);
			return await submit();
		});

		await expect(executeHydraTopup({ headId: HEAD_ID, filter: 'all' })).rejects.toBe(noLongerReady);

		expect(mockAssertNodeReadyForDeposit).toHaveBeenCalledTimes(3);
		expect(cardanoTransaction).not.toHaveBeenCalled();
	});

	it('does not release a newer claim after the scheduler wins reconciliation', async () => {
		let walletOwner = TOPUP_ID;
		mockReleaseHotWalletAfterL1.mockImplementation(async () => {
			walletOwner = '';
		});
		mockReconcilePendingHydraTopup.mockImplementation(async () => {
			// The scheduler wins the Pending CAS and releases this operation's lock.
			await mockReleaseHotWalletAfterL1(WALLET_ID);
			walletOwner = 'next-topup';
			return 'raced';
		});

		await executeHydraTopup({ headId: HEAD_ID, filter: 'all' });

		expect(mockReleaseHotWalletAfterL1).toHaveBeenCalledTimes(1);
		expect(walletOwner).toBe('next-topup');
	});

	it('does not release after ambiguous submission when the scheduler already settled the row', async () => {
		mockGetHead.mockReturnValue({
			cardanoTransaction: jest.fn(async () => {
				await mockReleaseHotWalletAfterL1(WALLET_ID);
				throw new Error('connection reset');
			}),
		});

		await expect(executeHydraTopup({ headId: HEAD_ID, filter: 'all' })).rejects.toThrow('connection reset');

		expect(mockReleaseHotWalletAfterL1).toHaveBeenCalledTimes(1);
	});

	it('releases when inline reconciliation wins confirmation', async () => {
		mockReconcilePendingHydraTopup.mockResolvedValue('confirmed');

		await executeHydraTopup({ headId: HEAD_ID, filter: 'all' });

		expect(mockReleaseHotWalletAfterL1).toHaveBeenCalledTimes(1);
	});

	it('releases when inline reconciliation wins failure without a carve', async () => {
		mockReconcilePendingHydraTopup.mockResolvedValue('failed');

		await executeHydraTopup({ headId: HEAD_ID, filter: 'all' });

		expect(mockReleaseHotWalletAfterL1).toHaveBeenCalledTimes(1);
	});

	it('releases when reservation promotion fails before ownership transfers', async () => {
		mockReserveAndSubmitHydraTopup.mockRejectedValue(new Error('promotion failed'));

		await expect(executeHydraTopup({ headId: HEAD_ID, filter: 'all' })).rejects.toThrow('promotion failed');

		expect(mockReleaseHotWalletAfterL1).toHaveBeenCalledTimes(1);
	});

	it('keeps release ownership with reconciliation after a reconciliation error', async () => {
		mockReconcilePendingHydraTopup.mockRejectedValue(new Error('lookup failed'));

		await expect(executeHydraTopup({ headId: HEAD_ID, filter: 'all' })).rejects.toThrow('lookup failed');

		expect(mockReleaseHotWalletAfterL1).not.toHaveBeenCalled();
	});

	it('keeps the submitted deposit lock while reconciliation remains pending', async () => {
		mockReconcilePendingHydraTopup.mockResolvedValue('pending');
		mockFindFirstTopup.mockResolvedValue({ id: TOPUP_ID });

		await executeHydraTopup({ headId: HEAD_ID, filter: 'all' });

		expect(mockReleaseHotWalletAfterL1).not.toHaveBeenCalled();
	});
});

describe('executeHydraTopup verification errors', () => {
	const verificationFailures = [
		{
			label: 'a database failure',
			error: new Prisma.PrismaClientKnownRequestError(
				'Invalid `prisma.hydraHead.findUnique()` invocation in /srv/masumi/src/routes/api/hydra/head/index.ts:327:36: connection timeout',
				{ code: 'P2024', clientVersion: '7.8.0' },
			),
			reason: 'the database rejected the write (P2024)',
		},
		{
			label: 'an ordinary verification failure',
			error: new Error('the observed head has different participants'),
			reason: 'the observed head has different participants',
		},
	];

	it.each(verificationFailures)('reports and records a safe reason for $label', async ({ error, reason }) => {
		mockVerifyPersistedHydraHeadOnChain.mockRejectedValueOnce(error);
		const message = `Refusing to sign for an unverified Hydra head: ${reason}`;

		await expect(executeHydraTopup({ headId: 'head-1', filter: 'all' })).rejects.toMatchObject({
			status: 502,
			message,
		});

		expect(mockCreateHeadError).toHaveBeenCalledWith({
			data: {
				hydraHeadId: 'head-1',
				errorType: 'CommandFailed',
				errorMessage: message,
				headStatus: 'Open',
				clientInput: 'Topup',
				errorAt: expect.any(Date),
			},
		});
	});
});
