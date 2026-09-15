import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { testEndpoint } from 'express-zod-api';
import { ApiKeyStatus, Network, OnChainState, PaymentSourceType, TransactionLayer } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

class MockRepairValidationError extends Error {
	readonly detail: string;
	constructor(detail: string) {
		super(detail);
		this.detail = detail;
	}
}

class MockRepairChainLookupError extends Error {}
class MockRepairConflictError extends Error {}

const mockFindApiKey = jest.fn() as AnyMock;
const mockFindPaymentRequest = jest.fn() as AnyMock;
const mockFindPurchaseRequest = jest.fn() as AnyMock;
const mockValidateRepairTransaction = jest.fn() as AnyMock;
const mockRepairRequestTransaction = jest.fn() as AnyMock;
const mockValidateHydraRepair = jest.fn() as AnyMock;
const mockRepairHydraRequest = jest.fn() as AnyMock;

jest.unstable_mockModule('@/services/transactions/manual-repair/hydra-validation', () => ({
	validateHydraRepair: mockValidateHydraRepair,
}));
jest.unstable_mockModule('@/services/transactions/manual-repair/hydra-repair', () => ({
	repairHydraRequest: mockRepairHydraRequest,
}));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		apiKey: { findUnique: mockFindApiKey },
		paymentRequest: { findFirst: mockFindPaymentRequest },
		purchaseRequest: { findFirst: mockFindPurchaseRequest },
	},
}));

jest.unstable_mockModule('@/services/transactions/manual-repair', () => ({
	RepairValidationError: MockRepairValidationError,
	RepairChainLookupError: MockRepairChainLookupError,
	RepairConflictError: MockRepairConflictError,
	validateRepairTransaction: mockValidateRepairTransaction,
	repairRequestTransaction: mockRepairRequestTransaction,
}));

const { previewRepairRequestPost, repairRequestPost } = await import('./index');

const txHash = 'a'.repeat(64);

function asApiKey() {
	return {
		id: 'api-key-1',
		canRead: true,
		canPay: true,
		canAdmin: true,
		status: ApiKeyStatus.Active,
		token: null,
		tokenHash: null,
		tokenHashSecure: 'pbkdf2-placeholder',
		usageLimited: false,
		networkLimit: [Network.Preprod],
		walletScopeEnabled: false,
		WalletScopes: [],
	};
}

function paymentRequest(updatedAt = new Date('2026-07-22T12:00:00.000Z')) {
	return {
		id: 'request-id',
		updatedAt,
		blockchainIdentifier: 'request-chain-id',
		inputHash: 'input-hash',
		payByTime: 100n,
		submitResultTime: 200n,
		unlockTime: 300n,
		externalDisputeUnlockTime: 400n,
		collateralReturnLovelace: 2_000_000n,
		buyerReturnAddress: null,
		sellerReturnAddress: 'seller-return',
		onChainState: OnChainState.FundsLocked,
		resultHash: null,
		currentTransactionId: 'current-transaction',
		CurrentTransaction: { txHash: 'known-parent' },
		TransactionHistory: [],
		BuyerWallet: { walletVkey: 'buyer-vkey', walletAddress: 'buyer-address' },
		SmartContractWallet: { walletVkey: 'seller-vkey', walletAddress: 'seller-address' },
		RequestedFunds: [{ unit: 'lovelace', amount: 3_000_000n }],
		PaymentSource: {
			network: Network.Preprod,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
			smartContractAddress: 'contract-address',
			PaymentSourceConfig: { rpcProviderApiKey: 'provider-key' },
		},
	};
}

async function preview() {
	return testEndpoint({
		endpoint: previewRepairRequestPost,
		requestProps: {
			method: 'POST',
			headers: { token: 'valid' },
			body: {
				kind: 'Payment',
				network: Network.Preprod,
				blockchainIdentifier: 'request-chain-id',
				txHash,
			},
		},
	});
}

beforeEach(() => {
	jest.clearAllMocks();
	mockFindApiKey.mockResolvedValue(asApiKey());
	mockFindPaymentRequest.mockResolvedValue(paymentRequest());
	mockFindPurchaseRequest.mockResolvedValue(null);
	mockValidateRepairTransaction.mockResolvedValue({
		txHash,
		outputIndex: 1,
		derivedOnChainState: OnChainState.ResultSubmitted,
		resultHash: 'result-hash',
		confirmations: 5,
		blockHeight: 123,
		blockTime: 456,
		blockchainIdentifierMatches: true,
	});
	mockRepairRequestTransaction.mockResolvedValue({
		requestId: 'request-id',
		txHash,
		transactionId: 'target-transaction',
		previousOnChainState: OnChainState.FundsLocked,
		newOnChainState: OnChainState.ResultSubmitted,
		forced: false,
	});
});

describe('request repair version contract', () => {
	it('returns an opaque preview version and requires it for non-force apply', async () => {
		const { responseMock: previewResponse } = await preview();
		expect(previewResponse.statusCode).toBe(200);
		const previewBody = previewResponse._getJSONData() as {
			data: { requestVersion: string };
		};
		expect(previewBody.data.requestVersion).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(mockValidateRepairTransaction).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedRequest: expect.objectContaining({ knownTransactionHashes: ['known-parent'] }),
			}),
		);

		const { responseMock: missingVersionResponse } = await testEndpoint({
			endpoint: repairRequestPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					kind: 'Payment',
					network: Network.Preprod,
					blockchainIdentifier: 'request-chain-id',
					txHash,
				},
			},
		});
		expect(missingVersionResponse.statusCode).toBe(400);

		const { responseMock: applyResponse } = await testEndpoint({
			endpoint: repairRequestPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					kind: 'Payment',
					network: Network.Preprod,
					blockchainIdentifier: 'request-chain-id',
					txHash,
					requestVersion: previewBody.data.requestVersion,
				},
			},
		});

		expect(applyResponse.statusCode).toBe(200);
		expect(mockRepairRequestTransaction).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedVersion: {
					updatedAt: new Date('2026-07-22T12:00:00.000Z'),
					currentTransactionId: 'current-transaction',
					onChainState: OnChainState.FundsLocked,
					resultHash: null,
				},
			}),
		);
	});

	it('returns 409 when the request changed after preview', async () => {
		const { responseMock: previewResponse } = await preview();
		const requestVersion = (previewResponse._getJSONData() as { data: { requestVersion: string } }).data.requestVersion;
		mockFindPaymentRequest.mockResolvedValueOnce(paymentRequest(new Date('2026-07-22T12:01:00.000Z')));

		const { responseMock } = await testEndpoint({
			endpoint: repairRequestPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					kind: 'Payment',
					network: Network.Preprod,
					blockchainIdentifier: 'request-chain-id',
					txHash,
					requestVersion,
				},
			},
		});

		expect(responseMock.statusCode).toBe(409);
		expect(mockRepairRequestTransaction).not.toHaveBeenCalled();
	});

	it('maps inconclusive chain-provider failures to 502, not 400', async () => {
		mockValidateRepairTransaction.mockRejectedValueOnce(new MockRepairChainLookupError('provider unavailable'));

		const { responseMock } = await preview();

		expect(responseMock.statusCode).toBe(502);
		expect(responseMock._getJSONData()).toEqual({
			status: 'error',
			error: { message: 'Chain provider could not complete repair validation; retry later' },
		});
	});

	it('requires a dialog snapshot for force and rejects a stale one', async () => {
		const baseBody = {
			kind: 'Payment',
			network: Network.Preprod,
			blockchainIdentifier: 'request-chain-id',
			txHash,
			force: true,
			onChainState: OnChainState.FundsLocked,
		};

		const { responseMock: missingSnapshotResponse } = await testEndpoint({
			endpoint: repairRequestPost,
			requestProps: { method: 'POST', headers: { token: 'valid' }, body: baseBody },
		});
		expect(missingSnapshotResponse.statusCode).toBe(400);

		const { responseMock: staleSnapshotResponse } = await testEndpoint({
			endpoint: repairRequestPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: { ...baseBody, expectedRequestUpdatedAt: '2026-07-22T11:59:00.000Z' },
			},
		});
		expect(staleSnapshotResponse.statusCode).toBe(409);

		const { responseMock: currentSnapshotResponse } = await testEndpoint({
			endpoint: repairRequestPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: { ...baseBody, expectedRequestUpdatedAt: '2026-07-22T12:00:00.000Z' },
			},
		});
		expect(currentSnapshotResponse.statusCode).toBe(200);
		expect(mockValidateRepairTransaction).not.toHaveBeenCalled();
		expect(mockRepairRequestTransaction).toHaveBeenCalledWith(
			expect.objectContaining({
				validation: null,
				forcedOnChainState: OnChainState.FundsLocked,
			}),
		);
	});
});

describe('Hydra repair routing', () => {
	it.each(['Payment', 'Purchase'] as const)(
		'previews and repairs %s through Hydra without L1 lookup or writes',
		async (kind) => {
			const request = {
				...paymentRequest(),
				layer: TransactionLayer.L2,
				onChainState: OnChainState.FundsOrDatumInvalid,
				SellerWallet: { walletVkey: 'seller-vkey', walletAddress: 'seller-address' },
				PaidFunds: [{ unit: 'lovelace', amount: 3_000_000n }],
			};
			(kind === 'Payment' ? mockFindPaymentRequest : mockFindPurchaseRequest).mockResolvedValue(request);
			mockValidateHydraRepair.mockResolvedValue({
				txHash,
				outputIndex: 0,
				derivedOnChainState: OnChainState.FundsLocked,
				resultHash: null,
			});
			mockRepairHydraRequest.mockResolvedValue({
				requestId: request.id,
				txHash,
				transactionId: 'hydra-transaction',
				previousOnChainState: request.onChainState,
				newOnChainState: OnChainState.FundsLocked,
				forced: false,
			});
			const body = { kind, network: Network.Preprod, blockchainIdentifier: request.blockchainIdentifier, txHash };
			const { responseMock: previewResponse } = await testEndpoint({
				endpoint: previewRepairRequestPost,
				requestProps: { method: 'POST', headers: { token: 'valid' }, body },
			});
			expect(previewResponse.statusCode).toBe(200);
			expect(mockValidateHydraRepair).toHaveBeenCalledWith({ kind: kind.toLowerCase(), requestId: request.id, txHash });
			const requestVersion = previewResponse._getJSONData().data.requestVersion;
			const { responseMock } = await testEndpoint({
				endpoint: repairRequestPost,
				requestProps: { method: 'POST', headers: { token: 'valid' }, body: { ...body, requestVersion } },
			});
			expect(responseMock.statusCode).toBe(200);
			expect(mockRepairHydraRequest).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: kind.toLowerCase(),
					requestId: request.id,
					txHash,
					expectedVersion: expect.objectContaining({ onChainState: OnChainState.FundsOrDatumInvalid }),
				}),
			);
			expect(mockValidateRepairTransaction).not.toHaveBeenCalled();
			expect(mockRepairRequestTransaction).not.toHaveBeenCalled();
		},
	);

	it('uses the current transaction layer for a legacy request without an L2 marker', async () => {
		mockFindPaymentRequest.mockResolvedValue({
			...paymentRequest(),
			layer: TransactionLayer.L1,
			CurrentTransaction: { txHash: 'known-parent', layer: TransactionLayer.L2 },
		});
		mockValidateHydraRepair.mockResolvedValue({
			txHash,
			outputIndex: 0,
			derivedOnChainState: OnChainState.FundsLocked,
			resultHash: null,
		});
		const { responseMock } = await preview();
		expect(responseMock.statusCode).toBe(200);
		expect(mockValidateHydraRepair).toHaveBeenCalledTimes(1);
		expect(mockValidateRepairTransaction).not.toHaveBeenCalled();
	});

	it.each(['Payment', 'Purchase'] as const)('rejects forced Hydra %s repair without writes', async (kind) => {
		const request = {
			...paymentRequest(),
			layer: TransactionLayer.L2,
			SellerWallet: { walletVkey: 'seller-vkey', walletAddress: 'seller-address' },
			PaidFunds: [{ unit: 'lovelace', amount: 3_000_000n }],
		};
		(kind === 'Payment' ? mockFindPaymentRequest : mockFindPurchaseRequest).mockResolvedValue(request);
		const { responseMock } = await testEndpoint({
			endpoint: repairRequestPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					kind,
					network: Network.Preprod,
					blockchainIdentifier: request.blockchainIdentifier,
					txHash,
					force: true,
					onChainState: OnChainState.FundsLocked,
					expectedRequestUpdatedAt: request.updatedAt.toISOString(),
				},
			},
		});
		expect(responseMock.statusCode).toBe(400);
		expect(responseMock._getData()).toContain('force is not supported');
		expect(mockRepairHydraRequest).not.toHaveBeenCalled();
		expect(mockRepairRequestTransaction).not.toHaveBeenCalled();
	});
});
