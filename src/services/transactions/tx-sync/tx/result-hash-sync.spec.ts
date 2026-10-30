import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { OnChainState, PaymentSourceType } from '@/generated/prisma/client';

const mockHandleV2Payment = jest.fn(async (..._args: unknown[]) => undefined);
const mockHandleV2Purchasing = jest.fn(async (..._args: unknown[]) => undefined);
const mockRedeemerToOnChainState = jest.fn((..._args: unknown[]): OnChainState => OnChainState.RefundAuthorized);

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		paymentRequest: {
			findUnique: jest.fn(async () => ({ id: 'payment-1', paymentSourceId: 'source-1', TransactionHistory: [] })),
		},
		purchaseRequest: {
			findUnique: jest.fn(async () => ({ id: 'purchase-1', paymentSourceId: 'source-1', TransactionHistory: [] })),
		},
	},
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('@/services/transactions/tx-sync/util', () => ({
	checkIfTxIsInHistory: jest.fn(async () => true),
	calculateValueChange: jest.fn(() => []),
	checkPaymentAmountsMatch: jest.fn(() => true),
	getCardanoFeesBuyer: jest.fn(() => 0n),
	getCardanoFeesSeller: jest.fn(() => 0n),
	redeemerToOnChainState: mockRedeemerToOnChainState,
}));
jest.unstable_mockModule('./datum-verification', () => ({
	verifyRequestFieldsAgainstDatum: () => true,
	v2ReturnAddressesMatch: () => true,
}));
jest.unstable_mockModule('./pending-fanout-handoff', () => ({ deferSpendUntilFanoutHandoff: jest.fn() }));
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
	handleV2PurchasingTransaction: mockHandleV2Purchasing,
}));

const { updateTransaction } = await import('./index');

// Position of the result hash in the handler signature.
const RESULT_HASH_ARG = 4;
const OLD_RESULT_HASH = 'aa'.repeat(32);

describe('result hash written by tx-sync', () => {
	const source = {
		id: 'source-1',
		paymentSourceType: PaymentSourceType.Web3CardanoV2,
		smartContractAddress: 'addr_test1_contract',
	};
	const decodedOldContract = { blockchainIdentifier: 'request-1', resultHash: OLD_RESULT_HASH };
	const run = (entry: object) =>
		updateTransaction(
			source as never,
			{
				valueInput: { tx_hash: 'c'.repeat(64), output_index: 0, amount: [] },
				valueOutput: null,
				decodedOldContract,
				...entry,
			} as never,
			{} as never,
			{ tx: { tx_hash: 'b'.repeat(64) }, block: { confirmations: 10 }, metadata: { fees: 200000n } } as never,
		);

	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('clears the stored hash when AuthorizeRefund empties it on chain', async () => {
		await run({
			redeemerVersion: 6,
			decodedNewContract: {
				...decodedOldContract,
				resultHash: null,
				buyerCooldownTime: 0n,
				sellerCooldownTime: 0n,
			},
		});

		expect(mockHandleV2Payment).toHaveBeenCalledTimes(1);
		expect(mockHandleV2Purchasing).toHaveBeenCalledTimes(1);
		expect(mockHandleV2Payment.mock.calls[0][RESULT_HASH_ARG]).toBeNull();
		expect(mockHandleV2Purchasing.mock.calls[0][RESULT_HASH_ARG]).toBeNull();
	});

	it('keeps the stored hash when the spend has no continuation datum', async () => {
		mockRedeemerToOnChainState.mockReturnValueOnce(OnChainState.Withdrawn);

		await run({ redeemerVersion: 0, decodedNewContract: null });

		expect(mockHandleV2Payment.mock.calls[0][RESULT_HASH_ARG]).toBe(OLD_RESULT_HASH);
		expect(mockHandleV2Purchasing.mock.calls[0][RESULT_HASH_ARG]).toBe(OLD_RESULT_HASH);
	});
});
