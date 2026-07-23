import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
	HotWalletType,
	Network,
	OnChainState,
	PaymentAction,
	PurchasingAction,
	TransactionLayer,
	TransactionStatus,
	WalletType,
} from '@/generated/prisma/client';
import { SmartContractState } from '@masumi/payment-core/smart-contract-state';
import { generateBlockchainIdentifier } from '@masumi/payment-core/blockchain-identifier';
import { Constr, Data } from 'lucid-cardano';
import type { DecodedV1ContractDatum } from '@/utils/converter/string-datum-convert';
import type { HydraTransactionEvidence } from './hydra-transaction-evidence';

const mockPurchaseFindUnique = jest.fn<(_args: unknown) => Promise<unknown>>();
const mockPurchaseFindMany = jest.fn<(_args: unknown) => Promise<unknown>>();
const mockPurchaseUpdate = jest.fn<(_args: unknown) => Promise<unknown>>();
const mockPaymentFindUnique = jest.fn<(_args: unknown) => Promise<unknown>>();
const mockPaymentFindMany = jest.fn<(_args: unknown) => Promise<unknown>>();
const mockPaymentUpdate = jest.fn<(_args: unknown) => Promise<unknown>>();
const mockTransactionUpdate = jest.fn<(_args: unknown) => Promise<unknown>>();
const mockTransactionFindFirst = jest.fn<(_args: unknown) => Promise<unknown>>();
const mockTransactionCreate = jest.fn<(_args: unknown) => Promise<unknown>>();
const mockHotWalletUpdate = jest.fn<(_args: unknown) => Promise<unknown>>();
const mockHydraHeadFindUnique = jest.fn<(_args: unknown) => Promise<unknown>>();
const mockHydraAdmissionQuery = jest.fn<(_args: unknown) => Promise<unknown>>();

const transactionClient = {
	$queryRaw: mockHydraAdmissionQuery,
	purchaseRequest: {
		findUnique: mockPurchaseFindUnique,
		findMany: mockPurchaseFindMany,
		update: mockPurchaseUpdate,
	},
	paymentRequest: {
		findUnique: mockPaymentFindUnique,
		findMany: mockPaymentFindMany,
		update: mockPaymentUpdate,
	},
	transaction: {
		update: mockTransactionUpdate,
		findFirst: mockTransactionFindFirst,
		create: mockTransactionCreate,
	},
	hotWallet: { update: mockHotWalletUpdate },
	hydraHead: { findUnique: mockHydraHeadFindUnique },
};

const mockPrismaTransaction = jest.fn<(callback: (tx: typeof transactionClient) => Promise<void>) => Promise<void>>(
	async (callback) => callback(transactionClient),
);

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { $transaction: mockPrismaTransaction },
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: {
		info: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
		debug: jest.fn(),
	},
}));

const { applyDatumStateToLocalRequests: applyDatumStateToLocalRequestsRaw, applyTerminalHydraSpends } =
	await import('./hydra-datum-sync');
const applyDatumStateToLocalRequests = (
	params: Omit<Parameters<typeof applyDatumStateToLocalRequestsRaw>[0], 'network'>,
) => applyDatumStateToLocalRequestsRaw({ ...params, network: Network.Preprod });

const decodedInitialLock: DecodedV1ContractDatum = {
	blockchainIdentifier: generateBlockchainIdentifier(
		'01'.repeat(32),
		'02'.repeat(16),
		'03'.repeat(32),
		'04'.repeat(16),
		'addr-contract',
	),
	buyerAddress: 'addr-buyer',
	buyerReturnAddress: null,
	sellerAddress: 'addr-seller',
	sellerReturnAddress: null,
	buyerVkey: 'buyer-vkey',
	sellerVkey: 'seller-vkey',
	state: SmartContractState.FundsLocked,
	referenceKey: '01'.repeat(32),
	referenceSignature: '02'.repeat(16),
	sellerNonce: '03'.repeat(32),
	buyerNonce: '04'.repeat(16),
	collateralReturnLovelace: 0n,
	inputHash: 'input-hash',
	resultHash: null,
	payByTime: 1_655_770_000_000n,
	resultTime: 1_655_770_100_000n,
	unlockTime: 1_655_770_200_000n,
	externalDisputeUnlockTime: 1_655_770_300_000n,
	buyerCooldownTime: 0n,
	sellerCooldownTime: 0n,
};

function makeEvidence(params: {
	txHash: string;
	outputIndex?: number;
	signerVkeys?: string[];
	requiredSignerVkeys?: string[];
	inputs?: HydraTransactionEvidence['inputs'];
	spends?: HydraTransactionEvidence['spends'];
	includeOutput?: boolean;
	outputs?: HydraTransactionEvidence['outputs'];
	validityLowerSlot?: bigint | null;
	validityUpperSlot?: bigint | null;
}): HydraTransactionEvidence {
	const {
		txHash,
		outputIndex = 0,
		signerVkeys = [],
		requiredSignerVkeys = signerVkeys,
		inputs = [],
		spends = [],
		includeOutput = true,
		outputs,
		validityLowerSlot = 86_500n,
		validityUpperSlot = 86_501n,
	} = params;
	return {
		txHash,
		validityLowerSlot,
		validityUpperSlot,
		inputs,
		spends,
		outputs:
			outputs ??
			(includeOutput
				? [
						{
							outputIndex,
							address: 'addr-contract',
							amount: [{ unit: 'lovelace', quantity: '10000000' }],
							plutusData: null,
						},
					]
				: []),
		signerVkeys,
		requiredSignerVkeys,
	};
}

function makePaymentRequest(currentTransaction: { status: TransactionStatus } | null = null) {
	return {
		id: 'payment-1',
		blockchainIdentifier: decodedInitialLock.blockchainIdentifier,
		inputHash: decodedInitialLock.inputHash,
		submitResultTime: decodedInitialLock.resultTime,
		unlockTime: decodedInitialLock.unlockTime,
		externalDisputeUnlockTime: decodedInitialLock.externalDisputeUnlockTime,
		payByTime: decodedInitialLock.payByTime,
		onChainState: null,
		resultHash: null,
		buyerCoolDownTime: 0n,
		sellerCoolDownTime: 0n,
		collateralReturnLovelace: 0n,
		layer: TransactionLayer.L1,
		forceLayer: null,
		currentHydraUtxoTxHash: null,
		currentHydraUtxoOutputIndex: null,
		currentHydraUtxoValue: null,
		unresolvedHydraTerminalTxHash: null,
		unresolvedHydraTerminalReason: null,
		buyerReturnAddress: null,
		sellerReturnAddress: null,
		nextActionId: 'action-1',
		currentTransactionId: currentTransaction == null ? null : 'pending-transaction-1',
		NextAction: { requestedAction: PaymentAction.WaitingForExternalAction },
		RequestedFunds: [{ unit: 'lovelace', amount: 10_000_000n }],
		CurrentTransaction: currentTransaction,
		BuyerWallet: null,
		TransactionHistory: [],
		SmartContractWallet: {
			walletVkey: decodedInitialLock.sellerVkey,
			walletAddress: decodedInitialLock.sellerAddress,
		},
	};
}

function makePurchaseRequest(currentTransaction: object | null) {
	return {
		id: 'purchase-1',
		blockchainIdentifier: decodedInitialLock.blockchainIdentifier,
		inputHash: decodedInitialLock.inputHash,
		submitResultTime: decodedInitialLock.resultTime,
		unlockTime: decodedInitialLock.unlockTime,
		externalDisputeUnlockTime: decodedInitialLock.externalDisputeUnlockTime,
		payByTime: decodedInitialLock.payByTime,
		onChainState: null,
		resultHash: null,
		buyerCoolDownTime: 0n,
		sellerCoolDownTime: 0n,
		collateralReturnLovelace: 0n,
		layer: TransactionLayer.L2,
		forceLayer: null,
		paymentForceLayer: null,
		currentHydraUtxoTxHash: null,
		currentHydraUtxoOutputIndex: null,
		currentHydraUtxoValue: null,
		unresolvedHydraTerminalTxHash: null,
		unresolvedHydraTerminalReason: null,
		buyerReturnAddress: null,
		sellerReturnAddress: null,
		nextActionId: 'purchase-action-1',
		currentTransactionId: 'shared-transaction-1',
		NextAction: { requestedAction: PurchasingAction.FundsLockingInitiated },
		PaidFunds: [{ unit: 'lovelace', amount: 10_000_000n }],
		CurrentTransaction: currentTransaction,
		TransactionHistory: [],
		SellerWallet: { walletVkey: 'seller-vkey', walletAddress: 'addr-seller' },
		SmartContractWallet: { walletVkey: 'buyer-vkey', walletAddress: 'addr-buyer' },
	};
}

function makeTerminalPaymentRequest(params: {
	onChainState: OnChainState;
	resultHash: string | null;
	inputTxHash: string;
	buyerReturnAddress?: string | null;
	sellerReturnAddress?: string | null;
	collateralReturnLovelace?: bigint;
	currentHydraUtxoValue?: Array<{ unit: string; quantity: string }>;
	terminalTxHash?: string;
}) {
	const collateralReturnLovelace = params.collateralReturnLovelace ?? 0n;
	const terminalTxHash = params.terminalTxHash ?? 'pending-terminal-tx';
	return {
		...makePaymentRequest(),
		onChainState: params.onChainState,
		resultHash: params.resultHash,
		buyerReturnAddress: params.buyerReturnAddress ?? null,
		sellerReturnAddress: params.sellerReturnAddress ?? null,
		collateralReturnLovelace,
		layer: TransactionLayer.L2,
		currentHydraUtxoTxHash: params.inputTxHash,
		currentHydraUtxoOutputIndex: 0,
		currentHydraUtxoValue: params.currentHydraUtxoValue ?? [
			{ unit: 'lovelace', quantity: (10_000_000n + collateralReturnLovelace).toString() },
		],
		currentTransactionId: 'pending-terminal-tx-id',
		CurrentTransaction: {
			id: 'pending-terminal-tx-id',
			txHash: terminalTxHash,
			intendedTxHash: terminalTxHash,
			status: TransactionStatus.Pending,
			layer: TransactionLayer.L2,
			hydraHeadId: 'head-1',
			BlocksWallet: null,
		},
		BuyerWallet: { walletVkey: 'buyer-vkey', walletAddress: 'addr-buyer' },
	};
}

describe('applyDatumStateToLocalRequests', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockHydraAdmissionQuery.mockResolvedValue([
			{ isEnabled: true, initTxHash: 'a'.repeat(64), reconciliationCompletedAt: null },
		]);
		mockPurchaseFindUnique.mockResolvedValue(null);
		mockPurchaseFindMany.mockResolvedValue([]);
		mockPaymentFindMany.mockResolvedValue([]);
		mockPaymentUpdate.mockResolvedValue({});
		mockTransactionFindFirst.mockResolvedValue(null);
		mockTransactionCreate.mockResolvedValue({ id: 'observed-transaction-1' });
		mockHydraHeadFindUnique.mockResolvedValue({
			HydraRelation: {
				LocalHotWallet: {
					walletVkey: decodedInitialLock.sellerVkey,
					walletAddress: decodedInitialLock.sellerAddress,
					paymentSourceId: 'source-1',
					PaymentSource: {
						id: 'source-1',
						network: Network.Preprod,
						smartContractAddress: 'addr-contract',
						cooldownTime: 0,
					},
				},
				RemoteWallet: {
					walletVkey: decodedInitialLock.buyerVkey,
					walletAddress: decodedInitialLock.buyerAddress,
					paymentSourceId: 'source-1',
				},
			},
		});
	});

	it.each([
		['disabled', { isEnabled: false, initTxHash: 'a'.repeat(64), reconciliationCompletedAt: null }],
		['unverified', { isEnabled: true, initTxHash: null, reconciliationCompletedAt: null }],
		['already reconciled', { isEnabled: true, initTxHash: 'a'.repeat(64), reconciliationCompletedAt: new Date() }],
	])('locks out datum mutations when the durable head is %s', async (_reason, admission) => {
		mockHydraAdmissionQuery.mockResolvedValue([admission]);
		mockPaymentFindUnique.mockResolvedValue(makePaymentRequest());

		const outcome = await applyDatumStateToLocalRequests({
			hydraHeadId: 'head-1',
			txId: 'stale-lock',
			paymentSourceId: 'source-1',
			decoded: decodedInitialLock,
			newOnChainState: OnChainState.FundsLocked,
			outputAmounts: [{ unit: 'lovelace', quantity: '10000000' }],
			outputReference: { txHash: 'stale-lock', outputIndex: 0 },
			transactionEvidence: makeEvidence({ txHash: 'stale-lock', signerVkeys: ['buyer-vkey'] }),
			confirmationTimeMs: 49,
		});

		expect(outcome).toBe('retry');
		expect(mockHydraHeadFindUnique).not.toHaveBeenCalled();
		expect(mockPaymentUpdate).not.toHaveBeenCalled();
		expect(mockTransactionCreate).not.toHaveBeenCalled();
	});

	it('locks out terminal mutations after durable head disablement', async () => {
		mockHydraAdmissionQuery.mockResolvedValue([
			{ isEnabled: false, initTxHash: 'a'.repeat(64), reconciliationCompletedAt: null },
		]);

		const outcome = await applyTerminalHydraSpends({
			hydraHeadId: 'head-1',
			txId: 'stale-terminal',
			paymentSourceId: 'source-1',
			transactionEvidence: makeEvidence({
				txHash: 'stale-terminal',
				includeOutput: false,
				inputs: [{ txHash: 'prior-output', outputIndex: 0, bodyIndex: 0 }],
			}),
		});

		expect(outcome).toBe('retry');
		expect(mockHydraHeadFindUnique).not.toHaveBeenCalled();
		expect(mockPaymentFindMany).not.toHaveBeenCalled();
		expect(mockPurchaseFindMany).not.toHaveBeenCalled();
	});

	it('creates and fully hydrates the first seller-side L2 observation', async () => {
		mockPaymentFindUnique.mockResolvedValue(makePaymentRequest());

		await applyDatumStateToLocalRequests({
			hydraHeadId: 'head-1',
			txId: 'lock-tx-1',
			paymentSourceId: 'source-1',
			decoded: decodedInitialLock,
			newOnChainState: OnChainState.FundsLocked,
			outputAmounts: [{ unit: 'lovelace', quantity: '10000000' }],
			outputReference: { txHash: 'lock-tx-1', outputIndex: 0 },
			transactionEvidence: makeEvidence({
				txHash: 'lock-tx-1',
				signerVkeys: ['buyer-vkey'],
				requiredSignerVkeys: [],
			}),
			confirmationTimeMs: 49,
			targetSide: 'payment',
			skipPendingCurrentTransaction: true,
		});

		expect(mockPaymentUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: 'payment-1' },
				data: expect.objectContaining({
					layer: TransactionLayer.L2,
					currentHydraUtxoTxHash: 'lock-tx-1',
					currentHydraUtxoOutputIndex: 0,
					onChainState: OnChainState.FundsLocked,
					collateralReturnLovelace: 0n,
					BuyerWallet: {
						connectOrCreate: {
							where: {
								paymentSourceId_walletVkey_walletAddress_type: {
									paymentSourceId: 'source-1',
									walletVkey: 'buyer-vkey',
									walletAddress: 'addr-buyer',
									type: WalletType.Buyer,
								},
							},
							create: expect.objectContaining({
								walletVkey: 'buyer-vkey',
								walletAddress: 'addr-buyer',
								type: WalletType.Buyer,
							}),
						},
					},
					CurrentTransaction: { connect: { id: 'observed-transaction-1' } },
				}),
			}),
		);
		expect(mockTransactionCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					txHash: 'lock-tx-1',
					status: TransactionStatus.Confirmed,
					layer: TransactionLayer.L2,
				}),
			}),
		);
	});

	it('does not reuse a tx-hash row whose scalar transition belongs to another escrow output', async () => {
		mockPaymentFindUnique.mockResolvedValue(makePaymentRequest());
		mockTransactionFindFirst.mockResolvedValue({
			id: 'other-output-transaction',
			status: TransactionStatus.Confirmed,
			previousOnChainState: OnChainState.FundsLocked,
			newOnChainState: OnChainState.ResultSubmitted,
			BlocksWallet: null,
		});
		mockTransactionCreate.mockResolvedValue({ id: 'lock-output-transaction' });

		await expect(
			applyDatumStateToLocalRequests({
				hydraHeadId: 'head-1',
				txId: 'multi-output-tx',
				paymentSourceId: 'source-1',
				decoded: decodedInitialLock,
				newOnChainState: OnChainState.FundsLocked,
				outputAmounts: [{ unit: 'lovelace', quantity: '10000000' }],
				outputReference: { txHash: 'multi-output-tx', outputIndex: 1 },
				transactionEvidence: makeEvidence({
					txHash: 'multi-output-tx',
					outputIndex: 1,
					signerVkeys: ['buyer-vkey'],
				}),
				confirmationTimeMs: 49,
				targetSide: 'payment',
			}),
		).resolves.toBe('applied');

		expect(mockTransactionUpdate).not.toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: 'other-output-transaction' } }),
		);
		expect(mockTransactionCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					txHash: 'multi-output-tx',
					previousOnChainState: null,
					newOnChainState: OnChainState.FundsLocked,
				}),
			}),
		);
		expect(mockPaymentUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					CurrentTransaction: { connect: { id: 'lock-output-transaction' } },
				}),
			}),
		);
	});

	it('ignores a Hydra initial output for a payment explicitly forced to L1', async () => {
		mockPaymentFindUnique.mockResolvedValue({
			...makePaymentRequest(),
			forceLayer: TransactionLayer.L1,
		});

		const outcome = await applyDatumStateToLocalRequests({
			hydraHeadId: 'head-1',
			txId: 'copied-hydra-lock',
			paymentSourceId: 'source-1',
			decoded: decodedInitialLock,
			newOnChainState: OnChainState.FundsLocked,
			outputAmounts: [{ unit: 'lovelace', quantity: '10000000' }],
			outputReference: { txHash: 'copied-hydra-lock', outputIndex: 0 },
			transactionEvidence: makeEvidence({
				txHash: 'copied-hydra-lock',
				signerVkeys: ['buyer-vkey'],
			}),
			confirmationTimeMs: 49,
			targetSide: 'payment',
		});

		expect(outcome).toBe('irrelevant');
		expect(mockPaymentUpdate).not.toHaveBeenCalled();
		expect(mockTransactionCreate).not.toHaveBeenCalled();
	});

	it('ignores a Hydra output for an escrow already owned by L1', async () => {
		mockPaymentFindUnique.mockResolvedValue({
			...makePaymentRequest(),
			onChainState: OnChainState.FundsLocked,
			BuyerWallet: { walletVkey: 'buyer-vkey', walletAddress: 'addr-buyer' },
		});

		const outcome = await applyDatumStateToLocalRequests({
			hydraHeadId: 'head-1',
			txId: 'copied-existing-l1-lock',
			paymentSourceId: 'source-1',
			decoded: decodedInitialLock,
			newOnChainState: OnChainState.FundsLocked,
			outputAmounts: [{ unit: 'lovelace', quantity: '10000000' }],
			outputReference: { txHash: 'copied-existing-l1-lock', outputIndex: 0 },
			transactionEvidence: makeEvidence({
				txHash: 'copied-existing-l1-lock',
				signerVkeys: ['buyer-vkey'],
			}),
			confirmationTimeMs: 49,
			targetSide: 'payment',
		});

		expect(outcome).toBe('irrelevant');
		expect(mockPaymentUpdate).not.toHaveBeenCalled();
		expect(mockTransactionCreate).not.toHaveBeenCalled();
	});

	it('ignores a Hydra initial output when the purchase routing resolves to L1', async () => {
		mockPurchaseFindUnique.mockResolvedValue({
			...makePurchaseRequest(null),
			layer: TransactionLayer.L1,
			forceLayer: null,
			paymentForceLayer: TransactionLayer.L1,
			currentTransactionId: null,
		});

		const outcome = await applyDatumStateToLocalRequests({
			hydraHeadId: 'head-1',
			txId: 'copied-purchase-hydra-lock',
			paymentSourceId: 'source-1',
			decoded: decodedInitialLock,
			newOnChainState: OnChainState.FundsLocked,
			outputAmounts: [{ unit: 'lovelace', quantity: '10000000' }],
			outputReference: { txHash: 'copied-purchase-hydra-lock', outputIndex: 0 },
			transactionEvidence: makeEvidence({
				txHash: 'copied-purchase-hydra-lock',
				signerVkeys: ['buyer-vkey'],
			}),
			confirmationTimeMs: 49,
			targetSide: 'purchase',
		});

		expect(outcome).toBe('irrelevant');
		expect(mockPurchaseUpdate).not.toHaveBeenCalled();
		expect(mockTransactionCreate).not.toHaveBeenCalled();
	});

	it('ignores a Hydra output while an automatic purchase has a pending L1 reservation', async () => {
		mockPurchaseFindUnique.mockResolvedValue({
			...makePurchaseRequest({
				id: 'pending-l1-transaction',
				txHash: 'pending-l1-hash',
				intendedTxHash: 'pending-l1-hash',
				status: TransactionStatus.Pending,
				layer: TransactionLayer.L1,
				hydraHeadId: null,
				BlocksWallet: null,
			}),
			layer: TransactionLayer.L1,
		});

		const outcome = await applyDatumStateToLocalRequests({
			hydraHeadId: 'head-1',
			txId: 'copied-pending-l1-lock',
			paymentSourceId: 'source-1',
			decoded: decodedInitialLock,
			newOnChainState: OnChainState.FundsLocked,
			outputAmounts: [{ unit: 'lovelace', quantity: '10000000' }],
			outputReference: { txHash: 'copied-pending-l1-lock', outputIndex: 0 },
			transactionEvidence: makeEvidence({
				txHash: 'copied-pending-l1-lock',
				signerVkeys: ['buyer-vkey'],
			}),
			confirmationTimeMs: 49,
			targetSide: 'purchase',
		});

		expect(outcome).toBe('irrelevant');
		expect(mockPurchaseUpdate).not.toHaveBeenCalled();
		expect(mockTransactionCreate).not.toHaveBeenCalled();
	});

	it('sums duplicate requested units before validating an initial lock', async () => {
		mockPaymentFindUnique.mockResolvedValue({
			...makePaymentRequest(),
			RequestedFunds: [
				{ unit: 'lovelace', amount: 5_000_000n },
				{ unit: '', amount: 5_000_000n },
			],
		});

		const outcome = await applyDatumStateToLocalRequests({
			hydraHeadId: 'head-1',
			txId: 'underfunded-lock',
			paymentSourceId: 'source-1',
			decoded: decodedInitialLock,
			newOnChainState: OnChainState.FundsLocked,
			outputAmounts: [{ unit: 'lovelace', quantity: '5000000' }],
			outputReference: { txHash: 'underfunded-lock', outputIndex: 0 },
			transactionEvidence: makeEvidence({
				txHash: 'underfunded-lock',
				signerVkeys: ['buyer-vkey'],
				outputs: [
					{
						outputIndex: 0,
						address: 'addr-contract',
						amount: [{ unit: 'lovelace', quantity: '5000000' }],
						plutusData: null,
					},
				],
			}),
			confirmationTimeMs: 49,
			targetSide: 'payment',
		});

		expect(outcome).toBe('applied');
		expect(mockPaymentUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ onChainState: OnChainState.FundsOrDatumInvalid }),
			}),
		);
	});

	it('rejects a first-seen lock not signed by the buyer', async () => {
		mockPaymentFindUnique.mockResolvedValue(makePaymentRequest());

		await applyDatumStateToLocalRequests({
			hydraHeadId: 'head-1',
			txId: 'spoof-lock-tx',
			paymentSourceId: 'source-1',
			decoded: decodedInitialLock,
			newOnChainState: OnChainState.FundsLocked,
			outputAmounts: [{ unit: 'lovelace', quantity: '10000000' }],
			outputReference: { txHash: 'spoof-lock-tx', outputIndex: 0 },
			transactionEvidence: makeEvidence({ txHash: 'spoof-lock-tx', signerVkeys: ['seller-vkey'] }),
			confirmationTimeMs: 49,
			targetSide: 'payment',
		});

		expect(mockPaymentUpdate).not.toHaveBeenCalled();
		expect(mockTransactionCreate).not.toHaveBeenCalled();
	});

	it('keeps a first-seen lock retryable when confirmation timestamp is unavailable', async () => {
		mockPaymentFindUnique.mockResolvedValue(makePaymentRequest());

		const outcome = await applyDatumStateToLocalRequests({
			hydraHeadId: 'head-1',
			txId: 'untimed-lock-tx',
			paymentSourceId: 'source-1',
			decoded: decodedInitialLock,
			newOnChainState: OnChainState.FundsLocked,
			outputAmounts: [{ unit: 'lovelace', quantity: '10000000' }],
			outputReference: { txHash: 'untimed-lock-tx', outputIndex: 0 },
			transactionEvidence: makeEvidence({ txHash: 'untimed-lock-tx', signerVkeys: ['buyer-vkey'] }),
			confirmationTimeMs: null,
			targetSide: 'payment',
		});

		expect(outcome).toBe('retry');
		expect(mockPaymentUpdate).not.toHaveBeenCalled();
		expect(mockTransactionCreate).not.toHaveBeenCalled();
	});

	it('keeps a first-seen lock retryable when signed invalid-hereafter is missing', async () => {
		mockPaymentFindUnique.mockResolvedValue(makePaymentRequest());

		const outcome = await applyDatumStateToLocalRequests({
			hydraHeadId: 'head-1',
			txId: 'unbounded-lock-tx',
			paymentSourceId: 'source-1',
			decoded: decodedInitialLock,
			newOnChainState: OnChainState.FundsLocked,
			outputAmounts: [{ unit: 'lovelace', quantity: '10000000' }],
			outputReference: { txHash: 'unbounded-lock-tx', outputIndex: 0 },
			transactionEvidence: makeEvidence({
				txHash: 'unbounded-lock-tx',
				signerVkeys: ['buyer-vkey'],
				validityUpperSlot: null,
			}),
			confirmationTimeMs: Number(decodedInitialLock.payByTime) - 1,
			targetSide: 'payment',
		});

		expect(outcome).toBe('retry');
		expect(mockPaymentUpdate).not.toHaveBeenCalled();
		expect(mockTransactionCreate).not.toHaveBeenCalled();
	});

	it('rejects a late signed upper bound despite a forged early API timestamp', async () => {
		mockPaymentFindUnique.mockResolvedValue(makePaymentRequest());

		const outcome = await applyDatumStateToLocalRequests({
			hydraHeadId: 'head-1',
			txId: 'body-late-lock-tx',
			paymentSourceId: 'source-1',
			decoded: decodedInitialLock,
			newOnChainState: OnChainState.FundsLocked,
			outputAmounts: [{ unit: 'lovelace', quantity: '10000000' }],
			outputReference: { txHash: 'body-late-lock-tx', outputIndex: 0 },
			transactionEvidence: makeEvidence({
				txHash: 'body-late-lock-tx',
				signerVkeys: ['buyer-vkey'],
				validityUpperSlot: 86_800n,
			}),
			confirmationTimeMs: 1,
			targetSide: 'payment',
		});

		expect(outcome).toBe('retry');
		expect(mockPaymentUpdate).not.toHaveBeenCalled();
		expect(mockTransactionCreate).not.toHaveBeenCalled();
	});

	it('confirms both sides of a buyer-local shared lock in one transaction', async () => {
		const sharedTransaction = {
			id: 'shared-transaction-1',
			txHash: 'shared-lock-tx',
			intendedTxHash: 'shared-lock-tx',
			status: TransactionStatus.Pending,
			layer: TransactionLayer.L2,
			hydraHeadId: 'head-1',
			BlocksWallet: null,
		};
		mockHydraHeadFindUnique.mockResolvedValue({
			HydraRelation: {
				LocalHotWallet: {
					walletVkey: 'buyer-vkey',
					walletAddress: 'addr-buyer',
					paymentSourceId: 'source-1',
					PaymentSource: {
						id: 'source-1',
						network: Network.Preprod,
						smartContractAddress: 'addr-contract',
						cooldownTime: 0,
					},
				},
				RemoteWallet: {
					walletVkey: 'seller-vkey',
					walletAddress: 'addr-seller',
					paymentSourceId: 'source-1',
				},
			},
		});
		mockPurchaseFindUnique.mockResolvedValue(makePurchaseRequest(sharedTransaction));
		mockPaymentFindUnique.mockResolvedValue({
			...makePaymentRequest(),
			layer: TransactionLayer.L2,
			currentTransactionId: 'shared-transaction-1',
			CurrentTransaction: sharedTransaction,
		});

		await applyDatumStateToLocalRequests({
			hydraHeadId: 'head-1',
			txId: 'shared-lock-tx',
			paymentSourceId: 'source-1',
			decoded: decodedInitialLock,
			newOnChainState: OnChainState.FundsLocked,
			outputAmounts: [{ unit: 'lovelace', quantity: '10000000' }],
			outputReference: { txHash: 'shared-lock-tx', outputIndex: 0 },
			transactionEvidence: makeEvidence({ txHash: 'shared-lock-tx', signerVkeys: ['buyer-vkey'] }),
			confirmationTimeMs: 49,
		});

		expect(mockPurchaseUpdate).toHaveBeenCalledTimes(1);
		expect(mockPaymentUpdate).toHaveBeenCalledTimes(1);
		expect(mockTransactionCreate).not.toHaveBeenCalled();
	});

	it('promotes a pre-submit L2 reservation when TxValid persistence failed', async () => {
		const reservedTransaction = {
			id: 'shared-transaction-1',
			txHash: null,
			intendedTxHash: 'reserved-lock-tx',
			status: TransactionStatus.Pending,
			layer: TransactionLayer.L2,
			hydraHeadId: 'head-1',
			BlocksWallet: { id: 'buyer-wallet-1' },
		};
		mockHydraHeadFindUnique.mockResolvedValue({
			HydraRelation: {
				LocalHotWallet: {
					id: 'buyer-wallet-1',
					type: 'Purchasing',
					walletVkey: 'buyer-vkey',
					walletAddress: 'addr-buyer',
					paymentSourceId: 'source-1',
					PaymentSource: {
						id: 'source-1',
						network: Network.Preprod,
						smartContractAddress: 'addr-contract',
						cooldownTime: 0,
					},
				},
				RemoteWallet: {
					walletVkey: 'seller-vkey',
					walletAddress: 'addr-seller',
					paymentSourceId: 'source-1',
				},
			},
		});
		mockPurchaseFindUnique.mockResolvedValue(makePurchaseRequest(reservedTransaction));
		mockPaymentFindUnique.mockResolvedValue(null);

		const outcome = await applyDatumStateToLocalRequests({
			hydraHeadId: 'head-1',
			txId: 'reserved-lock-tx',
			paymentSourceId: 'source-1',
			decoded: decodedInitialLock,
			newOnChainState: OnChainState.FundsLocked,
			outputAmounts: [{ unit: 'lovelace', quantity: '10000000' }],
			outputReference: { txHash: 'reserved-lock-tx', outputIndex: 0 },
			transactionEvidence: makeEvidence({ txHash: 'reserved-lock-tx', signerVkeys: ['buyer-vkey'] }),
			confirmationTimeMs: 49,
			targetSide: 'purchase',
		});

		expect(outcome).toBe('applied');
		expect(mockTransactionUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: 'shared-transaction-1' },
				data: expect.objectContaining({
					txHash: 'reserved-lock-tx',
					intendedTxHash: 'reserved-lock-tx',
					status: TransactionStatus.Confirmed,
				}),
			}),
		);
		expect(mockTransactionCreate).not.toHaveBeenCalled();
	});

	it('keeps a late-looking lock retryable because API timestamp is not signed evidence', async () => {
		mockPaymentFindUnique.mockResolvedValue(makePaymentRequest());

		const outcome = await applyDatumStateToLocalRequests({
			hydraHeadId: 'head-1',
			txId: 'late-lock-tx',
			paymentSourceId: 'source-1',
			decoded: decodedInitialLock,
			newOnChainState: OnChainState.FundsLocked,
			outputAmounts: [{ unit: 'lovelace', quantity: '10000000' }],
			outputReference: { txHash: 'late-lock-tx', outputIndex: 0 },
			transactionEvidence: makeEvidence({ txHash: 'late-lock-tx', signerVkeys: ['buyer-vkey'] }),
			confirmationTimeMs: Number(decodedInitialLock.payByTime) + 1,
			targetSide: 'payment',
		});

		expect(outcome).toBe('retry');
		expect(mockPaymentUpdate).not.toHaveBeenCalled();
	});

	it('recovers the buyer wallet and collateral for a purchase lock missing its post-submit DB write', async () => {
		mockHydraHeadFindUnique.mockResolvedValue({
			HydraRelation: {
				LocalHotWallet: {
					id: 'buyer-hot-wallet',
					type: HotWalletType.Purchasing,
					walletVkey: decodedInitialLock.buyerVkey,
					walletAddress: decodedInitialLock.buyerAddress,
					paymentSourceId: 'source-1',
					PaymentSource: {
						id: 'source-1',
						network: Network.Preprod,
						smartContractAddress: 'addr-contract',
						cooldownTime: 0,
					},
				},
				RemoteWallet: {
					walletVkey: decodedInitialLock.sellerVkey,
					walletAddress: decodedInitialLock.sellerAddress,
					paymentSourceId: 'source-1',
				},
			},
		});
		mockPurchaseFindUnique.mockResolvedValue({
			...makePurchaseRequest(null),
			currentTransactionId: null,
			CurrentTransaction: null,
			SmartContractWallet: null,
		});

		await expect(
			applyDatumStateToLocalRequests({
				hydraHeadId: 'head-1',
				txId: 'recovered-lock-tx',
				paymentSourceId: 'source-1',
				decoded: decodedInitialLock,
				newOnChainState: OnChainState.FundsLocked,
				outputAmounts: [{ unit: 'lovelace', quantity: '10000000' }],
				outputReference: { txHash: 'recovered-lock-tx', outputIndex: 0 },
				transactionEvidence: makeEvidence({ txHash: 'recovered-lock-tx', signerVkeys: ['buyer-vkey'] }),
				confirmationTimeMs: 49,
				targetSide: 'purchase',
			}),
		).resolves.toBe('applied');

		expect(mockPurchaseUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					collateralReturnLovelace: 0n,
					SmartContractWallet: { connect: { id: 'buyer-hot-wallet' } },
				}),
			}),
		);
	});

	it('does not overwrite a pending local transaction during periodic reconciliation', async () => {
		mockPaymentFindUnique.mockResolvedValue(makePaymentRequest({ status: TransactionStatus.Pending }));

		await applyDatumStateToLocalRequests({
			hydraHeadId: 'head-1',
			txId: 'counterparty-tx-1',
			paymentSourceId: 'source-1',
			decoded: decodedInitialLock,
			newOnChainState: OnChainState.FundsLocked,
			outputAmounts: [{ unit: 'lovelace', quantity: '10000000' }],
			outputReference: { txHash: 'counterparty-tx-1', outputIndex: 0 },
			transactionEvidence: null,
			confirmationTimeMs: 49,
			targetSide: 'payment',
			skipPendingCurrentTransaction: true,
		});

		expect(mockPaymentUpdate).not.toHaveBeenCalled();
	});

	it('does not revalidate and regress an already-confirmed FundsLocked output after restart', async () => {
		mockPaymentFindUnique.mockResolvedValue({
			...makePaymentRequest(),
			onChainState: OnChainState.FundsLocked,
			layer: TransactionLayer.L2,
			currentHydraUtxoTxHash: 'lock-tx-1',
			currentHydraUtxoOutputIndex: 0,
			currentTransactionId: 'confirmed-transaction-1',
			CurrentTransaction: {
				id: 'confirmed-transaction-1',
				txHash: 'lock-tx-1',
				status: TransactionStatus.Confirmed,
				layer: TransactionLayer.L2,
				hydraHeadId: 'head-1',
				BlocksWallet: null,
			},
		});

		await applyDatumStateToLocalRequests({
			hydraHeadId: 'head-1',
			txId: 'lock-tx-1',
			paymentSourceId: 'source-1',
			decoded: decodedInitialLock,
			newOnChainState: OnChainState.FundsLocked,
			outputAmounts: [{ unit: 'lovelace', quantity: '10000000' }],
			outputReference: { txHash: 'lock-tx-1', outputIndex: 0 },
			transactionEvidence: null,
			confirmationTimeMs: null,
			targetSide: 'payment',
			skipPendingCurrentTransaction: true,
		});

		expect(mockPaymentUpdate).not.toHaveBeenCalled();
	});

	it('rejects a state mutation that reuses the exact same immutable output reference', async () => {
		mockPaymentFindUnique.mockResolvedValue({
			...makePaymentRequest(),
			onChainState: OnChainState.FundsLocked,
			layer: TransactionLayer.L2,
			currentHydraUtxoTxHash: 'lock-tx-1',
			currentHydraUtxoOutputIndex: 0,
			currentTransactionId: 'confirmed-transaction-1',
			CurrentTransaction: {
				id: 'confirmed-transaction-1',
				txHash: 'lock-tx-1',
				intendedTxHash: 'lock-tx-1',
				status: TransactionStatus.Confirmed,
				layer: TransactionLayer.L2,
				hydraHeadId: 'head-1',
				BlocksWallet: null,
			},
		});

		const outcome = await applyDatumStateToLocalRequests({
			hydraHeadId: 'head-1',
			txId: 'lock-tx-1',
			paymentSourceId: 'source-1',
			decoded: {
				...decodedInitialLock,
				state: SmartContractState.ResultSubmitted,
				resultHash: 'forged-result',
			},
			newOnChainState: OnChainState.ResultSubmitted,
			outputAmounts: [{ unit: 'lovelace', quantity: '10000000' }],
			outputReference: { txHash: 'lock-tx-1', outputIndex: 0 },
			transactionEvidence: makeEvidence({ txHash: 'lock-tx-1' }),
			confirmationTimeMs: 49,
			targetSide: 'payment',
		});

		expect(outcome).toBe('retry');
		expect(mockPaymentUpdate).not.toHaveBeenCalled();
		expect(mockTransactionUpdate).not.toHaveBeenCalled();
	});

	it('backfills a proven legacy initial lock but fails closed on a historical continuation', async () => {
		const pendingTerminalTransaction = {
			id: 'pending-terminal-id',
			txHash: 'terminal-tx',
			intendedTxHash: 'terminal-tx',
			status: TransactionStatus.Pending,
			layer: TransactionLayer.L2,
			hydraHeadId: 'head-1',
			BlocksWallet: null,
		};
		mockPaymentFindUnique
			.mockResolvedValueOnce({
				...makePaymentRequest(),
				onChainState: OnChainState.ResultSubmitted,
				layer: TransactionLayer.L2,
				currentTransactionId: pendingTerminalTransaction.id,
				CurrentTransaction: pendingTerminalTransaction,
				BuyerWallet: { walletVkey: 'buyer-vkey', walletAddress: 'addr-buyer' },
				TransactionHistory: [{ txHash: 'lock-tx' }],
			})
			.mockResolvedValueOnce({
				...makePaymentRequest(),
				onChainState: OnChainState.ResultSubmitted,
				layer: TransactionLayer.L2,
				currentHydraUtxoTxHash: 'lock-tx',
				currentHydraUtxoOutputIndex: 0,
				currentHydraUtxoValue: [{ unit: 'lovelace', quantity: '10000000' }],
				currentTransactionId: pendingTerminalTransaction.id,
				CurrentTransaction: pendingTerminalTransaction,
				BuyerWallet: { walletVkey: 'buyer-vkey', walletAddress: 'addr-buyer' },
				TransactionHistory: [{ txHash: 'result-tx' }],
			});

		await expect(
			applyDatumStateToLocalRequests({
				hydraHeadId: 'head-1',
				txId: 'lock-tx',
				paymentSourceId: 'source-1',
				decoded: decodedInitialLock,
				newOnChainState: OnChainState.FundsLocked,
				outputAmounts: [{ unit: 'lovelace', quantity: '10000000' }],
				outputReference: { txHash: 'lock-tx', outputIndex: 0 },
				transactionEvidence: makeEvidence({ txHash: 'lock-tx', signerVkeys: ['buyer-vkey'] }),
				confirmationTimeMs: 49,
				targetSide: 'payment',
			}),
		).resolves.toBe('applied');

		await expect(
			applyDatumStateToLocalRequests({
				hydraHeadId: 'head-1',
				txId: 'result-tx',
				paymentSourceId: 'source-1',
				decoded: {
					...decodedInitialLock,
					state: SmartContractState.ResultSubmitted,
					resultHash: 'result-hash',
				},
				newOnChainState: OnChainState.ResultSubmitted,
				outputAmounts: [{ unit: 'lovelace', quantity: '10000000' }],
				outputReference: { txHash: 'result-tx', outputIndex: 2 },
				transactionEvidence: makeEvidence({
					txHash: 'result-tx',
					outputIndex: 2,
					inputs: [{ txHash: 'lock-tx', outputIndex: 0, bodyIndex: 0 }],
				}),
				confirmationTimeMs: 60,
				targetSide: 'payment',
			}),
		).resolves.toBe('retry');

		expect(mockPaymentUpdate).toHaveBeenCalledTimes(1);
		expect(mockPaymentUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: 'payment-1' },
				data: expect.objectContaining({
					currentHydraUtxoTxHash: 'lock-tx',
					currentHydraUtxoOutputIndex: 0,
					currentHydraUtxoValue: [{ unit: 'lovelace', quantity: '10000000' }],
				}),
			}),
		);
		expect(mockTransactionUpdate).not.toHaveBeenCalled();
	});

	it('promotes an intended-only pending continuation when verified CBOR consumes the current output', async () => {
		const intendedOnlyTransaction = {
			id: 'intended-only-transaction',
			txHash: null,
			intendedTxHash: 'result-tx',
			status: TransactionStatus.Pending,
			layer: TransactionLayer.L2,
			hydraHeadId: 'head-1',
			BlocksWallet: null,
		};
		mockPaymentFindUnique.mockResolvedValue({
			...makePaymentRequest(),
			onChainState: OnChainState.FundsLocked,
			layer: TransactionLayer.L2,
			currentHydraUtxoTxHash: 'lock-tx',
			currentHydraUtxoOutputIndex: 0,
			currentHydraUtxoValue: [{ unit: 'lovelace', quantity: '10000000' }],
			currentTransactionId: intendedOnlyTransaction.id,
			CurrentTransaction: intendedOnlyTransaction,
			BuyerWallet: { walletVkey: 'buyer-vkey', walletAddress: 'addr-buyer' },
			NextAction: { requestedAction: PaymentAction.SubmitResultInitiated },
		});

		const outcome = await applyDatumStateToLocalRequests({
			hydraHeadId: 'head-1',
			txId: 'result-tx',
			paymentSourceId: 'source-1',
			decoded: {
				...decodedInitialLock,
				state: SmartContractState.ResultSubmitted,
				resultHash: 'result-hash',
				sellerCooldownTime: 1_655_769_702_000n,
			},
			newOnChainState: OnChainState.ResultSubmitted,
			outputAmounts: [{ unit: 'lovelace', quantity: '10000000' }],
			outputReference: { txHash: 'result-tx', outputIndex: 1 },
			transactionEvidence: makeEvidence({
				txHash: 'result-tx',
				outputIndex: 1,
				inputs: [{ txHash: 'lock-tx', outputIndex: 0, bodyIndex: 0 }],
				signerVkeys: ['seller-vkey'],
			}),
			confirmationTimeMs: 60,
			targetSide: 'payment',
		});

		expect(outcome).toBe('applied');
		expect(mockTransactionUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: intendedOnlyTransaction.id },
				data: expect.objectContaining({
					txHash: 'result-tx',
					intendedTxHash: 'result-tx',
					status: TransactionStatus.Confirmed,
				}),
			}),
		);
		expect(mockPaymentUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					currentHydraUtxoTxHash: 'result-tx',
					currentHydraUtxoOutputIndex: 1,
					onChainState: OnChainState.ResultSubmitted,
				}),
			}),
		);
	});

	it('rejects a continuation when the actor witnessed the body but was not body-required', async () => {
		const currentTransaction = {
			id: 'current-transaction',
			txHash: 'lock-tx',
			intendedTxHash: 'lock-tx',
			status: TransactionStatus.Confirmed,
			layer: TransactionLayer.L2,
			hydraHeadId: 'head-1',
			BlocksWallet: null,
		};
		mockPaymentFindUnique.mockResolvedValue({
			...makePaymentRequest(),
			onChainState: OnChainState.FundsLocked,
			layer: TransactionLayer.L2,
			currentHydraUtxoTxHash: 'lock-tx',
			currentHydraUtxoOutputIndex: 0,
			currentHydraUtxoValue: [{ unit: 'lovelace', quantity: '10000000' }],
			currentTransactionId: currentTransaction.id,
			CurrentTransaction: currentTransaction,
			BuyerWallet: { walletVkey: 'buyer-vkey', walletAddress: 'addr-buyer' },
		});

		const outcome = await applyDatumStateToLocalRequests({
			hydraHeadId: 'head-1',
			txId: 'result-tx',
			paymentSourceId: 'source-1',
			decoded: {
				...decodedInitialLock,
				state: SmartContractState.ResultSubmitted,
				resultHash: 'result-hash',
				sellerCooldownTime: 1_655_769_702_000n,
			},
			newOnChainState: OnChainState.ResultSubmitted,
			outputAmounts: [{ unit: 'lovelace', quantity: '10000000' }],
			outputReference: { txHash: 'result-tx', outputIndex: 0 },
			transactionEvidence: makeEvidence({
				txHash: 'result-tx',
				inputs: [{ txHash: 'lock-tx', outputIndex: 0, bodyIndex: 0 }],
				signerVkeys: ['seller-vkey'],
				requiredSignerVkeys: [],
			}),
			confirmationTimeMs: 60,
			targetSide: 'payment',
		});

		expect(outcome).toBe('retry');
		expect(mockPaymentUpdate).not.toHaveBeenCalled();
	});

	it('rejects a continuation that drops value from the exact accepted input', async () => {
		const currentTransaction = {
			id: 'current-transaction',
			txHash: 'lock-tx',
			intendedTxHash: 'lock-tx',
			status: TransactionStatus.Confirmed,
			layer: TransactionLayer.L2,
			hydraHeadId: 'head-1',
			BlocksWallet: null,
		};
		mockPaymentFindUnique.mockResolvedValue({
			...makePaymentRequest(),
			onChainState: OnChainState.FundsLocked,
			layer: TransactionLayer.L2,
			currentHydraUtxoTxHash: 'lock-tx',
			currentHydraUtxoOutputIndex: 0,
			currentHydraUtxoValue: [{ unit: 'lovelace', quantity: '12000000' }],
			currentTransactionId: currentTransaction.id,
			CurrentTransaction: currentTransaction,
			BuyerWallet: { walletVkey: 'buyer-vkey', walletAddress: 'addr-buyer' },
		});

		const outcome = await applyDatumStateToLocalRequests({
			hydraHeadId: 'head-1',
			txId: 'result-tx',
			paymentSourceId: 'source-1',
			decoded: {
				...decodedInitialLock,
				state: SmartContractState.ResultSubmitted,
				resultHash: 'result-hash',
				sellerCooldownTime: 1_655_769_702_000n,
			},
			newOnChainState: OnChainState.ResultSubmitted,
			outputAmounts: [{ unit: 'lovelace', quantity: '10000000' }],
			outputReference: { txHash: 'result-tx', outputIndex: 0 },
			transactionEvidence: makeEvidence({
				txHash: 'result-tx',
				inputs: [{ txHash: 'lock-tx', outputIndex: 0, bodyIndex: 0 }],
				signerVkeys: ['seller-vkey'],
			}),
			confirmationTimeMs: 60,
			targetSide: 'payment',
		});

		expect(outcome).toBe('retry');
		expect(mockPaymentUpdate).not.toHaveBeenCalled();
	});

	it.each([
		{
			name: 'buyer requests refund',
			oldState: OnChainState.FundsLocked,
			newState: OnChainState.RefundRequested,
			newDatumState: SmartContractState.RefundRequested,
			oldResultHash: null,
			newResultHash: null,
			actorVkey: 'buyer-vkey',
			buyerCooldownTime: 1_655_769_702_000n,
			sellerCooldownTime: 0n,
		},
		{
			name: 'seller authorizes refund',
			oldState: OnChainState.RefundRequested,
			newState: OnChainState.RefundAuthorized,
			newDatumState: SmartContractState.RefundAuthorized,
			oldResultHash: null,
			newResultHash: null,
			actorVkey: 'seller-vkey',
			buyerCooldownTime: 0n,
			sellerCooldownTime: 1_655_769_702_000n,
		},
		{
			name: 'buyer authorizes withdrawal',
			oldState: OnChainState.Disputed,
			newState: OnChainState.WithdrawAuthorized,
			newDatumState: SmartContractState.WithdrawAuthorized,
			oldResultHash: 'result-hash',
			newResultHash: 'result-hash',
			actorVkey: 'buyer-vkey',
			buyerCooldownTime: 1_655_769_702_000n,
			sellerCooldownTime: 0n,
		},
	])('accepts $name only with the inferred body-bound actor', async (testCase) => {
		const currentTransaction = {
			id: 'current-transaction',
			txHash: 'current-tx',
			intendedTxHash: 'current-tx',
			status: TransactionStatus.Confirmed,
			layer: TransactionLayer.L2,
			hydraHeadId: 'head-1',
			BlocksWallet: null,
		};
		mockPaymentFindUnique.mockResolvedValue({
			...makePaymentRequest(),
			onChainState: testCase.oldState,
			resultHash: testCase.oldResultHash,
			layer: TransactionLayer.L2,
			currentHydraUtxoTxHash: 'current-tx',
			currentHydraUtxoOutputIndex: 0,
			currentHydraUtxoValue: [{ unit: 'lovelace', quantity: '10000000' }],
			currentTransactionId: currentTransaction.id,
			CurrentTransaction: currentTransaction,
			BuyerWallet: { walletVkey: 'buyer-vkey', walletAddress: 'addr-buyer' },
		});

		const outcome = await applyDatumStateToLocalRequests({
			hydraHeadId: 'head-1',
			txId: 'continuation-tx',
			paymentSourceId: 'source-1',
			decoded: {
				...decodedInitialLock,
				state: testCase.newDatumState,
				resultHash: testCase.newResultHash,
				buyerCooldownTime: testCase.buyerCooldownTime,
				sellerCooldownTime: testCase.sellerCooldownTime,
			},
			newOnChainState: testCase.newState,
			outputAmounts: [{ unit: 'lovelace', quantity: '10000000' }],
			outputReference: { txHash: 'continuation-tx', outputIndex: 0 },
			transactionEvidence: makeEvidence({
				txHash: 'continuation-tx',
				inputs: [{ txHash: 'current-tx', outputIndex: 0, bodyIndex: 0 }],
				signerVkeys: [testCase.actorVkey],
			}),
			confirmationTimeMs: 60,
			targetSide: 'payment',
		});

		expect(outcome).toBe('applied');
		expect(mockPaymentUpdate).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ onChainState: testCase.newState }) }),
		);
	});

	it('keeps an intended-only continuation pending when CBOR spends a sibling output', async () => {
		const intendedOnlyTransaction = {
			id: 'intended-only-transaction',
			txHash: null,
			intendedTxHash: 'result-tx',
			status: TransactionStatus.Pending,
			layer: TransactionLayer.L2,
			hydraHeadId: 'head-1',
			BlocksWallet: null,
		};
		mockPaymentFindUnique.mockResolvedValue({
			...makePaymentRequest(),
			onChainState: OnChainState.FundsLocked,
			layer: TransactionLayer.L2,
			currentHydraUtxoTxHash: 'lock-tx',
			currentHydraUtxoOutputIndex: 0,
			currentHydraUtxoValue: [{ unit: 'lovelace', quantity: '10000000' }],
			currentTransactionId: intendedOnlyTransaction.id,
			CurrentTransaction: intendedOnlyTransaction,
			BuyerWallet: { walletVkey: 'buyer-vkey', walletAddress: 'addr-buyer' },
			NextAction: { requestedAction: PaymentAction.SubmitResultInitiated },
		});

		const outcome = await applyDatumStateToLocalRequests({
			hydraHeadId: 'head-1',
			txId: 'result-tx',
			paymentSourceId: 'source-1',
			decoded: {
				...decodedInitialLock,
				state: SmartContractState.ResultSubmitted,
				resultHash: 'result-hash',
				sellerCooldownTime: 1_655_769_702_000n,
			},
			newOnChainState: OnChainState.ResultSubmitted,
			outputAmounts: [{ unit: 'lovelace', quantity: '10000000' }],
			outputReference: { txHash: 'result-tx', outputIndex: 1 },
			transactionEvidence: makeEvidence({
				txHash: 'result-tx',
				outputIndex: 1,
				inputs: [{ txHash: 'lock-tx', outputIndex: 1, bodyIndex: 0 }],
				signerVkeys: ['seller-vkey'],
			}),
			confirmationTimeMs: 60,
			targetSide: 'payment',
		});

		expect(outcome).toBe('retry');
		expect(mockTransactionUpdate).not.toHaveBeenCalled();
		expect(mockPaymentUpdate).not.toHaveBeenCalled();
	});

	it('ignores a sibling output when no exact persisted UTxO is spent', async () => {
		mockPaymentFindMany.mockResolvedValue([
			{
				...makePaymentRequest(),
				onChainState: OnChainState.ResultSubmitted,
				resultHash: 'result-hash',
				layer: TransactionLayer.L2,
				currentHydraUtxoTxHash: 'tracked-output-tx',
				currentHydraUtxoOutputIndex: 0,
				currentTransactionId: 'pending-terminal-tx-id',
				CurrentTransaction: {
					id: 'pending-terminal-tx-id',
					txHash: 'pending-terminal-tx',
					status: TransactionStatus.Pending,
					layer: TransactionLayer.L2,
					hydraHeadId: 'head-1',
					BlocksWallet: null,
				},
				BuyerWallet: { walletVkey: 'buyer-vkey', walletAddress: 'addr-buyer' },
			},
		]);

		const outcome = await applyTerminalHydraSpends({
			hydraHeadId: 'head-1',
			txId: 'pending-terminal-tx',
			paymentSourceId: 'source-1',
			transactionEvidence: makeEvidence({
				txHash: 'pending-terminal-tx',
				inputs: [{ txHash: 'tracked-output-tx', outputIndex: 1, bodyIndex: 0 }],
				spends: [{ txHash: 'tracked-output-tx', outputIndex: 1, bodyIndex: 0, redeemerVersion: 0 }],
				includeOutput: false,
			}),
		});

		expect(outcome).toBe('irrelevant');
		expect(mockPaymentUpdate).not.toHaveBeenCalled();
		expect(mockTransactionUpdate).not.toHaveBeenCalled();
	});

	it('ignores malformed script-address dust while applying an independently proven terminal spend', async () => {
		const inputTxHash = 'aa'.repeat(32);
		mockPaymentFindMany.mockResolvedValue([
			makeTerminalPaymentRequest({
				onChainState: OnChainState.ResultSubmitted,
				resultHash: 'result-hash',
				inputTxHash,
			}),
		]);

		const outcome = await applyTerminalHydraSpends({
			hydraHeadId: 'head-1',
			txId: 'pending-terminal-tx',
			paymentSourceId: 'source-1',
			transactionEvidence: makeEvidence({
				txHash: 'pending-terminal-tx',
				inputs: [{ txHash: inputTxHash, outputIndex: 0, bodyIndex: 0 }],
				signerVkeys: ['seller-vkey'],
				validityLowerSlot: 87_000n,
				validityUpperSlot: 87_001n,
				outputs: [
					{
						outputIndex: 0,
						address: 'addr-contract',
						amount: [{ unit: 'lovelace', quantity: '1000000' }],
						plutusData: null,
					},
				],
			}),
		});

		expect(outcome).toBe('applied');
		expect(mockPaymentUpdate).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ onChainState: OnChainState.Withdrawn }) }),
		);
	});

	it('treats malformed script-address dust with no local input candidate as irrelevant', async () => {
		const outcome = await applyTerminalHydraSpends({
			hydraHeadId: 'head-1',
			txId: 'dust-tx',
			paymentSourceId: 'source-1',
			transactionEvidence: makeEvidence({
				txHash: 'dust-tx',
				inputs: [{ txHash: 'untracked-wallet-input', outputIndex: 0, bodyIndex: 0 }],
				outputs: [
					{
						outputIndex: 0,
						address: 'addr-contract',
						amount: [{ unit: 'lovelace', quantity: '1000000' }],
						plutusData: 'not-cbor',
					},
				],
			}),
		});

		expect(outcome).toBe('irrelevant');
		expect(mockPaymentUpdate).not.toHaveBeenCalled();
		expect(mockTransactionUpdate).not.toHaveBeenCalled();
	});

	it('applies an exact terminal spend and clears the persisted Hydra output reference', async () => {
		const inputTxHash = 'ab'.repeat(32);
		mockPaymentFindMany.mockResolvedValue([
			makeTerminalPaymentRequest({
				onChainState: OnChainState.ResultSubmitted,
				resultHash: 'result-hash',
				inputTxHash,
			}),
		]);

		const outcome = await applyTerminalHydraSpends({
			hydraHeadId: 'head-1',
			txId: 'pending-terminal-tx',
			paymentSourceId: 'source-1',
			transactionEvidence: makeEvidence({
				txHash: 'pending-terminal-tx',
				inputs: [{ txHash: inputTxHash, outputIndex: 0, bodyIndex: 0 }],
				spends: [{ txHash: inputTxHash, outputIndex: 0, bodyIndex: 0, redeemerVersion: 0 }],
				signerVkeys: ['seller-vkey'],
				validityLowerSlot: 87_000n,
				validityUpperSlot: 87_001n,
				includeOutput: false,
			}),
		});

		expect(outcome).toBe('applied');
		expect(mockPaymentUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					currentHydraUtxoTxHash: null,
					currentHydraUtxoOutputIndex: null,
					onChainState: OnChainState.Withdrawn,
				}),
			}),
		);
	});

	it('rejects a terminal spend when the actor witness is not committed as a required signer', async () => {
		const inputTxHash = 'ac'.repeat(32);
		mockPaymentFindMany.mockResolvedValue([
			makeTerminalPaymentRequest({
				onChainState: OnChainState.ResultSubmitted,
				resultHash: 'result-hash',
				inputTxHash,
			}),
		]);

		const outcome = await applyTerminalHydraSpends({
			hydraHeadId: 'head-1',
			txId: 'pending-terminal-tx',
			paymentSourceId: 'source-1',
			transactionEvidence: makeEvidence({
				txHash: 'pending-terminal-tx',
				inputs: [{ txHash: inputTxHash, outputIndex: 0, bodyIndex: 0 }],
				signerVkeys: ['seller-vkey'],
				requiredSignerVkeys: [],
				validityLowerSlot: 87_000n,
				validityUpperSlot: 87_001n,
				includeOutput: false,
			}),
		});

		expect(outcome).toBe('retry');
		expect(mockPaymentUpdate).not.toHaveBeenCalled();
	});

	it('infers a buyer refund from prior state and body-bound buyer consent, not the redeemer', async () => {
		const inputTxHash = 'ad'.repeat(32);
		mockPaymentFindMany.mockResolvedValue([
			makeTerminalPaymentRequest({
				onChainState: OnChainState.RefundAuthorized,
				resultHash: null,
				inputTxHash,
			}),
		]);

		const outcome = await applyTerminalHydraSpends({
			hydraHeadId: 'head-1',
			txId: 'pending-terminal-tx',
			paymentSourceId: 'source-1',
			transactionEvidence: makeEvidence({
				txHash: 'pending-terminal-tx',
				inputs: [{ txHash: inputTxHash, outputIndex: 0, bodyIndex: 0 }],
				// Deliberately claims Withdraw. Redeemer bytes are not authoritative.
				spends: [{ txHash: inputTxHash, outputIndex: 0, bodyIndex: 0, redeemerVersion: 0 }],
				signerVkeys: ['buyer-vkey'],
				includeOutput: false,
			}),
		});

		expect(outcome).toBe('applied');
		expect(mockPaymentUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ onChainState: OnChainState.RefundWithdrawn }),
			}),
		);
	});

	it('enforces own-ref-tagged terminal payouts when return addresses are pinned', async () => {
		const inputTxHash = 'ae'.repeat(32);
		const referenceDatum = Data.to(new Constr(0, [inputTxHash, 0n]));
		mockPaymentFindMany.mockResolvedValue([
			makeTerminalPaymentRequest({
				onChainState: OnChainState.ResultSubmitted,
				resultHash: 'result-hash',
				inputTxHash,
				buyerReturnAddress: 'addr-buyer-return',
				sellerReturnAddress: 'addr-seller-return',
				collateralReturnLovelace: 1_000_000n,
			}),
		]);

		const evidenceBase = {
			txHash: 'pending-terminal-tx',
			inputs: [{ txHash: inputTxHash, outputIndex: 0, bodyIndex: 0 }],
			signerVkeys: ['seller-vkey'],
			validityLowerSlot: 87_000n,
			validityUpperSlot: 87_001n,
		};
		const missingSellerPayout = await applyTerminalHydraSpends({
			hydraHeadId: 'head-1',
			txId: 'pending-terminal-tx',
			paymentSourceId: 'source-1',
			transactionEvidence: makeEvidence({
				...evidenceBase,
				outputs: [
					{
						outputIndex: 0,
						address: 'addr-buyer-return',
						amount: [{ unit: 'lovelace', quantity: '1000000' }],
						plutusData: referenceDatum,
					},
				],
			}),
		});

		expect(missingSellerPayout).toBe('retry');
		expect(mockPaymentUpdate).not.toHaveBeenCalled();
		jest.clearAllMocks();
		mockHydraHeadFindUnique.mockResolvedValue({
			HydraRelation: {
				LocalHotWallet: {
					walletVkey: decodedInitialLock.sellerVkey,
					walletAddress: decodedInitialLock.sellerAddress,
					paymentSourceId: 'source-1',
					PaymentSource: {
						id: 'source-1',
						network: Network.Preprod,
						smartContractAddress: 'addr-contract',
						cooldownTime: 0,
					},
				},
				RemoteWallet: {
					walletVkey: decodedInitialLock.buyerVkey,
					walletAddress: decodedInitialLock.buyerAddress,
					paymentSourceId: 'source-1',
				},
			},
		});
		mockPaymentFindMany.mockResolvedValue([
			makeTerminalPaymentRequest({
				onChainState: OnChainState.ResultSubmitted,
				resultHash: 'result-hash',
				inputTxHash,
				buyerReturnAddress: 'addr-buyer-return',
				sellerReturnAddress: 'addr-seller-return',
				collateralReturnLovelace: 1_000_000n,
			}),
		]);
		mockTransactionFindFirst.mockResolvedValue(null);
		mockTransactionCreate.mockResolvedValue({ id: 'observed-transaction-1' });

		const completePayout = await applyTerminalHydraSpends({
			hydraHeadId: 'head-1',
			txId: 'pending-terminal-tx',
			paymentSourceId: 'source-1',
			transactionEvidence: makeEvidence({
				...evidenceBase,
				outputs: [
					{
						outputIndex: 0,
						address: 'addr-buyer-return',
						amount: [{ unit: 'lovelace', quantity: '1000000' }],
						plutusData: referenceDatum,
					},
					{
						outputIndex: 1,
						address: 'addr-seller-return',
						amount: [{ unit: 'lovelace', quantity: '10000000' }],
						plutusData: referenceDatum,
					},
				],
			}),
		});

		expect(completePayout).toBe('applied');
	});

	it('requires a pinned refund payout to cover token-only escrow min-ADA exactly', async () => {
		const inputTxHash = 'b0'.repeat(32);
		const referenceDatum = Data.to(new Constr(0, [inputTxHash, 0n]));
		mockPaymentFindMany.mockResolvedValue([
			{
				...makeTerminalPaymentRequest({
					onChainState: OnChainState.RefundAuthorized,
					resultHash: null,
					inputTxHash,
					buyerReturnAddress: 'addr-buyer-return',
					currentHydraUtxoValue: [
						{ unit: 'lovelace', quantity: '2000000' },
						{ unit: 'aabb', quantity: '5' },
					],
				}),
				RequestedFunds: [{ unit: 'aabb', amount: 5n }],
			},
		]);

		const outcome = await applyTerminalHydraSpends({
			hydraHeadId: 'head-1',
			txId: 'pending-terminal-tx',
			paymentSourceId: 'source-1',
			transactionEvidence: makeEvidence({
				txHash: 'pending-terminal-tx',
				inputs: [{ txHash: inputTxHash, outputIndex: 0, bodyIndex: 0 }],
				signerVkeys: ['buyer-vkey'],
				outputs: [
					{
						outputIndex: 0,
						address: 'addr-buyer-return',
						amount: [
							{ unit: 'lovelace', quantity: '1000000' },
							{ unit: 'aabb', quantity: '5' },
						],
						plutusData: referenceDatum,
					},
				],
			}),
		});

		expect(outcome).toBe('retry');
		expect(mockPaymentUpdate).not.toHaveBeenCalled();
	});

	it('records an unresolved disputed admin settlement and advances replay without changing money state', async () => {
		const inputTxHash = 'af'.repeat(32);
		const terminalTxHash = 'b1'.repeat(32);
		mockPaymentFindMany.mockResolvedValue([
			makeTerminalPaymentRequest({
				onChainState: OnChainState.Disputed,
				resultHash: 'result-hash',
				inputTxHash,
				terminalTxHash,
			}),
		]);

		const outcome = await applyTerminalHydraSpends({
			hydraHeadId: 'head-1',
			txId: terminalTxHash,
			paymentSourceId: 'source-1',
			transactionEvidence: makeEvidence({
				txHash: terminalTxHash,
				inputs: [{ txHash: inputTxHash, outputIndex: 0, bodyIndex: 0 }],
				spends: [{ txHash: inputTxHash, outputIndex: 0, bodyIndex: 0, redeemerVersion: 4 }],
				validityLowerSlot: 87_100n,
				validityUpperSlot: 87_101n,
				includeOutput: false,
			}),
		});

		expect(outcome).toBe('applied');
		expect(mockPaymentUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: 'payment-1' },
				data: expect.objectContaining({
					unresolvedHydraTerminalTxHash: terminalTxHash,
					unresolvedHydraTerminalReason: 'cip8_redeemer_not_snapshot_bound',
					ActionHistory: { connect: { id: 'action-1' } },
					NextAction: {
						create: expect.objectContaining({
							requestedAction: PaymentAction.None,
							errorNote: expect.stringContaining('manual reconciliation is required'),
						}),
					},
				}),
			}),
		);
		const unresolvedUpdate = mockPaymentUpdate.mock.calls[0]?.[0] as { data?: Record<string, unknown> };
		expect(unresolvedUpdate.data).not.toHaveProperty('onChainState');
		expect(unresolvedUpdate.data).not.toHaveProperty('currentHydraUtxoTxHash');
		expect(unresolvedUpdate.data).not.toHaveProperty('currentHydraUtxoValue');
		expect(mockTransactionUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: TransactionStatus.Confirmed,
					previousOnChainState: OnChainState.Disputed,
					newOnChainState: OnChainState.Disputed,
				}),
			}),
		);
	});

	it('rolls back a conflicting pending action and releases its wallet after an unresolved disputed spend', async () => {
		const inputTxHash = 'b2'.repeat(32);
		const terminalTxHash = 'b3'.repeat(32);
		const conflictingTransaction = {
			id: 'conflicting-pending-tx',
			txHash: 'b4'.repeat(32),
			intendedTxHash: 'b4'.repeat(32),
			status: TransactionStatus.Pending,
			layer: TransactionLayer.L2,
			hydraHeadId: 'head-1',
			BlocksWallet: { id: 'blocked-wallet' },
		};
		mockPaymentFindMany.mockResolvedValue([
			{
				...makeTerminalPaymentRequest({
					onChainState: OnChainState.Disputed,
					resultHash: 'result-hash',
					inputTxHash,
					terminalTxHash,
				}),
				currentTransactionId: conflictingTransaction.id,
				CurrentTransaction: conflictingTransaction,
			},
		]);

		const outcome = await applyTerminalHydraSpends({
			hydraHeadId: 'head-1',
			txId: terminalTxHash,
			paymentSourceId: 'source-1',
			transactionEvidence: makeEvidence({
				txHash: terminalTxHash,
				inputs: [{ txHash: inputTxHash, outputIndex: 0, bodyIndex: 0 }],
				spends: [{ txHash: inputTxHash, outputIndex: 0, bodyIndex: 0, redeemerVersion: 4 }],
				validityLowerSlot: 87_100n,
				validityUpperSlot: 87_101n,
				includeOutput: false,
			}),
		});

		expect(outcome).toBe('applied');
		expect(mockTransactionUpdate).toHaveBeenCalledWith({
			where: { id: conflictingTransaction.id },
			data: { status: TransactionStatus.RolledBack },
		});
		expect(mockHotWalletUpdate).toHaveBeenCalledWith({
			where: { id: 'blocked-wallet', deletedAt: null },
			data: { lockedAt: null },
		});
		expect(mockPaymentUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					TransactionHistory: { connect: { id: conflictingTransaction.id } },
					CurrentTransaction: { connect: { id: 'observed-transaction-1' } },
					NextAction: {
						create: expect.objectContaining({ requestedAction: PaymentAction.None }),
					},
				}),
			}),
		);
	});
});
