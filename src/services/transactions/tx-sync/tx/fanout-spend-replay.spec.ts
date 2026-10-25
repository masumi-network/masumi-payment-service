import { describe, expect, it, jest } from '@jest/globals';
import { HydraHeadStatus, OnChainState, PaymentSourceType, TransactionLayer } from '@/generated/prisma/client';

const mockFindPayment = jest.fn(async () => ({
	id: 'payment-1',
	paymentSourceId: 'source-1',
	layer: TransactionLayer.L2,
	CurrentTransaction: { txHash: 'a'.repeat(64), layer: TransactionLayer.L2, hydraHeadId: 'head-1' },
	TransactionHistory: [],
}));
const mockFindPurchase = jest.fn(async () => null);
const mockFindHead = jest.fn(async (_query: unknown) => ({
	status: HydraHeadStatus.FanningOut,
	headIdentifier: 'b'.repeat(56),
	HydraRelation: {
		LocalHotWallet: { walletVkey: 'c'.repeat(56) },
		RemoteWallet: { walletVkey: 'd'.repeat(56) },
	},
}));
const mockCheckHistory = jest.fn(async () => false);
const mockIsBoundOrigin = jest.fn(async () => true);
const mockHandleV2Payment = jest.fn(async () => undefined);

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		paymentRequest: { findUnique: mockFindPayment },
		purchaseRequest: { findUnique: mockFindPurchase },
		hydraHead: { findUnique: mockFindHead },
	},
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('@/services/transactions/tx-sync/util', () => ({
	checkIfTxIsInHistory: mockCheckHistory,
	calculateValueChange: jest.fn(),
	checkPaymentAmountsMatch: jest.fn(),
	getCardanoFeesBuyer: jest.fn(),
	getCardanoFeesSeller: jest.fn(),
	redeemerToOnChainState: jest.fn(() => OnChainState.FundsLocked),
}));
jest.unstable_mockModule('@/lib/hydra/hydra/fanout-output-origin', () => ({
	isBoundFanoutOutputOrigin: mockIsBoundOrigin,
}));
jest.unstable_mockModule('./datum-verification', () => ({
	verifyRequestFieldsAgainstDatum: () => true,
	v2ReturnAddressesMatch: jest.fn(),
}));
jest.unstable_mockModule('./initial-purchase', () => ({ updateInitialPurchaseTransaction: jest.fn() }));
jest.unstable_mockModule('./initial-payment', () => ({ updateInitialPaymentTransaction: jest.fn() }));
jest.unstable_mockModule('./rolled-back', () => ({ updateRolledBackTransaction: jest.fn() }));
jest.unstable_mockModule('@/services/payment-source-adapters', () => ({
	getDatumNetwork: jest.fn(),
	getPaymentSourceContractAdapter: jest.fn(),
}));
jest.unstable_mockModule('@masumi/payment-source-v1/services/tx-sync/handlers', () => ({
	handleV1PaymentTransaction: jest.fn(),
	handleV1PurchasingTransaction: jest.fn(),
}));
jest.unstable_mockModule('@masumi/payment-source-v2/services/tx-sync/handlers', () => ({
	handleV2PaymentTransaction: mockHandleV2Payment,
	handleV2PurchasingTransaction: jest.fn(),
}));

const { updateTransaction } = await import('./index');
const { PendingFanoutHandoffError } = await import('./pending-fanout-handoff');

describe('L1 spend during partial fanout', () => {
	const source = {
		id: 'source-1',
		paymentSourceType: PaymentSourceType.Web3CardanoV2,
		smartContractAddress: 'addr_test1_contract',
	};
	const entry = {
		decodedOldContract: { blockchainIdentifier: 'request-1' },
		valueInput: {
			tx_hash: 'c'.repeat(64),
			output_index: 1,
			amount: [{ unit: 'lovelace', quantity: '10000000' }],
		},
	};
	const run = () =>
		updateTransaction(
			source as never,
			entry as never,
			{} as never,
			{ tx: { tx_hash: 'b'.repeat(64) }, block: { confirmations: 10 }, metadata: { fees: 200000n } } as never,
		);

	it('throws before tx-sync can advance its checkpoint past a request still on L2', async () => {
		await expect(run()).rejects.toBeInstanceOf(PendingFanoutHandoffError);
		expect(mockCheckHistory).toHaveBeenCalled();
		expect(mockFindHead).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'head-1' } }));
		expect(mockIsBoundOrigin).toHaveBeenCalled();
	});

	it('uses the normal L1 handler when replay sees the adopted fanout predecessor', async () => {
		mockFindPayment.mockResolvedValueOnce({
			id: 'payment-1',
			paymentSourceId: 'source-1',
			layer: TransactionLayer.L1,
			CurrentTransaction: { txHash: entry.valueInput.tx_hash, layer: TransactionLayer.L1, hydraHeadId: 'head-1' },
			TransactionHistory: [],
		} as never);
		mockCheckHistory.mockResolvedValueOnce(true);
		await expect(run()).resolves.toBeUndefined();
		expect(mockHandleV2Payment).toHaveBeenCalledTimes(1);
	});
});
