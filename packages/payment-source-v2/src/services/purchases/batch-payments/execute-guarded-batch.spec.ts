import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PurchaseErrorType, PurchasingAction } from '@/generated/prisma/client';

type AsyncFn = (...args: never[]) => Promise<object | string>;
const mockPurchaseUpdate = jest.fn<(args: { where: { id: string }; data: unknown }) => Promise<unknown>>();
const mockBuild = jest.fn<AsyncFn>();
const mockRequestCosign = jest.fn<AsyncFn>();
const mockMerge = jest.fn<(tx: string, expected: unknown, witnessSetHex: string) => string>();
const mockPresubmit = jest.fn<AsyncFn>();
const mockSubmit = jest.fn<(params: unknown) => Promise<object>>();
const mockSignTx = jest.fn<(tx: string) => Promise<string>>();
const config = {
	EXCHAIN_COSIGN_URL: 'https://cosign.example' as string | null,
	EXCHAIN_NODE_TOKEN: 'token' as string | null,
	EXCHAIN_NODE_ID: 'node',
	EXCHAIN_ORG_ID: 'org',
};

class MockTransportError extends Error {}
class MockContinuingTooSmallError extends Error {}

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { purchaseRequest: { update: mockPurchaseUpdate } },
}));
jest.unstable_mockModule('@masumi/payment-core/config', () => ({ CONFIG: config }));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('@meshsdk/core', () => ({
	BlockfrostProvider: class {},
	MeshWallet: class {
		getUtxos = () => Promise.resolve([]);
		signTx = mockSignTx;
	},
	resolveTxHash: (tx: string) => (tx.startsWith('signed:') ? tx.slice('signed:'.length) : tx),
}));
jest.unstable_mockModule('@/utils/security/encryption', () => ({ decrypt: () => 'word '.repeat(24).trim() }));
jest.unstable_mockModule('@/utils/mesh-cost-model-sync', () => ({
	withMeshCostModelLock: (_key: string, run: () => unknown) => run(),
}));
jest.unstable_mockModule('../../../smart-wallet/wallet-lifecycle', () => ({
	loadSmartWalletScript: () => ({ address: 'addr_script', policyId: 'policy', scriptCode: 'code' }),
	fetchWalletUtxo: () => Promise.resolve({ input: { txHash: 'c'.repeat(64), outputIndex: 0 }, output: {} }),
	readWalletDatum: () => ({}),
}));
jest.unstable_mockModule('../../../smart-wallet/guarded-lock-builder', () => ({
	buildGuardedLockTx: mockBuild,
	GuardedTxTooLargeError: class extends Error {},
	GuardedContinuingOutputTooSmallError: MockContinuingTooSmallError,
}));
jest.unstable_mockModule('../../../smart-wallet/cosign-client', () => ({
	CosignTransportError: MockTransportError,
	jobHashOf: (inputHash: string) => `job:${inputHash}`,
	mergeCosignWitnesses: mockMerge,
	requestCosign: mockRequestCosign,
}));
jest.unstable_mockModule('./execute-batch', () => ({
	batchLockDatum: () => ({ value: 'datum' }),
	recordBatchPresubmit: mockPresubmit,
	submitBatchTx: mockSubmit,
}));

const { executeGuardedBatch } = await import('./execute-guarded-batch');

function request(id: string) {
	return {
		overpaidLovelace: 0n,
		paymentRequest: {
			id,
			nextActionId: `action-${id}`,
			payByTime: 10_000n,
			inputHash: `input-${id}`,
			agentIdentifier: `agent-${id}`,
			blockchainIdentifier: 'bid',
			PaidFunds: [{ unit: '', amount: 6_000_000n }],
			SellerWallet: { walletVkey: 'd'.repeat(56) },
		},
	};
}

function pairing(ids: string[]) {
	return {
		walletId: 'wallet-1',
		scriptAddress: 'addr_escrow',
		changeAddress: 'addr_agent',
		placeholderTransactionId: 'placeholder-1',
		batchedRequests: ids.map(request),
		guarded: {
			ownerAddress: 'addr_owner',
			quorumVkhs: ['q1', 'q2', 'q3'],
			threshold: 2,
			stateTokenName: 'token',
			scriptAddress: 'addr_script',
			policyId: 'policy',
		},
	};
}

const paymentContract = {
	network: 'Preprod',
	PaymentSourceConfig: { rpcProviderApiKey: 'preprodKey' },
	HotWallets: [{ id: 'wallet-1', Secret: { encryptedMnemonic: 'enc' } }],
};

function built(txHash: string, count: number) {
	return {
		unsignedTx: txHash,
		txHash,
		lockOutputIndexes: Array.from({ length: count }, (_, i) => i + 1),
		validity: { invalidAfter: 500 },
	};
}

// The executor only reads the fields the fixtures above carry.
const run = (walletPairing: ReturnType<typeof pairing>) =>
	executeGuardedBatch(walletPairing as never, paymentContract as never);

function nextActionOf(purchaseId: string) {
	const call = mockPurchaseUpdate.mock.calls.find(([args]) => args.where.id === purchaseId);
	return (call?.[0].data as { NextAction: { create: Record<string, unknown> } } | undefined)?.NextAction.create;
}

beforeEach(() => {
	jest.clearAllMocks();
	config.EXCHAIN_COSIGN_URL = 'https://cosign.example';
	mockPurchaseUpdate.mockResolvedValue({});
	mockBuild.mockResolvedValue(built('tx1', 2));
	mockMerge.mockImplementation((tx) => `merged:${tx}`);
	mockSignTx.mockImplementation((tx) => Promise.resolve(`signed:${tx.slice('merged:'.length)}`));
	mockPresubmit.mockResolvedValue('shared-1');
	mockSubmit.mockResolvedValue({ status: 'succeeded' });
});

describe('executeGuardedBatch', () => {
	it('submits the quorum-signed transaction through the shared submit step', async () => {
		mockRequestCosign.mockResolvedValue({ httpStatus: 200, approved: { witnessSetHex: 'ws' } });
		await run(pairing(['p1', 'p2']));

		expect(mockMerge).toHaveBeenCalledWith('tx1', { txHash: 'tx1', signerVkhs: ['q1', 'q2'] }, 'ws');
		expect(mockPresubmit).toHaveBeenCalledTimes(1);
		expect(mockSubmit).toHaveBeenCalledWith(
			expect.objectContaining({ sharedTxId: 'shared-1', signedTx: 'signed:tx1', requestIds: ['p1', 'p2'] }),
		);
		expect(mockPurchaseUpdate).not.toHaveBeenCalled();
	});

	it('never submits a denied batch and parks each purchase as a policy denial', async () => {
		mockRequestCosign.mockResolvedValue({
			httpStatus: 409,
			denied: {
				denied: 'payee_unpinned',
				reasonEnglish: 'seller not pinned',
				journalRef: 'jr_9',
				members: [],
				alarm: false,
			},
		});
		const outcome = await run(pairing(['p1', 'p2']));

		expect(outcome).toEqual({
			status: 'cosign-refused',
			walletId: 'wallet-1',
			sharedTxId: 'placeholder-1',
			requestIds: ['p1', 'p2'],
		});
		expect(mockPresubmit).not.toHaveBeenCalled();
		expect(mockSubmit).not.toHaveBeenCalled();
		expect(nextActionOf('p1')).toEqual({
			requestedAction: PurchasingAction.WaitingForManualAction,
			errorType: PurchaseErrorType.PolicyDenied,
			errorNote: 'Exchain payee_unpinned: seller not pinned (journal jr_9)',
		});
	});

	it('keeps purchases queued, without an error type, when Exchain is unreachable', async () => {
		mockRequestCosign.mockRejectedValue(new MockTransportError('timeout'));
		await run(pairing(['p1']));

		expect(mockSubmit).not.toHaveBeenCalled();
		expect(nextActionOf('p1')).toEqual(
			expect.objectContaining({ requestedAction: PurchasingAction.FundsLockingRequested, errorType: null }),
		);
	});

	it('rebuilds once with the admitted purchases and submits only those', async () => {
		mockRequestCosign
			.mockResolvedValueOnce({
				httpStatus: 409,
				denied: {
					denied: 'member_denied',
					journalRef: 'jr_2',
					alarm: false,
					members: [
						{ purchaseId: 'p1', outputIndex: 1, verdict: 'allowed' },
						{ purchaseId: 'p2', outputIndex: 2, verdict: 'denied', denied: 'per_tx_cap', reasonEnglish: 'cap' },
					],
					rebuild: { keep: ['p1'], batchId: 'b', heldUntil: new Date(Date.now() + 60_000).toISOString() },
				},
			})
			.mockResolvedValueOnce({ httpStatus: 200, approved: { witnessSetHex: 'ws' } });
		mockBuild.mockResolvedValueOnce(built('tx1', 2)).mockResolvedValueOnce(built('tx2', 1));

		await run(pairing(['p1', 'p2']));

		expect(mockBuild).toHaveBeenCalledTimes(2);
		expect(mockSubmit).toHaveBeenCalledWith(expect.objectContaining({ signedTx: 'signed:tx2', requestIds: ['p1'] }));
		expect(nextActionOf('p2')).toEqual(expect.objectContaining({ errorType: PurchaseErrorType.PolicyDenied }));
		const [firstCall, secondCall] = mockRequestCosign.mock.calls as unknown as Array<[unknown, { batchId: string }]>;
		expect(secondCall[1].batchId).toBe(firstCall[1].batchId);
	});

	it('drops the last purchase when the batch would leave the wallet below min-UTxO', async () => {
		mockBuild
			.mockRejectedValueOnce(new MockContinuingTooSmallError('too small'))
			.mockResolvedValueOnce(built('tx1', 1));
		mockRequestCosign.mockResolvedValue({ httpStatus: 200, approved: { witnessSetHex: 'ws' } });
		await run(pairing(['p1', 'p2']));

		expect(mockRequestCosign).toHaveBeenCalledTimes(1);
		expect(mockSubmit).toHaveBeenCalledWith(expect.objectContaining({ requestIds: ['p1'] }));
		expect(nextActionOf('p2')).toEqual(
			expect.objectContaining({ requestedAction: PurchasingAction.FundsLockingRequested, errorType: null }),
		);
	});

	it('does not build when co-signing is not configured', async () => {
		config.EXCHAIN_COSIGN_URL = null;
		const outcome = await run(pairing(['p1']));

		expect(outcome.status).toBe('cosign-refused');
		expect(mockBuild).not.toHaveBeenCalled();
		expect(nextActionOf('p1')).toEqual(
			expect.objectContaining({ requestedAction: PurchasingAction.FundsLockingRequested, errorType: null }),
		);
	});
});
