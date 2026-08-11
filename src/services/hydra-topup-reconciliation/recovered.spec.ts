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
		mockFindMany.mockResolvedValue([topupRow(HydraTopupStatus.Pending)]);
		chain(SPENDER_TX, [SCRIPT_ADDRESS, WALLET_ADDRESS]);

		await reconcileRecoveredHydraTopups();

		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'topup-1', status: HydraTopupStatus.Pending },
			data: { status: HydraTopupStatus.Absorbed },
		});
	});

	it('considers Pending rows at all', async () => {
		mockFindMany.mockResolvedValue([]);

		await reconcileRecoveredHydraTopups();

		const where = mockFindMany.mock.calls[0]?.[0]?.where;
		expect(where.status.in).toEqual(
			expect.arrayContaining([HydraTopupStatus.Pending, HydraTopupStatus.Confirmed, HydraTopupStatus.Failed]),
		);
	});

	it('marks a still-Pending deposit Recovered when it went back to a wallet', async () => {
		mockFindMany.mockResolvedValue([topupRow(HydraTopupStatus.Pending)]);
		chain(SPENDER_TX, [WALLET_ADDRESS]);

		await reconcileRecoveredHydraTopups();

		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'topup-1', status: HydraTopupStatus.Pending },
			data: { status: HydraTopupStatus.Recovered },
		});
	});

	it('still absorbs from Confirmed, which was the only path before', async () => {
		mockFindMany.mockResolvedValue([topupRow(HydraTopupStatus.Confirmed)]);
		chain(SPENDER_TX, [SCRIPT_ADDRESS]);

		await reconcileRecoveredHydraTopups();

		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'topup-1', status: HydraTopupStatus.Confirmed },
			data: { status: HydraTopupStatus.Absorbed },
		});
	});

	it('leaves an unspent deposit alone', async () => {
		mockFindMany.mockResolvedValue([topupRow(HydraTopupStatus.Pending)]);
		chain(null, []);

		await reconcileRecoveredHydraTopups();

		expect(mockUpdateMany).not.toHaveBeenCalled();
	});

	it('leaves the row alone when the chain cannot be read', async () => {
		// A lookup failure is not evidence of anything, and guessing here would
		// declare funds home or absorbed on a network blip.
		mockFindMany.mockResolvedValue([topupRow(HydraTopupStatus.Pending)]);
		mockTxsUtxos.mockRejectedValue(new Error('blockfrost unavailable'));

		await reconcileRecoveredHydraTopups();

		expect(mockUpdateMany).not.toHaveBeenCalled();
	});

	it('guards the write on the status it read, so a concurrent promotion cannot be clobbered', async () => {
		mockFindMany.mockResolvedValue([topupRow(HydraTopupStatus.Pending)]);
		chain(SPENDER_TX, [SCRIPT_ADDRESS]);
		mockUpdateMany.mockResolvedValue({ count: 0 });

		await reconcileRecoveredHydraTopups();

		expect(mockUpdateMany.mock.calls[0]?.[0]?.where?.status).toBe(HydraTopupStatus.Pending);
	});
});
