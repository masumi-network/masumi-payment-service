import { beforeEach, describe, expect, it, jest } from '@jest/globals';

type AnyMock = jest.Mock<(...args: any[]) => any>;

const mockDecommitUpdateMany = jest.fn() as AnyMock;
const mockDecommitUpdate = jest.fn() as AnyMock;
const mockDecommitCreate = jest.fn() as AnyMock;
const mockDecommitFindFirst = jest.fn() as AnyMock;
const mockHeadFindUnique = jest.fn() as AnyMock;
const mockHeadUpdate = jest.fn() as AnyMock;
const mockDecommitCall = jest.fn() as AnyMock;
const mockNewTx = jest.fn() as AnyMock;
const mockFetchPendingDecommitRefs = jest.fn() as AnyMock;
/** The node's raw `GET /head`, which decides whether a stale withdrawal may expire. */
const mockNodeGet = jest.fn() as AnyMock;
const mockFetchAddressUTxOs = jest.fn() as AnyMock;
/** Tracks which inputs the in-head transaction builder was given. */
const mockTxIn = jest.fn() as AnyMock;
/**
 * The head's own ledger parameters, which every in-head build must use.
 *
 * Zero fees and a real minimum-UTxO is what a Hydra head actually charges; L1
 * defaults are not a safe stand-in, and using them burned ADA inside the head.
 */
const mockFetchProtocolParameters = jest.fn() as AnyMock;
/** Confirms the in-head split transaction, so a fallback split can complete. */
const mockIsTxConfirmed = jest.fn() as AnyMock;
/** Returns the split's carved output, so the decommit can spend it. */
const mockFetchUTxOs = jest.fn() as AnyMock;

const mockIsPausedLocked = jest.fn(async () => false) as AnyMock;

jest.unstable_mockModule('@/services/hydra-host/pause', () => ({
	assertHydraHeadHostNotPaused: jest.fn(async () => undefined),
	isHydraHeadOnPausedHost: jest.fn(async () => false),
	isHydraHeadOnPausedHostLocked: mockIsPausedLocked,
	HYDRA_HOST_PAUSED_MESSAGE: 'hydra host is paused for maintenance',
}));

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

const mockRecordHeadError = jest.fn() as AnyMock;

jest.unstable_mockModule('@/routes/api/hydra/head', () => ({
	verifyPersistedHydraHeadOnChain: async () => ({ headIdentifier: 'ab'.repeat(28) }),
	recordHeadError: mockRecordHeadError,
	// A withdrawal needs a node that is answering and caught up, the same as a
	// deposit does. Ready here; the refusal itself is covered where the guard lives.
	assertNodeReadyForDeposit: async () => undefined,
}));

jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({
		getHead: () => ({
			decommit: mockDecommitCall,
			newTx: mockNewTx,
			mainNode: {
				pendingIncrementUtxoRefs: new Set<string>(),
				fetchPendingDecommitRefs: mockFetchPendingDecommitRefs,
				isTxConfirmed: mockIsTxConfirmed,
				get: mockNodeGet,
			},
		}),
		getProvider: () => ({
			fetchAddressUTxOs: mockFetchAddressUTxOs,
			fetchProtocolParameters: mockFetchProtocolParameters,
			fetchUTxOs: mockFetchUTxOs,
		}),
	}),
}));

// Enumerated rather than spread: a mock here applies to every transitively
// loaded file, and importing the real module to spread it exhausts the worker.
// Anything the import graph reaches must therefore be listed (see ADR-0005).
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
		txOut() {
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
const { PENDING_EXPIRED_REASON } = await import('./stale');

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
	mockFetchPendingDecommitRefs.mockResolvedValue([]);
	mockNodeGet.mockResolvedValue(headState({ decommitTx: null }));
	mockFetchProtocolParameters.mockResolvedValue({
		minFeeA: 0,
		minFeeB: 0,
		priceMem: 0,
		priceStep: 0,
		coinsPerUtxoSize: 4310,
		collateralPercent: 150,
		maxTxSize: 16384,
	});
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
	mockIsTxConfirmed.mockReturnValue(true);
	mockFetchUTxOs.mockResolvedValue([]);
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
	// Every withdrawal takes this path, so recording a head error here put a
	// CommandFailed against the head each time, describing something that had
	// already settled by the time anyone read it. Errors that routinely mean
	// nothing are what teach an operator to ignore the ones that matter.
	it('does not record a head error when the request was accepted but unconfirmed', async () => {
		mockDecommitCall.mockRejectedValue(new HydraTransportAmbiguousError('POST outcome is ambiguous'));

		await expect(executeHydraDecommit({ headId: 'head-1' })).rejects.toThrow('stays pending');

		expect(mockRecordHeadError).not.toHaveBeenCalled();
	});

	// A refusal the node actually answered with is a different matter: something
	// about this head or this request is wrong and should be on the record.
	it('records a head error when the node answers with a rejection', async () => {
		mockDecommitCall.mockRejectedValue(new Error('DecommitInvalid: nope'));

		await expect(executeHydraDecommit({ headId: 'head-1' })).rejects.toThrow('rejected the withdrawal');

		expect(mockRecordHeadError).toHaveBeenCalled();
	});

	it('leaves an ambiguous request Pending for the head to settle', async () => {
		mockDecommitCall.mockRejectedValue(new HydraTransportAmbiguousError('POST outcome is ambiguous'));

		await expect(executeHydraDecommit({ headId: 'head-1' })).rejects.toThrow('stays pending');

		// Nothing was written to Failed — not by this path, and not by the outer
		// handler either, which only owns rows still in Preparing.
		expect(mockDecommitUpdateMany.mock.calls.filter((call) => call[0]?.data?.status === 'Failed')).toHaveLength(0);
	});

	// Hydra produces no new snapshot while a previous decommit's utxoToDecommit
	// is still non-empty (the node hasn't yet observed its DecrementTx), so
	// starting another in-head split during that window gets a split that is
	// TxValid but can never be snapshot-confirmed. Refusing up front is what the
	// deposit side already does for the mirror case ("still being folded").
	it('refuses a withdrawal while the head still has a pending decommit', async () => {
		mockFetchPendingDecommitRefs.mockResolvedValue(['abc123'.repeat(10) + 'de#0']);

		await expect(executeHydraDecommit({ headId: 'head-1' })).rejects.toMatchObject({
			statusCode: 409,
			message: expect.stringContaining('still being settled on L1'),
		});

		expect(mockDecommitUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: 'Failed' }) }),
		);
		expect(mockNewTx).not.toHaveBeenCalled();
		expect(mockDecommitCall).not.toHaveBeenCalled();
	});

	// Checked again where the row is created, under the Host lock, so a pause
	// that lands after the route check still stops the withdrawal.
	it('refuses without creating a row when the host was paused in the meantime', async () => {
		mockIsPausedLocked.mockResolvedValueOnce(true);

		await expect(executeHydraDecommit({ headId: 'head-1' })).rejects.toMatchObject({ statusCode: 409 });

		expect(mockDecommitCreate).not.toHaveBeenCalled();
		expect(mockDecommitCall).not.toHaveBeenCalled();
	});
});

/**
 * The bug this exists to prevent, which cost a head its ability to close.
 *
 * An in-head transaction is validated by the head's ledger, not L1's. This head
 * charges no fee at all while still enforcing a real minimum-UTxO and 150%
 * collateral. Built with Mesh's defaults, every withdrawal paid a mainnet fee on
 * a transaction that never leaves the head — the fee was simply burned, and
 * burning it moved the head's ADA overhead.
 *
 * `headAdaOverhead` is an invariant the head validator re-checks on every
 * transition (mustPreserveHeadAdaOverhead, error H65), so each fee-paying
 * withdrawal took the head one step further from ever being closeable. Three
 * such transactions drifted it by 509,351 lovelace and the close became
 * impossible: not recoverable by contesting, which enforces the same invariant.
 */
describe('in-head transactions use the head’s own ledger parameters', () => {
	it('rejects an undersized exact ADA withdrawal before submission', async () => {
		await expect(executeHydraDecommit({ headId: 'head-1', lovelace: 34_480n })).rejects.toThrow(
			'Withdrawal output contains 34480 lovelace but requires at least 1000000',
		);
		expect(mockDecommitCall).not.toHaveBeenCalled();
	});

	it('asks the head for its parameters before building', async () => {
		await executeHydraDecommit({ headId: 'head-1' }).catch(() => undefined);

		expect(mockFetchProtocolParameters).toHaveBeenCalled();
	});
});

/**
 * The bug this exists to prevent: refusing an exact-amount withdrawal (any
 * refusal path — undersized, node rejection, timeout) left behind the exact
 * in-head UTxO its split had just carved. The next attempt at the same amount
 * ignored that UTxO and carved a fresh one from a bigger UTxO instead, because
 * `coverLovelace` picks largest-first and never looks for an exact match —
 * three stray 3.5 ADA UTxOs accumulated on one head this way in one day.
 */
describe('exact-amount withdrawals reuse an existing UTxO instead of re-splitting', () => {
	it('decommits an eligible UTxO of exactly the requested lovelace without splitting', async () => {
		// `jest.clearAllMocks()` in `beforeEach` clears call history but not a
		// mock's last configured implementation, and every earlier test in this
		// file that touches `mockDecommitCall` sets it to reject — this is the
		// one test that needs the node to actually accept the request.
		mockDecommitCall.mockResolvedValue(undefined);
		mockFetchAddressUTxOs.mockResolvedValue([
			// Held back as the collateral reserve: the smallest UTxO able to serve
			// as collateral on its own, so it never reaches `selection.eligible`.
			{
				input: { txHash: 'c'.repeat(64), outputIndex: 0 },
				output: { address: 'addr_test1_local', amount: [{ unit: 'lovelace', quantity: '5000000' }] },
			},
			{
				input: { txHash: 'd'.repeat(64), outputIndex: 0 },
				output: { address: 'addr_test1_local', amount: [{ unit: 'lovelace', quantity: '40000000' }] },
			},
			// Exactly the requested amount — this is the one that should be spent
			// whole, not carved out of the 40 ADA UTxO above.
			{
				input: { txHash: 'e'.repeat(64), outputIndex: 0 },
				output: { address: 'addr_test1_local', amount: [{ unit: 'lovelace', quantity: '3500000' }] },
			},
		]);

		await executeHydraDecommit({ headId: 'head-1', lovelace: 3_500_000n });

		// No in-head split transaction: the request was answered from an existing
		// UTxO, not by carving one down from the 40 ADA UTxO.
		expect(mockNewTx).not.toHaveBeenCalled();
		expect(mockDecommitCall).toHaveBeenCalledTimes(1);
		// The decommit transaction spent exactly the 3.5 ADA UTxO, and nothing else.
		expect(mockTxIn).toHaveBeenCalledTimes(1);
		expect(mockTxIn).toHaveBeenCalledWith('e'.repeat(64), 0, expect.anything(), 'addr_test1_local');
	});

	/**
	 * The bug this exists to prevent: the exact-match check compared lovelace
	 * only. `selection.eligible` excludes reference scripts but not native
	 * assets, and a decommit removes whole outputs — so an eligible UTxO that
	 * happened to hold the exact lovelace requested, plus some unrelated native
	 * asset (an agent's registry NFT, say), was decommitted whole and silently
	 * carried that asset out of the head.
	 */
	it('does not treat a UTxO carrying a native asset as the exact match, even at the exact lovelace', async () => {
		mockDecommitCall.mockResolvedValue(undefined);
		mockFetchAddressUTxOs.mockResolvedValue([
			// Held back as the collateral reserve.
			{
				input: { txHash: 'c'.repeat(64), outputIndex: 0 },
				output: { address: 'addr_test1_local', amount: [{ unit: 'lovelace', quantity: '5000000' }] },
			},
			// Pure ADA, large enough to cover the request by splitting — this is
			// what the fallback split must spend instead.
			{
				input: { txHash: 'd'.repeat(64), outputIndex: 0 },
				output: { address: 'addr_test1_local', amount: [{ unit: 'lovelace', quantity: '40000000' }] },
			},
			// Exactly the requested lovelace, but not pure ADA: this must be
			// excluded from the exact-match short-circuit.
			{
				input: { txHash: 'e'.repeat(64), outputIndex: 0 },
				output: {
					address: 'addr_test1_local',
					amount: [
						{ unit: 'lovelace', quantity: '3500000' },
						{ unit: 'a'.repeat(56) + '746f6b656e', quantity: '1' },
					],
				},
			},
		]);
		// The carved output the fallback split produces.
		mockFetchUTxOs.mockResolvedValue([
			{
				input: { txHash: 'f'.repeat(64), outputIndex: 0 },
				output: { address: 'addr_test1_local', amount: [{ unit: 'lovelace', quantity: '3500000' }] },
			},
		]);

		await executeHydraDecommit({ headId: 'head-1', lovelace: 3_500_000n });

		// The exact match was refused, so the flow fell back to a real split.
		expect(mockNewTx).toHaveBeenCalledTimes(1);
		expect(mockDecommitCall).toHaveBeenCalledTimes(1);
		// The split spent the pure 40 ADA UTxO, never the asset-carrying one that
		// also matched on lovelace.
		expect(mockTxIn).toHaveBeenCalledWith('d'.repeat(64), 0, expect.anything(), 'addr_test1_local');
		expect(mockTxIn).not.toHaveBeenCalledWith('e'.repeat(64), expect.anything(), expect.anything(), expect.anything());
		// The final decommit spent the split's carved output, not the
		// asset-carrying UTxO.
		expect(mockTxIn).toHaveBeenCalledWith('f'.repeat(64), 0, expect.anything(), 'addr_test1_local');
	});

	// A token-bearing cover is split, and its change can hold the same lovelace
	// as the carved output plus the token. Matching on lovelace alone could pick
	// the change and carry the token out, whatever order the head lists them in.
	it('decommits the pure carved output, never a change of equal lovelace that kept a token', async () => {
		const TOKEN = 'a'.repeat(56) + '746f6b656e';
		mockDecommitCall.mockResolvedValue(undefined);
		mockFetchAddressUTxOs.mockResolvedValue([
			{
				input: { txHash: 'c'.repeat(64), outputIndex: 0 },
				output: { address: 'addr_test1_local', amount: [{ unit: 'lovelace', quantity: '5000000' }] },
			},
			{
				input: { txHash: 'e'.repeat(64), outputIndex: 0 },
				output: {
					address: 'addr_test1_local',
					amount: [
						{ unit: 'lovelace', quantity: '20000000' },
						{ unit: TOKEN, quantity: '1' },
					],
				},
			},
		]);
		mockFetchUTxOs.mockResolvedValue([
			{
				input: { txHash: 'f'.repeat(64), outputIndex: 1 },
				output: {
					address: 'addr_test1_local',
					amount: [
						{ unit: 'lovelace', quantity: '10000000' },
						{ unit: TOKEN, quantity: '1' },
					],
				},
			},
			{
				input: { txHash: 'f'.repeat(64), outputIndex: 0 },
				output: { address: 'addr_test1_local', amount: [{ unit: 'lovelace', quantity: '10000000' }] },
			},
		]);

		await executeHydraDecommit({ headId: 'head-1', lovelace: 10_000_000n });

		expect(mockTxIn).toHaveBeenCalledWith('f'.repeat(64), 0, expect.anything(), 'addr_test1_local');
		expect(mockTxIn).not.toHaveBeenCalledWith('f'.repeat(64), 1, expect.anything(), expect.anything());
	});
});

/**
 * The refusal this guards against: the wallet's only collateral-sized UTxO also
 * held the token, the reserve withheld it, and the operator was told "Only 0 of
 * that asset is eligible to withdraw" while the balance showed the token.
 */
describe('withdrawing a token that sits on the collateral reserve', () => {
	const USDM = 'cc'.repeat(28) + '5553444d';

	function reserveWithToken(lovelace: string) {
		return {
			input: { txHash: 'c'.repeat(64), outputIndex: 0 },
			output: {
				address: 'addr_test1_local',
				amount: [
					{ unit: 'lovelace', quantity: lovelace },
					{ unit: USDM, quantity: '20000000' },
				],
			},
		};
	}

	// The reported head: a pure-ADA UTxO beside a faucet UTxO carrying the token,
	// which is the smaller one and so becomes the reserve.
	it('carves the token off the reserve instead of refusing', async () => {
		mockFetchAddressUTxOs.mockResolvedValue([
			reserveWithToken('10000000'),
			{
				input: { txHash: 'd'.repeat(64), outputIndex: 0 },
				output: { address: 'addr_test1_local', amount: [{ unit: 'lovelace', quantity: '50000000' }] },
			},
		]);

		await expect(
			executeHydraDecommit({ headId: 'head-1', asset: { unit: USDM, amount: 20_000_000n } }),
		).rejects.not.toThrow('eligible to withdraw');

		expect(mockTxIn).toHaveBeenCalledWith('c'.repeat(64), 0, expect.anything(), 'addr_test1_local');
	});

	// The carve's change is the only output left in the head, so it must still
	// be big enough to serve as collateral once the token has gone.
	it('refuses a carve that would leave no collateral-sized change', async () => {
		mockFetchAddressUTxOs.mockResolvedValue([reserveWithToken('5000000')]);

		await expect(
			executeHydraDecommit({ headId: 'head-1', asset: { unit: USDM, amount: 20_000_000n } }),
		).rejects.toThrow('needs 7000000 lovelace');
		await expect(
			executeHydraDecommit({ headId: 'head-1', asset: { unit: USDM, amount: 20_000_000n } }),
		).rejects.toThrow('so the collateral can stay behind');
		expect(mockTxIn).not.toHaveBeenCalled();
	});
});

/** A node's `GET /head` reply for an open head. */
function headState(coordinatedHeadState: Record<string, unknown>) {
	return { tag: 'Open', contents: { coordinatedHeadState } };
}

const STALE_PENDING = {
	id: 'decommit-old',
	status: 'Pending',
	decommitTxId: 'ef'.repeat(32),
	createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
	updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
};

function failedWrites() {
	return mockDecommitUpdateMany.mock.calls.filter((call) => call[0]?.data?.status === 'Failed');
}

/**
 * F5: a Pending withdrawal must not be failed on its age alone.
 *
 * The head may have approved or paid out a request the service never heard
 * back about, so a row only expires when the node answers that it holds no
 * withdrawal. Without the expiry at all, a request the node never saw blocked
 * every later withdrawal until the head was closed, so that path must stay open.
 */
describe('executeHydraDecommit with a stale pending withdrawal', () => {
	beforeEach(() => {
		mockDecommitFindFirst.mockResolvedValue(STALE_PENDING);
	});

	it('expires it and starts the new one when the node holds no withdrawal', async () => {
		await executeHydraDecommit({ headId: 'head-1' });

		expect(failedWrites()[0]![0]).toEqual({
			where: { id: STALE_PENDING.id, status: 'Pending' },
			data: { status: 'Failed', failureReason: PENDING_EXPIRED_REASON },
		});
		expect(mockDecommitCreate).toHaveBeenCalled();
	});

	it('keeps it and refuses while the node still holds a withdrawal', async () => {
		mockNodeGet.mockResolvedValue(headState({ decommitTx: { txId: STALE_PENDING.decommitTxId } }));

		await expect(executeHydraDecommit({ headId: 'head-1' })).rejects.toMatchObject({ statusCode: 409 });

		expect(failedWrites()).toHaveLength(0);
		expect(mockDecommitCreate).not.toHaveBeenCalled();
	});

	// The old behaviour: an hour passed, so the row became Failed, whatever the
	// head had done with it.
	it('keeps it and refuses when the node cannot be read', async () => {
		mockNodeGet.mockRejectedValue(new Error('ECONNRESET'));

		await expect(executeHydraDecommit({ headId: 'head-1' })).rejects.toMatchObject({
			statusCode: 409,
			message: expect.stringContaining(STALE_PENDING.decommitTxId),
		});

		expect(failedWrites()).toHaveLength(0);
		expect(mockDecommitCreate).not.toHaveBeenCalled();
	});

	it('keeps it when the node reply has no head state to judge by', async () => {
		mockNodeGet.mockResolvedValue({ tag: 'Idle' });

		await expect(executeHydraDecommit({ headId: 'head-1' })).rejects.toMatchObject({ statusCode: 409 });

		expect(failedWrites()).toHaveLength(0);
	});

	it('does not ask the node about a Pending row that is still young', async () => {
		mockDecommitFindFirst.mockResolvedValue({ ...STALE_PENDING, updatedAt: new Date() });

		await expect(executeHydraDecommit({ headId: 'head-1' })).rejects.toMatchObject({
			statusCode: 409,
			message: expect.stringContaining('already in progress'),
		});

		expect(mockNodeGet).not.toHaveBeenCalled();
		expect(failedWrites()).toHaveLength(0);
	});
});
