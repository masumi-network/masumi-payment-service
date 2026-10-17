import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

type AnyMock = jest.Mock<(...args: any[]) => any>;

const mockHeadFindUnique = jest.fn() as AnyMock;
const mockWalletUpdateMany = jest.fn() as AnyMock;
const mockDecommitFindFirst = jest.fn() as AnyMock;
const mockNewTx = jest.fn() as AnyMock;
const mockFetchPendingDecommitRefs = jest.fn() as AnyMock;
const mockFetchAddressUTxOs = jest.fn() as AnyMock;
const mockFetchProtocolParameters = jest.fn() as AnyMock;
const mockIsTxConfirmed = jest.fn() as AnyMock;
const mockTxIn = jest.fn() as AnyMock;
const mockTxOut = jest.fn() as AnyMock;

const mockAssertNotPaused = jest.fn(async () => undefined) as AnyMock;

jest.unstable_mockModule('@/services/hydra-host/pause', () => ({
	assertHydraHeadHostNotPaused: mockAssertNotPaused,
	isHydraHeadOnPausedHost: jest.fn(async () => false),
	isHydraHeadOnPausedHostLocked: jest.fn(async () => false),
	HYDRA_HOST_PAUSED_MESSAGE: 'hydra host is paused for maintenance',
}));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraHead: { findUnique: mockHeadFindUnique },
		hotWallet: { updateMany: mockWalletUpdateMany },
		hydraDecommit: { findFirst: mockDecommitFindFirst },
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('@/utils/security/encryption', () => ({
	decrypt: () => 'a '.repeat(23).trim() + ' b',
}));

jest.unstable_mockModule('@/routes/api/hydra/head', () => ({
	assertNodeReadyForDeposit: async () => undefined,
}));

jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({
		getHead: () => ({
			newTx: mockNewTx,
			mainNode: {
				pendingIncrementUtxoRefs: new Set<string>(),
				fetchPendingDecommitRefs: mockFetchPendingDecommitRefs,
				isTxConfirmed: mockIsTxConfirmed,
			},
		}),
		getProvider: () => ({
			fetchAddressUTxOs: mockFetchAddressUTxOs,
			fetchProtocolParameters: mockFetchProtocolParameters,
		}),
	}),
}));

// Enumerated rather than spread: a mock here applies to every transitively
// loaded file (see ADR-0005).
jest.unstable_mockModule('@meshsdk/core', () => ({
	BlockfrostProvider: class {},
	castProtocol: (() => undefined) as unknown as never,
	POLICY_ID_LENGTH: 56,
	getOutputMinLovelace: () => 1_000_000n,
	MeshWallet: class {
		async getUnusedAddresses() {
			return [];
		}
		async signTx() {
			return 'ff'.repeat(20);
		}
	},
	MeshTxBuilder: class {
		txIn(...args: unknown[]) {
			mockTxIn(...args);
			return this;
		}
		txOut(...args: unknown[]) {
			mockTxOut(...args);
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

const { HydraTransportAmbiguousError, HydraProtocolError } = await import('@/lib/hydra/hydra/errors');
const { executeHydraConsolidation } = await import('./execute');

const HEAD = {
	id: 'head-1',
	isEnabled: true,
	status: 'Open',
	LocalParticipant: {
		id: 'participant-1',
		Wallet: {
			id: 'wallet-1',
			walletAddress: 'addr_test1_local',
			Secret: { encryptedMnemonic: 'encrypted' },
			PaymentSource: { network: 'Preprod' },
		},
	},
};

function utxo(char: string, lovelace: number) {
	return {
		input: { txHash: char.repeat(64), outputIndex: 0 },
		output: { address: 'addr_test1_local', amount: [{ unit: 'lovelace', quantity: lovelace.toString() }] },
	};
}

/** The release call: the only updateMany that sets lockedAt back to null. */
function releaseCalls() {
	return mockWalletUpdateMany.mock.calls.filter(
		([args]) => (args as { data: { lockedAt: unknown } }).data.lockedAt === null,
	);
}

beforeEach(() => {
	jest.clearAllMocks();
	// Reset, not cleared: an unused Once answer must not leak into the next test.
	mockAssertNotPaused.mockReset().mockResolvedValue(undefined);
	mockHeadFindUnique.mockResolvedValue(HEAD);
	mockWalletUpdateMany.mockResolvedValue({ count: 1 });
	mockDecommitFindFirst.mockResolvedValue(null);
	mockFetchPendingDecommitRefs.mockResolvedValue([]);
	mockFetchProtocolParameters.mockResolvedValue({ minFeeA: 0, minFeeB: 0, coinsPerUtxoSize: 4310 });
	mockFetchAddressUTxOs.mockResolvedValue([utxo('a', 2_000_000), utxo('b', 3_000_000), utxo('c', 50_000_000)]);
	mockNewTx.mockResolvedValue('cd'.repeat(32));
	mockIsTxConfirmed.mockReturnValue(true);
});

afterEach(() => {
	jest.useRealTimers();
});

describe('executeHydraConsolidation', () => {
	it('merges every UTxO under the wallet lock and releases it once confirmed', async () => {
		const result = await executeHydraConsolidation('head-1');

		expect(result).toEqual({
			headId: 'head-1',
			txId: 'cd'.repeat(32),
			inputCount: 3,
			outputCount: 2,
			remainingCount: 0,
		});
		expect(mockTxIn).toHaveBeenCalledTimes(3);
		expect(mockTxOut).toHaveBeenCalledWith('addr_test1_local', [{ unit: 'lovelace', quantity: '5000000' }]);
		const [claim] = mockWalletUpdateMany.mock.calls[0] as [{ where: Record<string, unknown> }];
		expect(claim.where).toMatchObject({ id: 'wallet-1', lockedAt: null, pendingTransactionId: null });
		expect(releaseCalls()).toHaveLength(1);
	});

	// A purchase lock building on the same UTxOs would be refused by the head
	// after its funds were already reserved.
	it('refuses while the wallet is busy, without building anything', async () => {
		mockWalletUpdateMany.mockResolvedValueOnce({ count: 0 });

		await expect(executeHydraConsolidation('head-1')).rejects.toMatchObject({ status: 409 });
		expect(mockNewTx).not.toHaveBeenCalled();
		expect(releaseCalls()).toHaveLength(0);
	});

	it('refuses while a withdrawal is still settling, before taking the lock', async () => {
		mockFetchPendingDecommitRefs.mockResolvedValue(['x#0']);

		await expect(executeHydraConsolidation('head-1')).rejects.toMatchObject({ status: 409 });
		expect(mockWalletUpdateMany).not.toHaveBeenCalled();
	});

	// A withdrawal's split output is about to be decommitted; spending it here
	// would fail the withdrawal.
	it('refuses while a withdrawal is being prepared, before taking the lock', async () => {
		mockDecommitFindFirst.mockResolvedValue({ id: 'decommit-1' });

		await expect(executeHydraConsolidation('head-1')).rejects.toMatchObject({ status: 409 });
		expect(mockWalletUpdateMany).not.toHaveBeenCalled();
	});

	it('refuses and releases the lock when a withdrawal starts mid-build', async () => {
		mockDecommitFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'decommit-1' });

		await expect(executeHydraConsolidation('head-1')).rejects.toMatchObject({ status: 409 });
		expect(mockNewTx).not.toHaveBeenCalled();
		expect(releaseCalls()).toHaveLength(1);
	});

	it('refuses and releases the lock when the host is paused mid-build', async () => {
		mockAssertNotPaused
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(Object.assign(new Error('paused'), { status: 409 }));

		await expect(executeHydraConsolidation('head-1')).rejects.toMatchObject({ status: 409 });
		expect(mockAssertNotPaused).toHaveBeenCalledTimes(2);
		expect(mockNewTx).not.toHaveBeenCalled();
		expect(releaseCalls()).toHaveLength(1);
	});

	it('releases the lock when there is nothing to merge', async () => {
		mockFetchAddressUTxOs.mockResolvedValue([utxo('a', 50_000_000)]);

		await expect(executeHydraConsolidation('head-1')).rejects.toMatchObject({ status: 400 });
		expect(releaseCalls()).toHaveLength(1);
	});

	it('releases the lock when the head refuses the transaction', async () => {
		mockNewTx.mockRejectedValue(new HydraProtocolError('TxInvalid'));

		await expect(executeHydraConsolidation('head-1')).rejects.toThrow('TxInvalid');
		expect(releaseCalls()).toHaveLength(1);
	});

	// The head may still confirm it; the stale-lock reaper frees the wallet later.
	it('keeps the lock when the head answer is ambiguous', async () => {
		mockNewTx.mockRejectedValue(new HydraTransportAmbiguousError('no answer'));

		await expect(executeHydraConsolidation('head-1')).rejects.toThrow('no answer');
		expect(releaseCalls()).toHaveLength(0);
	});

	it('keeps the lock when the head accepts but does not confirm in time', async () => {
		jest.useFakeTimers();
		mockIsTxConfirmed.mockReturnValue(false);

		const outcome = executeHydraConsolidation('head-1');
		const assertion = expect(outcome).rejects.toMatchObject({ status: 504 });
		await jest.advanceTimersByTimeAsync(61_000);
		await assertion;
		expect(releaseCalls()).toHaveLength(0);
	});
});
