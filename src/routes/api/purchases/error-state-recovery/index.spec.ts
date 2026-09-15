import { beforeEach, expect, it, jest } from '@jest/globals';
import { testEndpoint } from 'express-zod-api';
import {
	ApiKeyStatus,
	Network,
	OnChainState,
	PurchaseErrorType,
	PurchasingAction,
	TransactionStatus,
} from '@/generated/prisma/client';
import { purchaseResponseSchema } from '../schemas';

const findApiKey = jest.fn<(...args: any[]) => any>();
const findPurchase = jest.fn<(...args: any[]) => any>();
const findCurrentPurchase = jest.fn<(...args: any[]) => any>();
const updatePurchase = jest.fn<(...args: any[]) => any>();
const updateTransaction = jest.fn<(...args: any[]) => any>();
const transaction = jest.fn<(...args: any[]) => any>();

jest.unstable_mockModule('../index', () => ({ purchaseResponseSchema }));
jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		apiKey: { findUnique: findApiKey },
		purchaseRequest: { findFirst: findPurchase },
		$transaction: transaction,
	},
}));

const { purchaseErrorStateRecoveryPost } = await import('./index');
const updatedAt = new Date('2026-09-15T14:21:46.000Z');

function initialPurchase() {
	return {
		id: 'purchase',
		nextActionId: 'manual',
		updatedAt,
		onChainState: null,
		smartContractWalletId: 'wallet',
		NextAction: { requestedAction: PurchasingAction.WaitingForManualAction, errorType: PurchaseErrorType.Unknown },
		ActionHistory: [{ requestedAction: PurchasingAction.FundsLockingInitiated }],
		TransactionHistory: [],
		CurrentTransaction: null,
	};
}

beforeEach(() => {
	jest.clearAllMocks();
	findApiKey.mockResolvedValue({
		id: 'admin',
		canRead: true,
		canPay: true,
		canAdmin: true,
		status: ApiKeyStatus.Active,
		networkLimit: [Network.Mainnet],
		walletScopeEnabled: false,
		WalletScopes: [],
		usageLimited: false,
	});
	findPurchase.mockResolvedValue(initialPurchase());
	findCurrentPurchase.mockResolvedValue(initialPurchase());
	transaction.mockImplementation(async (callback) =>
		callback({
			purchaseRequest: { findFirst: findCurrentPurchase, update: updatePurchase },
			transaction: { update: updateTransaction },
		}),
	);
});

async function retry() {
	return testEndpoint({
		endpoint: purchaseErrorStateRecoveryPost,
		requestProps: {
			method: 'POST',
			headers: { token: 'valid' },
			body: {
				blockchainIdentifier: 'purchase-chain-id',
				network: Network.Mainnet,
				updatedAt: updatedAt.toISOString(),
				retryPreviousAction: true,
			},
		},
	});
}

it('rejects the incident state before opening a write transaction', async () => {
	findPurchase.mockResolvedValue({ ...initialPurchase(), onChainState: OnChainState.FundsOrDatumInvalid });
	const { responseMock } = await retry();
	expect(responseMock.statusCode).toBe(409);
	expect(responseMock._getData()).toContain('Repair Request');
	expect(transaction).not.toHaveBeenCalled();
});

it('rechecks transaction confirmation before any recovery mutation', async () => {
	findCurrentPurchase.mockResolvedValue({
		...initialPurchase(),
		CurrentTransaction: { status: TransactionStatus.Confirmed, txHash: 'confirmed' },
	});
	const { responseMock } = await retry();
	expect(responseMock.statusCode).toBe(409);
	expect(findCurrentPurchase).toHaveBeenCalledWith(
		expect.objectContaining({
			where: {
				id: 'purchase',
				updatedAt,
				nextActionId: 'manual',
			},
		}),
	);
	expect(updateTransaction).not.toHaveBeenCalled();
	expect(updatePurchase).not.toHaveBeenCalled();
});

it('rejects a request that changed before the write transaction', async () => {
	findCurrentPurchase.mockResolvedValue(null);
	const { responseMock } = await retry();
	expect(responseMock.statusCode).toBe(409);
	expect(updateTransaction).not.toHaveBeenCalled();
	expect(updatePurchase).not.toHaveBeenCalled();
});
