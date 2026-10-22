import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
	Network,
	OnChainState,
	PaymentAction,
	PurchasingAction,
	TransactionLayer,
	TransactionStatus,
} from '@/generated/prisma/client';
import { SmartContractState } from '@masumi/payment-core/smart-contract-state';
import { generateBlockchainIdentifier } from '@masumi/payment-core/blockchain-identifier';
import type { DecodedV1ContractDatum } from '@/utils/converter/string-datum-convert';
import type { HydraTransactionEvidence } from './hydra-transaction-evidence';

const mockPurchaseFindUnique = jest.fn<(_args: unknown) => Promise<unknown>>();
const mockPurchaseUpdate = jest.fn<(_args: unknown) => Promise<unknown>>();
const mockPaymentFindUnique = jest.fn<(_args: unknown) => Promise<unknown>>();
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
		update: mockPurchaseUpdate,
	},
	paymentRequest: {
		findUnique: mockPaymentFindUnique,
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

const { applyDatumStateToLocalRequests: applyDatumStateToLocalRequestsRaw } = await import('./hydra-datum-sync');
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

describe('initial Hydra lock after an observation timeout', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockHydraAdmissionQuery.mockResolvedValue([
			{ isEnabled: true, initTxHash: 'a'.repeat(64), reconciliationCompletedAt: null },
		]);
		mockPurchaseFindUnique.mockResolvedValue(null);
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

	function timedOutPayment() {
		return {
			...makePaymentRequest(),
			onChainState: OnChainState.FundsOrDatumInvalid,
			NextAction: {
				requestedAction: PaymentAction.WaitingForManualAction,
				errorType: 'Unknown',
				errorNote: `Payment request payByTime (${decodedInitialLock.payByTime}) passed without on-chain lock; no FundsLocked tx observed within 300s grace.`,
			},
		};
	}

	function initialObservation() {
		const txId = 'on-time-but-replayed-late';
		return {
			hydraHeadId: 'head-1',
			txId,
			paymentSourceId: 'source-1',
			decoded: decodedInitialLock,
			newOnChainState: OnChainState.FundsLocked,
			outputAmounts: [{ unit: 'lovelace', quantity: '10000000' }],
			outputReference: { txHash: txId, outputIndex: 0 },
			transactionEvidence: makeEvidence({ txHash: txId, signerVkeys: ['buyer-vkey'] }),
			confirmationTimeMs: Number(decodedInitialLock.payByTime) - 1,
		};
	}

	it.each([false, true])('accepts an on-time verified initial lock after local timeout = %s', async (didTimeout) => {
		mockPaymentFindUnique.mockResolvedValue(didTimeout ? timedOutPayment() : makePaymentRequest());
		expect(await applyDatumStateToLocalRequests(initialObservation())).toBe('applied');
		expect(mockPaymentUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					onChainState: OnChainState.FundsLocked,
					NextAction: {
						create: expect.objectContaining({
							requestedAction: PaymentAction.WaitingForExternalAction,
							errorType: null,
						}),
					},
				}),
			}),
		);
	});

	it('recovers an entirely unobserved purchase after the same local timeout', async () => {
		const request = timedOutPayment();
		mockPaymentFindUnique.mockResolvedValue(null);
		mockPurchaseFindUnique.mockResolvedValue({
			...request,
			layer: TransactionLayer.L2,
			paymentForceLayer: null,
			PaidFunds: request.RequestedFunds,
			SellerWallet: request.SmartContractWallet,
			SmartContractWallet: { walletVkey: 'buyer-vkey', walletAddress: 'addr-buyer' },
		});
		expect(await applyDatumStateToLocalRequests(initialObservation())).toBe('applied');
		expect(mockPurchaseUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					onChainState: OnChainState.FundsLocked,
					NextAction: {
						create: expect.objectContaining({
							requestedAction: PurchasingAction.WaitingForExternalAction,
							errorType: null,
						}),
					},
				}),
			}),
		);
	});

	it.each([
		['forced L1 routing', { forceLayer: TransactionLayer.L1 }],
		['a recorded transaction id', { currentTransactionId: 'observed-invalid' }],
		['a recorded current transaction', { CurrentTransaction: { id: 'observed-invalid' } }],
		['transaction history', { TransactionHistory: [{ txHash: 'observed-invalid' }] }],
		['a partial output hash', { currentHydraUtxoTxHash: 'observed-invalid' }],
		['a partial output index', { currentHydraUtxoOutputIndex: 0 }],
		['a recorded output value', { currentHydraUtxoValue: [{ unit: 'lovelace', quantity: '1' }] }],
		['a recorded terminal hash', { unresolvedHydraTerminalTxHash: 'terminal' }],
		['a recorded terminal reason', { unresolvedHydraTerminalReason: 'unverified' }],
		['a fanout handoff', { hydraFanoutHandoffHeadId: 'final-head' }],
	])('does not restore a row with %s', async (_reason, changes) => {
		mockPaymentFindUnique.mockResolvedValue({ ...timedOutPayment(), ...changes });
		expect(await applyDatumStateToLocalRequests(initialObservation())).toBe('irrelevant');
		expect(mockPaymentUpdate).not.toHaveBeenCalled();
	});

	it.each([
		['different agreed terms', { decoded: { ...decodedInitialLock, inputHash: 'different-terms' } }],
		['a missing buyer witness', { transactionEvidence: makeEvidence({ txHash: initialObservation().txId }) }],
	])('rejects a timed-out lock with %s', async (_reason, changes) => {
		mockPaymentFindUnique.mockResolvedValue(timedOutPayment());
		expect(await applyDatumStateToLocalRequests({ ...initialObservation(), ...changes })).toBe('irrelevant');
		expect(mockPaymentUpdate).not.toHaveBeenCalled();
	});

	it.each([
		['an after-deadline confirmation', { confirmationTimeMs: Number(decodedInitialLock.payByTime) + 1 }],
		['a missing confirmation time', { confirmationTimeMs: null }],
		[
			'a missing signed validity bound',
			{
				transactionEvidence: makeEvidence({
					txHash: initialObservation().txId,
					signerVkeys: ['buyer-vkey'],
					validityUpperSlot: null,
				}),
			},
		],
		[
			'an after-deadline signed validity bound',
			{
				transactionEvidence: makeEvidence({
					txHash: initialObservation().txId,
					signerVkeys: ['buyer-vkey'],
					validityUpperSlot: 86_800n,
				}),
			},
		],
	])('keeps %s parked without blocking ordered replay', async (_reason, changes) => {
		mockPaymentFindUnique.mockResolvedValue(timedOutPayment());
		expect(await applyDatumStateToLocalRequests({ ...initialObservation(), ...changes })).toBe('irrelevant');
		expect(mockPaymentUpdate).not.toHaveBeenCalled();
	});

	it('keeps an underfunded initial lock invalid after a local timeout', async () => {
		mockPaymentFindUnique.mockResolvedValue(timedOutPayment());
		const observation = initialObservation();
		observation.outputAmounts[0].quantity = '9000000';
		observation.transactionEvidence.outputs[0].amount[0].quantity = '9000000';
		expect(await applyDatumStateToLocalRequests(observation)).toBe('applied');
		expect(mockPaymentUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ onChainState: OnChainState.FundsOrDatumInvalid }),
			}),
		);
	});
});
