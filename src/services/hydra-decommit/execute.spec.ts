import { beforeEach, describe, expect, it, jest } from '@jest/globals';

type AnyMock = jest.Mock<(...args: any[]) => any>;

const mockDecommitUpdateMany = jest.fn() as AnyMock;
const mockDecommitUpdate = jest.fn() as AnyMock;
const mockDecommitCreate = jest.fn() as AnyMock;
const mockDecommitFindFirst = jest.fn() as AnyMock;
const mockHeadFindUnique = jest.fn() as AnyMock;
const mockHeadUpdate = jest.fn() as AnyMock;
const mockDecommitCall = jest.fn() as AnyMock;
const mockFetchAddressUTxOs = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraHead: { findUnique: mockHeadFindUnique, update: mockHeadUpdate },
		hydraDecommit: {
			findFirst: mockDecommitFindFirst,
			create: mockDecommitCreate,
			update: mockDecommitUpdate,
			updateMany: mockDecommitUpdateMany,
		},
		$transaction: async (fn: any) =>
			await fn({
				hydraDecommit: {
					findFirst: mockDecommitFindFirst,
					create: mockDecommitCreate,
					updateMany: mockDecommitUpdateMany,
				},
			}),
	},
}));

jest.unstable_mockModule('@masumi/payment-core/serializable-semaphore', () => ({
	withSerializableSlotRetry: async (fn: any) => await fn(),
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('@/utils/security/encryption', () => ({
	decrypt: () => 'a '.repeat(23).trim() + ' b',
}));

jest.unstable_mockModule('@/routes/api/hydra/head', () => ({
	verifyPersistedHydraHeadOnChain: async () => ({ headIdentifier: 'ab'.repeat(28) }),
	recordHeadError: jest.fn(),
	// A withdrawal needs a node that is answering and caught up, the same as a
	// deposit does. Ready here; the refusal itself is covered where the guard lives.
	assertNodeReadyForDeposit: async () => undefined,
}));

jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({
		getHead: () => ({ decommit: mockDecommitCall, mainNode: { pendingIncrementUtxoRefs: new Set<string>() } }),
		getProvider: () => ({ fetchAddressUTxOs: mockFetchAddressUTxOs }),
	}),
}));

// Enumerated rather than spread: a mock here applies to every transitively
// loaded file, and importing the real module to spread it exhausts the worker.
// Anything the import graph reaches must therefore be listed (see ADR-0005).
jest.unstable_mockModule('@meshsdk/core', () => ({
	BlockfrostProvider: class {},
	castProtocol: (() => undefined) as unknown as never,
	POLICY_ID_LENGTH: 56,
	MeshWallet: class {
		async getUnusedAddresses() {
			return [];
		}
		async signTx() {
			return 'ff'.repeat(20);
		}
	},
	MeshTxBuilder: class {
		txIn() {
			return this;
		}
		changeAddress() {
			return this;
		}
		setNetwork() {
			return this;
		}
		async complete() {
			return 'ee'.repeat(20);
		}
	},
	resolveTxHash: () => 'cd'.repeat(32),
	deserializeDatum: () => ({}),
	resolvePaymentKeyHash: () => 'aa'.repeat(28),
	resolveSlotNo: () => '0',
	Transaction: class {},
}));

const { HydraTransportAmbiguousError } = await import('@/lib/hydra/hydra/errors');
const { executeHydraDecommit } = await import('./execute');

const HEAD = {
	id: 'head-1',
	isEnabled: true,
	status: 'Open',
	headIdentifier: 'ab'.repeat(28),
	LocalParticipant: {
		id: 'participant-1',
		walletId: 'wallet-1',
		Wallet: {
			walletAddress: 'addr_test1_local',
			Secret: { encryptedMnemonic: 'encrypted' },
			PaymentSource: { network: 'Preprod' },
		},
	},
};

beforeEach(() => {
	jest.clearAllMocks();
	mockHeadFindUnique.mockResolvedValue(HEAD);
	mockDecommitFindFirst.mockResolvedValue(null);
	mockDecommitCreate.mockResolvedValue({ id: 'decommit-1' });
	mockDecommitUpdate.mockResolvedValue({});
	mockDecommitUpdateMany.mockResolvedValue({ count: 1 });
	mockHeadUpdate.mockResolvedValue({});
	mockFetchAddressUTxOs.mockResolvedValue([
		{
			input: { txHash: 'a'.repeat(64), outputIndex: 0 },
			output: { address: 'addr_test1_local', amount: [{ unit: 'lovelace', quantity: '20000000' }] },
		},
		{
			input: { txHash: 'b'.repeat(64), outputIndex: 0 },
			output: { address: 'addr_test1_local', amount: [{ unit: 'lovelace', quantity: '6000000' }] },
		},
	]);
});

describe('executeHydraDecommit request outcomes', () => {
	// Only an answer from the node proves it never took the request.
	it('marks the withdrawal Failed when the node answers with a rejection', async () => {
		mockDecommitCall.mockRejectedValue(new Error('DecommitInvalid: nope'));

		await expect(executeHydraDecommit({ headId: 'head-1' })).rejects.toThrow('rejected the withdrawal');

		expect(mockDecommitUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: 'Failed' }) }),
		);
	});

	/**
	 * The bug this exists to prevent: a timeout or a 5xx proves nothing about
	 * whether the node took the decommit. It may be proposing it to the head right
	 * now, and the head may approve it seconds later. Marking such a withdrawal
	 * Failed tells an operator "nothing left the head, safe to try again" while
	 * the funds are on their way out.
	 */
	it('leaves an ambiguous request Pending for the head to settle', async () => {
		mockDecommitCall.mockRejectedValue(new HydraTransportAmbiguousError('POST outcome is ambiguous'));

		await expect(executeHydraDecommit({ headId: 'head-1' })).rejects.toThrow('stays pending');

		// Nothing was written to Failed — not by this path, and not by the outer
		// handler either, which only owns rows still in Preparing.
		expect(mockDecommitUpdateMany.mock.calls.filter((call) => call[0]?.data?.status === 'Failed')).toHaveLength(0);
	});
});
