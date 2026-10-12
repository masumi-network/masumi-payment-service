import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import createHttpError from 'http-errors';

type AsyncFn = (...args: unknown[]) => Promise<unknown>;
const mockFindUnique = jest.fn<AsyncFn>();
const mockClaim = jest.fn<AsyncFn>();
const mockRelease = jest.fn<AsyncFn>();
const mockRecoverOnL1 = jest.fn<AsyncFn>();
const mockLookup = jest.fn<AsyncFn>();

class DepositNotRecoverableError extends Error {}
class DepositDatumError extends Error {}

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn() } }));
jest.unstable_mockModule('@masumi/payment-core/db', () => ({ prisma: { hotWallet: { findUnique: mockFindUnique } } }));
jest.unstable_mockModule('@masumi/payment-source-v2/hydra-deposit/deposit-datum', () => ({ DepositDatumError }));
jest.unstable_mockModule('@masumi/payment-source-v2/hydra-deposit/recover-tx', () => ({
	DepositNotRecoverableError,
	recoverDepositOnL1: mockRecoverOnL1,
}));
jest.unstable_mockModule('@/services/shared/chain-tx-lookup', () => ({ lookupConfirmedChainTx: mockLookup }));
jest.unstable_mockModule('@/utils/db/hot-wallet-lock', () => ({
	claimHotWalletForL1: mockClaim,
	releaseHotWalletAfterL1: mockRelease,
}));
jest.unstable_mockModule('@/utils/hydra/l2-slot-context', () => ({
	resolveHydraL2EvidenceSlotConfig: () => ({
		zeroTime: 0,
		zeroSlot: 0,
		slotLength: 1000,
		startEpoch: 0,
		epochLength: 1,
	}),
}));
jest.unstable_mockModule('@/utils/security/encryption', () => ({ decrypt: () => 'word1 word2' }));

const { recoverDepositWithoutNode } = await import('./recover-on-l1');

const DEPOSIT = 'ab'.repeat(32);
const RECOVER = 'ef'.repeat(32);
const VALID_UNTIL = Date.now() + 10 * 60 * 1000;
type OnSigned = (signed: { txHash: string; validUntilMs: number }) => Promise<void>;
const params = { hotWalletId: 'hw-1', depositTxHash: DEPOSIT, headIdentifier: 'cd'.repeat(28) };

beforeEach(() => {
	jest.clearAllMocks();
	jest.useFakeTimers();
	mockFindUnique.mockResolvedValue({
		Secret: { encryptedMnemonic: 'enc' },
		PaymentSource: { network: 'Preprod', PaymentSourceConfig: { rpcProviderApiKey: 'bf' } },
	});
	mockClaim.mockResolvedValue(undefined);
	mockRelease.mockResolvedValue(undefined);
	mockRecoverOnL1.mockImplementation(async (input) => {
		await (input as { onSigned: OnSigned }).onSigned({ txHash: RECOVER, validUntilMs: VALID_UNTIL });
		return { txHash: RECOVER, validUntilMs: VALID_UNTIL };
	});
});

afterEach(() => {
	jest.useRealTimers();
});

describe('recoverDepositWithoutNode', () => {
	it('claims the fee wallet, posts the recover and keeps the wallet while it is pending', async () => {
		await expect(recoverDepositWithoutNode(params)).resolves.toEqual({ recoverTxHash: RECOVER });
		expect(mockClaim).toHaveBeenCalledWith('hw-1', 'deposit recovery');
		expect(mockRecoverOnL1).toHaveBeenCalledWith(
			expect.objectContaining({
				rpcApiKey: 'bf',
				network: 'preprod',
				depositTxHash: DEPOSIT,
				expectedHeadId: 'cd'.repeat(28),
				mnemonic: ['word1', 'word2'],
			}),
		);
		expect(mockRelease).not.toHaveBeenCalled();
	});

	it('releases the wallet once the recover confirms', async () => {
		mockLookup.mockResolvedValue('confirmed-valid');
		await recoverDepositWithoutNode(params);
		await jest.advanceTimersByTimeAsync(15_000);
		expect(mockLookup).toHaveBeenCalledWith(expect.objectContaining({ txHash: RECOVER }));
		expect(mockRelease).toHaveBeenCalledWith('hw-1');
	});

	it('releases the wallet once an unconfirmed recover has expired', async () => {
		mockLookup.mockResolvedValue('not-found');
		await recoverDepositWithoutNode(params);
		await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
		expect(mockRelease).not.toHaveBeenCalled();
		await jest.advanceTimersByTimeAsync(6 * 60 * 1000);
		expect(mockRelease).toHaveBeenCalledWith('hw-1');
	});

	it('maps a deposit the chain says cannot be recovered to 409 and frees the wallet', async () => {
		mockRecoverOnL1.mockRejectedValue(new DepositNotRecoverableError('already spent'));
		await expect(recoverDepositWithoutNode(params)).rejects.toMatchObject({ status: 409, message: 'already spent' });
		expect(mockRelease).toHaveBeenCalledWith('hw-1');
	});

	it('maps a build failure to 502 and frees the wallet', async () => {
		mockRecoverOnL1.mockRejectedValue(new Error('no collateral'));
		await expect(recoverDepositWithoutNode(params)).rejects.toMatchObject({ status: 502 });
		expect(mockRelease).toHaveBeenCalledWith('hw-1');
	});

	it('keeps the wallet when a signed recover may still land', async () => {
		mockRecoverOnL1.mockImplementation(async (input) => {
			await (input as { onSigned: OnSigned }).onSigned({ txHash: RECOVER, validUntilMs: VALID_UNTIL });
			throw new Error('socket hang up');
		});
		await expect(recoverDepositWithoutNode(params)).rejects.toMatchObject({
			status: 502,
			message: expect.stringContaining(RECOVER),
		});
		expect(mockRelease).not.toHaveBeenCalled();
	});

	it('posts nothing while another transaction holds the wallet', async () => {
		mockClaim.mockRejectedValue(createHttpError(409, 'busy'));
		await expect(recoverDepositWithoutNode(params)).rejects.toMatchObject({ status: 409 });
		expect(mockRecoverOnL1).not.toHaveBeenCalled();
	});
});
