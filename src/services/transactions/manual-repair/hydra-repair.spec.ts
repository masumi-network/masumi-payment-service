import { jest } from '@jest/globals';
import {
	HydraHeadStatus,
	OnChainState,
	PurchasingAction,
	TransactionLayer,
	TransactionStatus,
} from '@/generated/prisma/client';

const updatedAt = new Date('2026-09-15T14:21:46Z');
const txHash = 'a'.repeat(64);
const makeRequest = () => ({
	id: 'request',
	paymentSourceId: 'source',
	updatedAt,
	nextActionId: 'old-action',
	onChainState: OnChainState.FundsOrDatumInvalid as OnChainState,
	resultHash: null,
	layer: TransactionLayer.L2 as TransactionLayer,
	currentTransactionId: 'transaction',
	currentHydraUtxoTxHash: txHash,
	currentHydraUtxoOutputIndex: 0,
	unresolvedHydraTerminalTxHash: null as string | null,
	hydraFanoutHandoffHeadId: null as string | null,
	CurrentTransaction: {
		txHash,
		layer: TransactionLayer.L2 as TransactionLayer,
		hydraHeadId: 'head',
		status: TransactionStatus.Confirmed as TransactionStatus,
	},
	NextAction: { requestedAction: PurchasingAction.WaitingForManualAction as PurchasingAction },
});
let request = makeRequest();
const updatePurchase = jest.fn<(...args: any[]) => Promise<any>>();
const updatePayment = jest.fn<(...args: any[]) => Promise<any>>();
const head = jest.fn<(...args: any[]) => Promise<any>>();
const admission = jest.fn<(...args: any[]) => Promise<boolean>>();
const fresh = jest.fn<() => void>();
const makeEvidence = () => ({
	txHash,
	outputIndex: 0,
	derivedOnChainState: OnChainState.FundsLocked,
	resultHash: null,
	headId: 'head',
	buyerWallet: { walletVkey: 'buyer', walletAddress: 'buyer-address' },
	currentHydraUtxoRef: { txHash, outputIndex: 0 },
	currentTransactionId: 'transaction',
	requestUpdatedAt: updatedAt,
	ownerEpoch: 1n,
	snapshotNumber: 3n,
	latestSnapshotNumber: 3n,
	outputAmounts: [{ unit: 'lovelace', quantity: '4460850' }],
	assertFresh: fresh,
});
const validate = jest.fn<(...args: any[]) => Promise<any>>();
const createObservation = jest.fn(async () => ({ id: 'repaired-observation' }));
const updateObservation = jest.fn();
const tx = {
	transaction: { findFirst: jest.fn(async () => null), create: createObservation, update: updateObservation },
	hydraHead: { findUnique: head },
	purchaseRequest: { findUnique: jest.fn(async () => request), update: updatePurchase },
	paymentRequest: { findUnique: jest.fn(async () => request), update: updatePayment },
};
const transaction = jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx));
class Conflict extends Error {}
jest.unstable_mockModule('./index', () => ({ RepairConflictError: Conflict }));
jest.unstable_mockModule('./hydra-validation', () => ({ validateHydraRepair: validate }));
jest.unstable_mockModule('@masumi/payment-core/db', () => ({ prisma: { $transaction: transaction } }));
jest.unstable_mockModule('@masumi/payment-core/db-retry', () => ({
	retryOnSerializationConflict: async (fn: () => Promise<unknown>) => fn(),
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({ logger: { warn: jest.fn() } }));
jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-datum-guards', () => ({
	lockHydraMutationAdmission: admission,
	persistedHydraValue: (value: unknown) => value,
}));
const { repairHydraRequest } = await import('./hydra-repair');
const params = {
	kind: 'purchase' as const,
	requestId: 'request',
	txHash,
	expectedVersion: {
		updatedAt,
		currentTransactionId: 'transaction',
		onChainState: OnChainState.FundsOrDatumInvalid as OnChainState,
		resultHash: null,
	},
};

beforeEach(() => {
	jest.clearAllMocks();
	request = makeRequest();
	validate.mockResolvedValue(makeEvidence());
	admission.mockResolvedValue(true);
	head.mockResolvedValue({
		ownerEpoch: 1n,
		snapshotNumber: 3n,
		latestSnapshotNumber: 3n,
		status: HydraHeadStatus.Open,
	});
	fresh.mockReset();
});

it.each(['purchase', 'payment'] as const)(
	'repairs %s atomically and retains the original L2 transaction',
	async (kind) => {
		const result = await repairHydraRequest({ ...params, kind });
		const update = kind === 'purchase' ? updatePurchase : updatePayment;
		expect(result).toEqual({
			requestId: 'request',
			txHash,
			transactionId: 'repaired-observation',
			previousOnChainState: OnChainState.FundsOrDatumInvalid,
			newOnChainState: OnChainState.FundsLocked,
			forced: false,
		});
		expect(update).toHaveBeenCalledWith({
			where: { id: 'request', updatedAt, nextActionId: 'old-action' },
			data: {
				onChainState: OnChainState.FundsLocked,
				resultHash: null,
				currentHydraUtxoValue: makeEvidence().outputAmounts,
				ActionHistory: { connect: { id: 'old-action' } },
				TransactionHistory: { connect: [{ id: 'transaction' }, { id: 'repaired-observation' }] },
				CurrentTransaction: { connect: { id: 'repaired-observation' } },
				NextAction: { create: { requestedAction: 'WaitingForExternalAction' } },
				...(kind === 'payment'
					? {
							BuyerWallet: {
								connectOrCreate: {
									where: {
										paymentSourceId_walletVkey_walletAddress_type: {
											paymentSourceId: 'source',
											...makeEvidence().buyerWallet,
											type: 'Buyer',
										},
									},
									create: {
										...makeEvidence().buyerWallet,
										type: 'Buyer',
										PaymentSource: { connect: { id: 'source' } },
									},
								},
							},
						}
					: {}),
			},
		});
		expect(transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
		expect(fresh).toHaveBeenCalledTimes(2);
		expect(createObservation).toHaveBeenCalledWith({
			data: {
				txHash,
				status: TransactionStatus.Confirmed,
				layer: TransactionLayer.L2,
				HydraHead: { connect: { id: 'head' } },
				previousOnChainState: OnChainState.FundsOrDatumInvalid,
				newOnChainState: OnChainState.FundsLocked,
			},
			select: { id: true },
		});
		expect(updateObservation).not.toHaveBeenCalled();
	},
);

it('recovers the old unsupported locking retry without queuing another lock', async () => {
	request.NextAction.requestedAction = PurchasingAction.FundsLockingRequested;
	await expect(repairHydraRequest(params)).resolves.toMatchObject({ newOnChainState: OnChainState.FundsLocked });
});

it.each([
	[
		'version',
		() => {
			request.updatedAt = new Date(updatedAt.getTime() + 1);
		},
	],
	[
		'current transaction',
		() => {
			request.currentTransactionId = 'other';
		},
	],
	[
		'state',
		() => {
			request.onChainState = OnChainState.ResultSubmitted;
		},
	],
	[
		'layer',
		() => {
			request.layer = TransactionLayer.L1;
		},
	],
	[
		'output hash',
		() => {
			request.currentHydraUtxoTxHash = 'b'.repeat(64);
		},
	],
	[
		'output index',
		() => {
			request.currentHydraUtxoOutputIndex = 1;
		},
	],
	[
		'transaction head',
		() => {
			request.CurrentTransaction.hydraHeadId = 'other';
		},
	],
	[
		'transaction hash',
		() => {
			request.CurrentTransaction.txHash = 'b'.repeat(64);
		},
	],
	[
		'transaction layer',
		() => {
			request.CurrentTransaction.layer = TransactionLayer.L1;
		},
	],
	[
		'pending transaction',
		() => {
			request.CurrentTransaction.status = TransactionStatus.Pending;
		},
	],
	[
		'terminal spend',
		() => {
			request.unresolvedHydraTerminalTxHash = 'terminal';
		},
	],
	[
		'fanout handoff',
		() => {
			request.hydraFanoutHandoffHeadId = 'head';
		},
	],
	[
		'active action',
		() => {
			request.NextAction.requestedAction = PurchasingAction.FundsLockingInitiated;
		},
	],
] as const)('rejects changed %s without updating the request', async (_name, change) => {
	change();
	await expect(repairHydraRequest(params)).rejects.toBeInstanceOf(Conflict);
	expect(updatePurchase).not.toHaveBeenCalled();
	expect(updatePayment).not.toHaveBeenCalled();
});

it('rejects a validator snapshot newer than the preview', async () => {
	validate.mockResolvedValue({ ...makeEvidence(), requestUpdatedAt: new Date(updatedAt.getTime() + 1) });
	await expect(repairHydraRequest(params)).rejects.toBeInstanceOf(Conflict);
	expect(transaction).not.toHaveBeenCalled();
});

it.each([
	['admission revoked', () => admission.mockResolvedValue(false)],
	[
		'snapshot changed',
		() => head.mockResolvedValue({ ownerEpoch: 1n, status: HydraHeadStatus.Open, latestSnapshotNumber: 4n }),
	],
	[
		'closing',
		() =>
			head.mockResolvedValue({
				ownerEpoch: 1n,
				snapshotNumber: 3n,
				latestSnapshotNumber: 3n,
				status: HydraHeadStatus.Open,
				isClosing: true,
			}),
	],
	['owner changed', () => head.mockResolvedValue({ ownerEpoch: 2n, status: HydraHeadStatus.Open })],
	[
		'head closed',
		() =>
			head.mockResolvedValue({
				ownerEpoch: 1n,
				snapshotNumber: 3n,
				latestSnapshotNumber: 3n,
				status: HydraHeadStatus.Closed,
			}),
	],
	[
		'output spent',
		() =>
			fresh.mockImplementation(() => {
				throw new Conflict();
			}),
	],
] as const)('rejects %s before writing', async (_name, change) => {
	change();
	await expect(repairHydraRequest(params)).rejects.toBeInstanceOf(Conflict);
	expect(updatePurchase).not.toHaveBeenCalled();
});

it('aborts the transaction if evidence changes during the update', async () => {
	fresh
		.mockImplementationOnce(() => {})
		.mockImplementationOnce(() => {
			throw new Conflict();
		});
	await expect(repairHydraRequest(params)).rejects.toBeInstanceOf(Conflict);
	expect(updatePurchase).toHaveBeenCalledTimes(1);
});
