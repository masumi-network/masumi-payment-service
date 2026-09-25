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

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindUniqueHead = jest.fn() as AnyMock;
const mockFindUniqueOrThrowHotWallet = jest.fn() as AnyMock;
const mockUpdateManyTopup = jest.fn() as AnyMock;
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
const mockLoggerError = jest.fn() as AnyMock;

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

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraHead: { findUnique: mockFindUniqueHead, update: mockUpdateHead },
		hotWallet: { findUniqueOrThrow: mockFindUniqueOrThrowHotWallet },
		hydraTopup: {
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
	interpretCardanoTxSubmitResult: jest.fn(),
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
	reconcilePendingHydraTopup: jest.fn(),
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
	carveExactUtxo: jest.fn(),
	HydraPreSplitError: class extends Error {},
}));

jest.unstable_mockModule('@/utils/db/hot-wallet-lock', () => ({
	claimHotWalletForL1: mockClaimHotWalletForL1,
	releaseHotWalletAfterL1: mockReleaseHotWalletAfterL1,
}));

let executeHydraTopup: typeof import('./execute').executeHydraTopup;

beforeAll(async () => {
	({ executeHydraTopup } = await import('./execute'));
});

const HEAD_ID = 'head-1';
const PARTICIPANT_ID = 'participant-1';
const WALLET_ID = 'wallet-1';
const TOPUP_ID = 'topup-1';

beforeEach(() => {
	jest.clearAllMocks();

	mockFindUniqueHead.mockResolvedValue({
		id: HEAD_ID,
		isEnabled: true,
		status: 'Open',
		headIdentifier: 'a'.repeat(64),
		LocalParticipant: { id: PARTICIPANT_ID, walletId: WALLET_ID },
	});
	mockGetHead.mockReturnValue({ commit: jest.fn(), cardanoTransaction: jest.fn() });
	mockAssertNodeReadyForDeposit.mockResolvedValue(undefined);
	mockClaimHotWalletForL1.mockResolvedValue(undefined);
	mockVerifyPersistedHydraHeadOnChain.mockResolvedValue({ headIdentifier: 'a'.repeat(64) });
	mockFindUniqueOrThrowHotWallet.mockResolvedValue({
		id: WALLET_ID,
		Secret: { encryptedMnemonic: 'enc-mnemonic' },
		PaymentSource: { network: 'Preprod', PaymentSourceConfig: { rpcProviderApiKey: 'key' } },
	});
	mockTxFindFirst.mockResolvedValue(null); // no active top-up
	mockTxCreate.mockResolvedValue({ id: TOPUP_ID });
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
		expect(mockReleaseHotWalletAfterL1).toHaveBeenCalledWith(WALLET_ID);
	});
});
