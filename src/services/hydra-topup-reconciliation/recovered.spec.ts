import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockTxsUtxos = jest.fn() as AnyMock;
const mockUpdateMany = jest.fn() as AnyMock;
const mockFindMany = jest.fn() as AnyMock;

jest.unstable_mockModule('@/utils/blockfrost', () => ({
	getBlockfrostInstance: () => ({ txsUtxos: mockTxsUtxos }),
}));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraTopup: { updateMany: mockUpdateMany, findMany: mockFindMany } },
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { HydraTopupStatus } = await import('@/generated/prisma/client');
const { reconcileRecoveredHydraTopups } = await import('./recovered');

const DEPOSIT_TX = 'a'.repeat(64);
const SPENDER_TX = 'b'.repeat(64);
const SCRIPT_ADDRESS = 'addr_test1wq2b91a7e6';
const WALLET_ADDRESS = 'addr_test1vz9k3n';

/** A row as the reconciler loads it, at whatever status the caller is testing. */
function topupRow(status: (typeof HydraTopupStatus)[keyof typeof HydraTopupStatus]) {
	return {
		id: 'topup-1',
		status,
		depositTxHash: DEPOSIT_TX,
		LocalParticipant: {
			Wallet: { PaymentSource: { network: 'Preprod', PaymentSourceConfig: { rpcProviderApiKey: 'preprodkey' } } },
		},
	};
}

/** The deposit's script output, and what the spending transaction paid to. */
function chain(consumedBy: string | null, spenderPaysTo: string[]) {
	mockTxsUtxos.mockImplementation(async (hash: string) => {
		if (hash === DEPOSIT_TX) {
			return { outputs: [{ address: SCRIPT_ADDRESS, consumed_by_tx: consumedBy }] };
		}
		return { outputs: spenderPaysTo.map((address) => ({ address })) };
	});
}

/**
 * The reconciler now runs two queries — Pending on its own, Confirmed and
 * Failed together — so each row is handed only to the query whose status filter
 * it matches, exactly as the database would.
 */
function stageRows(rows: ReturnType<typeof topupRow>[]) {
	mockFindMany.mockImplementation(async (args: { where?: { status?: unknown } }) => {
		const status = args?.where?.status;
		if (status === HydraTopupStatus.Pending) {
			return rows.filter((row) => row.status === HydraTopupStatus.Pending);
		}
		return rows.filter((row) => row.status === HydraTopupStatus.Confirmed || row.status === HydraTopupStatus.Failed);
	});
}

beforeEach(() => {
	jest.clearAllMocks();
	mockUpdateMany.mockResolvedValue({ count: 1 });
});

describe('reconcileRecoveredHydraTopups', () => {
	/**
	 * The head folds a deposit in on its own schedule, without waiting for the
	 * confirmation threshold that promotes a row to Confirmed. Considering only
	 * Confirmed rows left a deposit reading "Pending" while its funds were
	 * already spendable on L2.
	 */
	it('marks a still-Pending deposit Absorbed once the head has taken it in', async () => {
		stageRows([topupRow(HydraTopupStatus.Pending)]);
		chain(SPENDER_TX, [SCRIPT_ADDRESS, WALLET_ADDRESS]);

		await reconcileRecoveredHydraTopups();

		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'topup-1', status: HydraTopupStatus.Pending },
			data: { status: HydraTopupStatus.Absorbed },
		});
	});

	it('queries Pending and settled rows separately, so neither starves the other', async () => {
		mockFindMany.mockResolvedValue([]);

		await reconcileRecoveredHydraTopups();

		const filters = mockFindMany.mock.calls.map((call) => call[0]?.where?.status);
		// One query for Pending on its own, one for Confirmed and Failed together,
		// each with its own take rather than a shared budget the larger pool wins.
		expect(filters).toContainEqual(HydraTopupStatus.Pending);
		expect(filters).toContainEqual({ in: [HydraTopupStatus.Confirmed, HydraTopupStatus.Failed] });
	});

	it('checks a Confirmed row even when the Pending pool is full', async () => {
		// The starvation this split prevents: a Confirmed deposit waiting to be
		// marked Absorbed must still be reached when many Pending rows are queued.
		const pending = Array.from({ length: 20 }, (_unused, index) => ({
			...topupRow(HydraTopupStatus.Pending),
			id: `pending-${index}`,
			depositTxHash: DEPOSIT_TX,
		}));
		const confirmed = { ...topupRow(HydraTopupStatus.Confirmed), id: 'confirmed-1' };
		stageRows([...pending, confirmed]);
		chain(SPENDER_TX, [SCRIPT_ADDRESS]);

		await reconcileRecoveredHydraTopups();

		expect(mockUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: 'confirmed-1', status: HydraTopupStatus.Confirmed } }),
		);
	});

	it('marks a still-Pending deposit Recovered when it went back to a wallet', async () => {
		stageRows([topupRow(HydraTopupStatus.Pending)]);
		chain(SPENDER_TX, [WALLET_ADDRESS]);

		await reconcileRecoveredHydraTopups();

		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'topup-1', status: HydraTopupStatus.Pending },
			data: { status: HydraTopupStatus.Recovered },
		});
	});

	it('still absorbs from Confirmed, which was the only path before', async () => {
		stageRows([topupRow(HydraTopupStatus.Confirmed)]);
		chain(SPENDER_TX, [SCRIPT_ADDRESS]);

		await reconcileRecoveredHydraTopups();

		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'topup-1', status: HydraTopupStatus.Confirmed },
			data: { status: HydraTopupStatus.Absorbed },
		});
	});

	// Both reads are ordered by `updatedAt` and take a fixed budget, so a row that
	// never resolves would be re-read on every tick and nothing behind it would
	// ever be reached. The status is untouched — only the row's place in the
	// queue moves.
	it('leaves an unspent deposit alone, but rotates it to the back of the queue', async () => {
		stageRows([topupRow(HydraTopupStatus.Pending)]);
		chain(null, []);

		await reconcileRecoveredHydraTopups();

		expect(mockUpdateMany).toHaveBeenCalledTimes(1);
		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'topup-1', status: HydraTopupStatus.Pending },
			data: { updatedAt: expect.any(Date) },
		});
	});

	it('leaves the row alone when the chain cannot be read', async () => {
		// A lookup failure is not evidence of anything, and guessing here would
		// declare funds home or absorbed on a network blip. The rotation still
		// happens: a row whose lookup keeps failing is exactly the one that would
		// otherwise hold the front of the queue forever.
		stageRows([topupRow(HydraTopupStatus.Pending)]);
		mockTxsUtxos.mockRejectedValue(new Error('blockfrost unavailable'));

		await reconcileRecoveredHydraTopups();

		expect(mockUpdateMany).toHaveBeenCalledTimes(1);
		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'topup-1', status: HydraTopupStatus.Pending },
			data: { updatedAt: expect.any(Date) },
		});
	});

	it('guards the write on the status it read, so a concurrent promotion cannot be clobbered', async () => {
		stageRows([topupRow(HydraTopupStatus.Pending)]);
		chain(SPENDER_TX, [SCRIPT_ADDRESS]);
		mockUpdateMany.mockResolvedValue({ count: 0 });

		await reconcileRecoveredHydraTopups();

		expect(mockUpdateMany.mock.calls[0]?.[0]?.where?.status).toBe(HydraTopupStatus.Pending);
	});
});
