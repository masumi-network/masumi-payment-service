import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { Network, OnChainState, PaymentSourceType, TransactionStatus } from '@/generated/prisma/client';
import type { DecodedV1ContractDatum } from '@/utils/converter/string-datum-convert';

type AnyMock = Mock<(...args: any[]) => any>;

const mockTxs = jest.fn() as AnyMock;
const mockBlocks = jest.fn() as AnyMock;
const mockTxsUtxos = jest.fn() as AnyMock;
const mockCreateApiClient = jest.fn(() => ({
	txs: mockTxs,
	blocks: mockBlocks,
	txsUtxos: mockTxsUtxos,
}));
const mockDeserializeDatum = jest.fn((value) => value);
const mockDecodeV1 = jest.fn() as AnyMock;
const mockDecodeV2 = jest.fn() as AnyMock;
const mockGetPaymentSourceContractAdapter = jest.fn((paymentSourceType: PaymentSourceType) => ({
	decodeContractDatum: paymentSourceType === PaymentSourceType.Web3CardanoV1 ? mockDecodeV1 : mockDecodeV2,
}));

const mockPurchaseFindUnique = jest.fn() as AnyMock;
const mockPurchaseUpdate = jest.fn() as AnyMock;
const mockPaymentFindUnique = jest.fn() as AnyMock;
const mockPaymentUpdate = jest.fn() as AnyMock;
const mockTransactionFindFirst = jest.fn() as AnyMock;
const mockTransactionUpdate = jest.fn() as AnyMock;
const mockTransactionCreate = jest.fn() as AnyMock;
const mockTransactionUpdateMany = jest.fn() as AnyMock;
const mockHotWalletUpdateMany = jest.fn() as AnyMock;
const mockPaymentCount = jest.fn() as AnyMock;
const mockPurchaseCount = jest.fn() as AnyMock;
const mockRegistryCount = jest.fn() as AnyMock;
const mockInboxCount = jest.fn() as AnyMock;
const mockFundDistributionCount = jest.fn() as AnyMock;
const mockWalletFundTransferCount = jest.fn() as AnyMock;
const transactionClient = {
	purchaseRequest: { findUnique: mockPurchaseFindUnique, update: mockPurchaseUpdate, count: mockPurchaseCount },
	paymentRequest: { findUnique: mockPaymentFindUnique, update: mockPaymentUpdate, count: mockPaymentCount },
	transaction: {
		findFirst: mockTransactionFindFirst,
		update: mockTransactionUpdate,
		create: mockTransactionCreate,
		updateMany: mockTransactionUpdateMany,
	},
	hotWallet: { updateMany: mockHotWalletUpdateMany },
	registryRequest: { count: mockRegistryCount },
	inboxAgentRegistrationRequest: { count: mockInboxCount },
	fundDistributionRequest: { count: mockFundDistributionCount },
	walletFundTransfer: { count: mockWalletFundTransferCount },
};
const mockPrismaTransaction = jest.fn(async (callback: (tx: typeof transactionClient) => unknown) =>
	callback(transactionClient),
);
const mockLoggerWarn = jest.fn();

jest.unstable_mockModule('@/services/shared', () => ({
	createApiClient: mockCreateApiClient,
}));

jest.unstable_mockModule('@/services/shared/chain-tx-lookup', () => ({
	getChainErrorStatus: (error: unknown) =>
		typeof error === 'object' && error != null && 'status_code' in error
			? (error as { status_code: number }).status_code
			: undefined,
}));

jest.unstable_mockModule('@/services/payment-source-adapters', () => ({
	getDatumNetwork: (network: Network) => (network === Network.Mainnet ? 'mainnet' : 'preprod'),
	getPaymentSourceContractAdapter: mockGetPaymentSourceContractAdapter,
}));

jest.unstable_mockModule('@/services/transactions/tx-sync/util', () => ({
	checkPaymentAmountsMatch: (
		expected: Array<{ unit: string; amount: bigint }>,
		actual: Array<{ unit: string; quantity: string }>,
		collateral: bigint,
	) => {
		const lockedLovelace = actual
			.filter((amount) => amount.unit === '' || amount.unit === 'lovelace')
			.reduce((sum, amount) => sum + BigInt(amount.quantity), 0n);
		if (collateral < 0n || collateral > lockedLovelace) return false;
		return expected.every((expectedAmount) => {
			const actualAmount = actual.find(
				(amount) =>
					(amount.unit === 'lovelace' ? '' : amount.unit) ===
					(expectedAmount.unit === 'lovelace' ? '' : expectedAmount.unit),
			);
			if (actualAmount == null) return false;
			return expectedAmount.unit === 'lovelace'
				? expectedAmount.amount <= BigInt(actualAmount.quantity) - collateral
				: expectedAmount.amount === BigInt(actualAmount.quantity);
		});
	},
}));

jest.unstable_mockModule('@meshsdk/core', () => ({
	deserializeDatum: mockDeserializeDatum,
}));

jest.unstable_mockModule('@masumi/payment-core/config', () => ({
	CONFIG: { BLOCK_CONFIRMATIONS_THRESHOLD: 3 },
	CONSTANTS: { MIN_COLLATERAL_LOVELACE: 2_000_000n },
}));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { $transaction: mockPrismaTransaction },
}));

jest.unstable_mockModule('@masumi/payment-core/db-retry', () => ({
	retryOnSerializationConflict: async (callback: () => Promise<unknown>) => callback(),
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { warn: mockLoggerWarn, info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('@masumi/payment-core/smart-contract-state', () => ({
	SmartContractState: {
		FundsLocked: 0,
		ResultSubmitted: 1,
		RefundRequested: 2,
		Disputed: 3,
		WithdrawAuthorized: 4,
		RefundAuthorized: 5,
	},
	onChainStateFromSmartContractState: () => OnChainState.ResultSubmitted,
	smartContractStateEqualsOnChainState: jest.fn(),
}));

let validateRepairTransaction!: typeof import('./index').validateRepairTransaction;
let repairRequestTransaction!: typeof import('./index').repairRequestTransaction;
let getRepairDatumMismatch!: typeof import('./index').getRepairDatumMismatch;
let RepairChainLookupError!: typeof import('./index').RepairChainLookupError;
let RepairConflictError!: typeof import('./index').RepairConflictError;
let RepairValidationError!: typeof import('./index').RepairValidationError;

beforeAll(async () => {
	({
		validateRepairTransaction,
		repairRequestTransaction,
		getRepairDatumMismatch,
		RepairChainLookupError,
		RepairConflictError,
		RepairValidationError,
	} = await import('./index'));
});

const updatedAt = new Date('2026-07-22T12:00:00.000Z');

function decodedDatum(overrides: Partial<DecodedV1ContractDatum> = {}): DecodedV1ContractDatum {
	return {
		blockchainIdentifier: 'request-chain-id',
		buyerAddress: 'buyer-address',
		buyerReturnAddress: 'buyer-return',
		sellerAddress: 'seller-address',
		sellerReturnAddress: 'seller-return',
		buyerVkey: 'buyer-vkey',
		sellerVkey: 'seller-vkey',
		state: 1,
		referenceKey: 'reference-key',
		referenceSignature: 'reference-signature',
		sellerNonce: 'seller-nonce',
		buyerNonce: 'buyer-nonce',
		collateralReturnLovelace: 2_000_000n,
		inputHash: 'input-hash',
		resultHash: 'result-hash',
		payByTime: 100n,
		resultTime: 200n,
		unlockTime: 300n,
		externalDisputeUnlockTime: 400n,
		buyerCooldownTime: 0n,
		sellerCooldownTime: 0n,
		...overrides,
	};
}

function expectedRequest(kind: 'purchase' | 'payment' = 'purchase') {
	return {
		kind,
		inputHash: 'input-hash',
		payByTime: 100n,
		submitResultTime: 200n,
		unlockTime: 300n,
		externalDisputeUnlockTime: 400n,
		collateralReturnLovelace: 2_000_000n,
		buyerReturnAddress: 'buyer-return',
		sellerReturnAddress: 'seller-return',
		buyerWallet: kind === 'payment' ? { walletVkey: 'buyer-vkey', walletAddress: 'buyer-address' } : null,
		sellerWallet: kind === 'purchase' ? { walletVkey: 'seller-vkey', walletAddress: 'seller-address' } : null,
		smartContractWallet:
			kind === 'purchase'
				? { walletVkey: 'buyer-vkey', walletAddress: 'buyer-address' }
				: { walletVkey: 'seller-vkey', walletAddress: 'seller-address' },
		amounts: [{ unit: 'lovelace', amount: 3_000_000n }],
		knownTransactionHashes: ['known-parent'],
	};
}

function validationParams(paymentSourceType: PaymentSourceType) {
	return {
		txHash: 'a'.repeat(64),
		blockchainIdentifier: 'request-chain-id',
		smartContractAddress: 'contract-address',
		network: Network.Preprod,
		rpcProviderApiKey: 'api-key',
		paymentSourceType,
		expectedRequest: expectedRequest(),
	};
}

function initialLockUtxos(
	inputAddress = 'buyer-address',
	outputOverrides: { amount?: Array<{ unit: string; quantity: string }>; reference_script_hash?: string | null } = {},
) {
	return {
		inputs: [
			{
				address: inputAddress,
				tx_hash: 'funding-source',
				output_index: 0,
				inline_datum: null,
				collateral: false,
				reference: false,
			},
		],
		outputs: [
			{
				address: 'contract-address',
				amount: [{ unit: 'lovelace', quantity: '5000000' }],
				inline_datum: 'datum-cbor',
				output_index: 1,
				consumed_by_tx: null,
				reference_script_hash: null,
				...outputOverrides,
			},
		],
	};
}

beforeEach(() => {
	jest.clearAllMocks();
	mockTxs.mockResolvedValue({ block: 'block-hash', block_height: 123, block_time: 456, valid_contract: true });
	mockBlocks.mockResolvedValue({ confirmations: 5 });
	mockTxsUtxos.mockResolvedValue({
		inputs: [
			{
				address: 'contract-address',
				tx_hash: 'known-parent',
				output_index: 0,
				inline_datum: 'prior-datum-cbor',
				collateral: false,
				reference: false,
			},
		],
		outputs: [
			{
				address: 'contract-address',
				amount: [{ unit: 'lovelace', quantity: '5000000' }],
				inline_datum: 'datum-cbor',
				output_index: 1,
				consumed_by_tx: null,
				reference_script_hash: null,
			},
		],
	});
	mockDecodeV1.mockReturnValue(decodedDatum());
	mockDecodeV2.mockReturnValue(decodedDatum());
	mockTransactionUpdate.mockResolvedValue({});
	mockTransactionCreate.mockResolvedValue({ id: 'created-transaction' });
	mockTransactionUpdateMany.mockResolvedValue({ count: 1 });
	mockHotWalletUpdateMany.mockResolvedValue({ count: 1 });
	mockPurchaseUpdate.mockResolvedValue({});
	mockPaymentUpdate.mockResolvedValue({});
	mockPaymentCount.mockResolvedValue(0);
	mockPurchaseCount.mockResolvedValue(0);
	mockRegistryCount.mockResolvedValue(0);
	mockInboxCount.mockResolvedValue(0);
	mockFundDistributionCount.mockResolvedValue(0);
	mockWalletFundTransferCount.mockResolvedValue(0);
});

describe('validateRepairTransaction', () => {
	it.each([
		[PaymentSourceType.Web3CardanoV1, mockDecodeV1, mockDecodeV2],
		[PaymentSourceType.Web3CardanoV2, mockDecodeV2, mockDecodeV1],
	])('decodes through the %s payment-source adapter', async (paymentSourceType, expectedDecoder, otherDecoder) => {
		const result = await validateRepairTransaction(validationParams(paymentSourceType));

		expect(expectedDecoder).toHaveBeenCalledWith('datum-cbor', 'preprod', 'contract-address');
		expect(otherDecoder).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			outputIndex: 1,
			derivedOnChainState: OnChainState.ResultSubmitted,
			confirmations: 5,
			blockHeight: 123,
			blockTime: 456,
		});
	});

	it.each([
		['inputHash', { inputHash: 'spoofed-input' }],
		['payByTime', { payByTime: 101n }],
		['submitResultTime', { resultTime: 201n }],
		['unlockTime', { unlockTime: 299n }],
		['externalDisputeUnlockTime', { externalDisputeUnlockTime: 401n }],
		['collateralReturnLovelace', { collateralReturnLovelace: 3_000_000n }],
		['sellerWallet', { sellerVkey: 'spoofed-seller' }],
		['buyerWallet', { buyerAddress: 'spoofed-buyer-address' }],
		['buyerReturnAddress', { buyerReturnAddress: 'spoofed-buyer-return' }],
		['sellerReturnAddress', { sellerReturnAddress: 'spoofed-seller-return' }],
	] as Array<[string, Partial<DecodedV1ContractDatum>]>)('rejects immutable %s mismatches', (field, overrides) => {
		expect(getRepairDatumMismatch(expectedRequest(), decodedDatum(overrides), PaymentSourceType.Web3CardanoV2)).toBe(
			field,
		);
	});

	it.each([
		['payByTime', { payByTime: null }],
		['collateralReturnLovelace', { collateralReturnLovelace: null }],
		['sellerWallet', { sellerWallet: null }],
		['buyerWallet', { smartContractWallet: null }],
	] as const)('fails closed when required %s context is absent', (field, missing) => {
		expect(
			getRepairDatumMismatch({ ...expectedRequest(), ...missing }, decodedDatum(), PaymentSourceType.Web3CardanoV2),
		).toBe(field);
	});

	it('allows a later purchase unlockTime but keeps payment unlockTime exact', () => {
		const laterUnlock = decodedDatum({ unlockTime: 301n });
		expect(
			getRepairDatumMismatch(expectedRequest('purchase'), laterUnlock, PaymentSourceType.Web3CardanoV2),
		).toBeNull();
		expect(getRepairDatumMismatch(expectedRequest('payment'), laterUnlock, PaymentSourceType.Web3CardanoV2)).toBe(
			'unlockTime',
		);
	});

	it('rejects a spent matching output', async () => {
		mockTxsUtxos.mockResolvedValueOnce({
			inputs: [],
			outputs: [
				{
					address: 'contract-address',
					inline_datum: 'datum-cbor',
					output_index: 1,
					consumed_by_tx: 'spending-tx',
				},
			],
		});

		await expect(validateRepairTransaction(validationParams(PaymentSourceType.Web3CardanoV2))).rejects.toThrow(
			'already spent',
		);
	});

	it('rejects multiple matching unspent outputs as ambiguous', async () => {
		mockTxsUtxos.mockResolvedValueOnce({
			inputs: [
				{
					address: 'contract-address',
					tx_hash: 'known-parent',
					output_index: 0,
					inline_datum: 'prior-datum-cbor',
					collateral: false,
					reference: false,
				},
			],
			outputs: [0, 1].map((output_index) => ({
				address: 'contract-address',
				amount: [{ unit: 'lovelace', quantity: '5000000' }],
				inline_datum: `datum-${output_index}`,
				output_index,
				consumed_by_tx: null,
				reference_script_hash: null,
			})),
		});

		await expect(validateRepairTransaction(validationParams(PaymentSourceType.Web3CardanoV2))).rejects.toThrow(
			'ambiguous',
		);
	});

	it('rejects a transaction that failed on-chain script validation', async () => {
		mockTxs.mockResolvedValueOnce({
			block: 'block-hash',
			block_height: 123,
			block_time: 456,
			valid_contract: false,
		});

		await expect(validateRepairTransaction(validationParams(PaymentSourceType.Web3CardanoV1))).rejects.toThrow(
			'failed on-chain script validation',
		);
		expect(mockTxsUtxos).not.toHaveBeenCalled();
	});

	it('accepts an initial FundsLocked output only when the decoded buyer funds it', async () => {
		mockTxs.mockResolvedValueOnce({
			block: 'block-hash',
			block_height: 123,
			block_time: 0,
			valid_contract: true,
		});
		mockDecodeV2.mockReturnValue(decodedDatum({ state: 0, resultHash: null }));
		mockTxsUtxos.mockResolvedValueOnce(initialLockUtxos());

		await expect(validateRepairTransaction(validationParams(PaymentSourceType.Web3CardanoV2))).resolves.toBeDefined();
	});

	it('rejects a copied initial datum funded by a different address', async () => {
		mockTxs.mockResolvedValueOnce({
			block: 'block-hash',
			block_height: 123,
			block_time: 0,
			valid_contract: true,
		});
		mockDecodeV2.mockReturnValue(decodedDatum({ state: 0, resultHash: null }));
		mockTxsUtxos.mockResolvedValueOnce(initialLockUtxos('attacker-address'));

		await expect(validateRepairTransaction(validationParams(PaymentSourceType.Web3CardanoV2))).rejects.toThrow(
			'buyerFundingInput',
		);
	});

	it('requires a continuation to consume a known current or historical transaction', async () => {
		mockTxsUtxos.mockResolvedValueOnce({
			inputs: [
				{
					address: 'contract-address',
					tx_hash: 'unknown-parent',
					output_index: 0,
					inline_datum: 'prior-datum-cbor',
					collateral: false,
					reference: false,
				},
			],
			outputs: [
				{
					address: 'contract-address',
					amount: [{ unit: 'lovelace', quantity: '5000000' }],
					inline_datum: 'datum-cbor',
					output_index: 1,
					consumed_by_tx: null,
					reference_script_hash: null,
				},
			],
		});

		await expect(validateRepairTransaction(validationParams(PaymentSourceType.Web3CardanoV2))).rejects.toThrow(
			'transactionLineage',
		);
	});

	it('requires a continuation input datum to identify the same request', async () => {
		mockDecodeV2.mockImplementation((datum: string) =>
			datum === 'prior-datum-cbor' ? decodedDatum({ blockchainIdentifier: 'different-request' }) : decodedDatum(),
		);

		await expect(validateRepairTransaction(validationParams(PaymentSourceType.Web3CardanoV2))).rejects.toThrow(
			'transactionProvenance',
		);
	});

	it('rejects unexpected native assets on a continuation output', async () => {
		mockTxsUtxos.mockResolvedValueOnce({
			inputs: [
				{
					address: 'contract-address',
					tx_hash: 'known-parent',
					output_index: 0,
					inline_datum: 'prior-datum-cbor',
					collateral: false,
					reference: false,
				},
			],
			outputs: [
				{
					address: 'contract-address',
					amount: [
						{ unit: 'lovelace', quantity: '5000000' },
						{ unit: 'unexpected-token', quantity: '1' },
					],
					inline_datum: 'datum-cbor',
					output_index: 1,
					consumed_by_tx: null,
					reference_script_hash: null,
				},
			],
		});

		await expect(validateRepairTransaction(validationParams(PaymentSourceType.Web3CardanoV2))).rejects.toThrow(
			'amounts',
		);
	});

	it('rejects reference scripts and incorrect amounts on an initial lock', async () => {
		mockTxs.mockResolvedValue({
			block: 'block-hash',
			block_height: 123,
			block_time: 0,
			valid_contract: true,
		});
		mockDecodeV1.mockReturnValue(decodedDatum({ state: 0, resultHash: null }));
		mockTxsUtxos.mockResolvedValueOnce(initialLockUtxos('buyer-address', { reference_script_hash: 'script' }));
		await expect(validateRepairTransaction(validationParams(PaymentSourceType.Web3CardanoV1))).rejects.toThrow(
			'referenceScriptHash',
		);

		mockTxsUtxos.mockResolvedValueOnce(
			initialLockUtxos('buyer-address', { amount: [{ unit: 'lovelace', quantity: '2500000' }] }),
		);
		await expect(validateRepairTransaction(validationParams(PaymentSourceType.Web3CardanoV1))).rejects.toThrow(
			'amounts',
		);
	});

	it('allows a free collateral-only initial lock while still bounding collateral by locked lovelace', async () => {
		mockTxs.mockResolvedValueOnce({
			block: 'block-hash',
			block_height: 123,
			block_time: 0,
			valid_contract: true,
		});
		mockDecodeV2.mockReturnValue(decodedDatum({ state: 0, resultHash: null }));
		mockTxsUtxos.mockResolvedValueOnce(initialLockUtxos());
		const params = validationParams(PaymentSourceType.Web3CardanoV2);
		params.expectedRequest = { ...params.expectedRequest, amounts: [] };

		await expect(validateRepairTransaction(params)).resolves.toBeDefined();
	});

	it('enforces the configured confirmation threshold', async () => {
		mockBlocks.mockResolvedValueOnce({ confirmations: 2 });

		await expect(validateRepairTransaction(validationParams(PaymentSourceType.Web3CardanoV1))).rejects.toThrow(
			'3 required',
		);
		await expect(validateRepairTransaction(validationParams(PaymentSourceType.Web3CardanoV1))).resolves.toBeDefined();
	});

	it('keeps transient provider failures distinct from caller validation errors', async () => {
		mockTxs.mockRejectedValueOnce(Object.assign(new Error('provider unavailable'), { status_code: 503 }));

		const promise = validateRepairTransaction(validationParams(PaymentSourceType.Web3CardanoV1));
		await expect(promise).rejects.toBeInstanceOf(RepairChainLookupError);
		await expect(promise).rejects.not.toBeInstanceOf(RepairValidationError);
	});
});

describe('repairRequestTransaction', () => {
	it('settles a reused row, archives the old current row, clears null resultHash, and releases both wallets', async () => {
		mockPurchaseFindUnique.mockResolvedValueOnce({
			id: 'request-id',
			updatedAt,
			onChainState: OnChainState.FundsLocked,
			resultHash: 'stale-result',
			currentTransactionId: 'old-transaction',
			CurrentTransaction: {
				status: TransactionStatus.Pending,
				BlocksWallet: { id: 'old-wallet' },
			},
			TransactionHistory: [{ id: 'target-transaction' }],
		});
		mockTransactionFindFirst.mockResolvedValueOnce({
			id: 'target-transaction',
			BlocksWallet: { id: 'target-wallet' },
		});

		const result = await repairRequestTransaction({
			kind: 'purchase',
			requestId: 'request-id',
			txHash: 'b'.repeat(64),
			validation: {
				txHash: 'b'.repeat(64),
				outputIndex: 0,
				derivedOnChainState: OnChainState.ResultSubmitted,
				resultHash: null,
				confirmations: 7,
				blockHeight: 999,
				blockTime: 888,
				blockchainIdentifierMatches: true,
			},
			forcedOnChainState: null,
			expectedVersion: {
				updatedAt,
				currentTransactionId: 'old-transaction',
				onChainState: OnChainState.FundsLocked,
				resultHash: 'stale-result',
			},
		});

		expect(mockTransactionUpdate).toHaveBeenCalledWith({
			where: { id: 'target-transaction' },
			data: expect.objectContaining({
				status: TransactionStatus.Confirmed,
				previousOnChainState: OnChainState.FundsLocked,
				newOnChainState: OnChainState.ResultSubmitted,
				confirmations: 7,
			}),
		});
		expect(mockTransactionUpdateMany).toHaveBeenCalledWith({
			where: { id: 'old-transaction', status: TransactionStatus.Pending },
			data: { status: TransactionStatus.FailedViaManualReset },
		});
		expect(mockHotWalletUpdateMany).toHaveBeenCalledTimes(2);
		expect(mockHotWalletUpdateMany).toHaveBeenCalledWith({
			where: { id: 'target-wallet', pendingTransactionId: 'target-transaction' },
			data: { pendingTransactionId: null, lockedAt: null },
		});
		expect(mockHotWalletUpdateMany).toHaveBeenCalledWith({
			where: { id: 'old-wallet', pendingTransactionId: 'old-transaction' },
			data: { pendingTransactionId: null, lockedAt: null },
		});
		expect(mockPurchaseUpdate).toHaveBeenCalledWith({
			where: { id: 'request-id' },
			data: expect.objectContaining({
				currentTransactionId: 'target-transaction',
				onChainState: OnChainState.ResultSubmitted,
				resultHash: null,
				TransactionHistory: {
					connect: [{ id: 'target-transaction' }, { id: 'old-transaction' }],
				},
			}),
		});
		expect(result.transactionId).toBe('target-transaction');
	});

	it('does not fail or unlock a previous Transaction still current for a sibling request', async () => {
		mockPurchaseFindUnique.mockResolvedValueOnce({
			id: 'request-id',
			updatedAt,
			onChainState: OnChainState.FundsLocked,
			resultHash: null,
			currentTransactionId: 'shared-old-transaction',
			CurrentTransaction: {
				status: TransactionStatus.Pending,
				BlocksWallet: { id: 'shared-wallet' },
			},
			TransactionHistory: [{ id: 'target-transaction' }],
		});
		mockTransactionFindFirst.mockResolvedValueOnce({ id: 'target-transaction', BlocksWallet: null });
		mockPaymentCount.mockResolvedValueOnce(1);

		await repairRequestTransaction({
			kind: 'purchase',
			requestId: 'request-id',
			txHash: 'd'.repeat(64),
			validation: {
				txHash: 'd'.repeat(64),
				outputIndex: 0,
				derivedOnChainState: OnChainState.ResultSubmitted,
				resultHash: 'new-result',
				confirmations: 7,
				blockHeight: 999,
				blockTime: 888,
				blockchainIdentifierMatches: true,
			},
			forcedOnChainState: null,
			expectedVersion: {
				updatedAt,
				currentTransactionId: 'shared-old-transaction',
				onChainState: OnChainState.FundsLocked,
				resultHash: null,
			},
		});

		expect(mockTransactionUpdateMany).not.toHaveBeenCalled();
		expect(mockHotWalletUpdateMany).not.toHaveBeenCalledWith(
			expect.objectContaining({ where: expect.objectContaining({ id: 'shared-wallet' }) }),
		);
		expect(mockPurchaseUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'request-id' } }));
	});

	it('rejects a stale snapshot before mutating transaction state', async () => {
		mockPaymentFindUnique.mockResolvedValueOnce({
			id: 'request-id',
			updatedAt: new Date(updatedAt.getTime() + 1_000),
			onChainState: OnChainState.ResultSubmitted,
			resultHash: 'new-result',
			currentTransactionId: 'new-current',
			CurrentTransaction: null,
			TransactionHistory: [],
		});

		await expect(
			repairRequestTransaction({
				kind: 'payment',
				requestId: 'request-id',
				txHash: 'c'.repeat(64),
				validation: null,
				forcedOnChainState: OnChainState.FundsLocked,
				expectedVersion: {
					updatedAt,
					currentTransactionId: null,
					onChainState: null,
					resultHash: null,
				},
			}),
		).rejects.toBeInstanceOf(RepairConflictError);
		expect(mockTransactionFindFirst).not.toHaveBeenCalled();
		expect(mockPaymentUpdate).not.toHaveBeenCalled();
	});
});
