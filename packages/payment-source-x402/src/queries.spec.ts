import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockPaymentAttemptFindMany = jest.fn() as jest.Mock<any>;
const mockPaymentAttemptCount = jest.fn() as jest.Mock<any>;
const mockSettlementFindMany = jest.fn() as jest.Mock<any>;
const mockQueryRaw = jest.fn() as jest.Mock<any>;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	Prisma: {},
	X402FacilitatorMode: {
		SelfHosted: 'SelfHosted',
		Remote: 'Remote',
	},
	X402EvmWalletType: {
		Purchasing: 'Purchasing',
		Selling: 'Selling',
	},
	X402PaymentDirection: {
		InboundVerify: 'InboundVerify',
		InboundSettle: 'InboundSettle',
		OutboundPayment: 'OutboundPayment',
	},
	X402PaymentStatus: {
		PaymentRequired: 'PaymentRequired',
		Verified: 'Verified',
		Settled: 'Settled',
		Failed: 'Failed',
		Replayed: 'Replayed',
	},
	prisma: {
		x402PaymentAttempt: { findMany: mockPaymentAttemptFindMany, count: mockPaymentAttemptCount },
		x402Settlement: { findMany: mockSettlementFindMany },
		x402EvmWallet: { count: jest.fn() },
		$queryRaw: mockQueryRaw,
	},
}));

const { listX402PaymentAttempts } = await import('./queries');
const { countX402PaymentAttempts } = await import('./counts');
const { SETTLE_STALE_MS } = await import('./settle-lock');

const inboundAttempt = {
	id: 'attempt-inbound-1',
	createdAt: new Date('2026-07-01T00:00:00.000Z'),
	updatedAt: new Date('2026-07-01T00:00:00.000Z'),
	direction: 'InboundSettle',
	status: 'Settled',
	apiKeyId: 'api-key-1',
	evmWalletId: null,
	facilitatorMode: null,
	registryRequestId: 'registry-1',
	supportedPaymentSourceId: null,
	asset: '0x2222222222222222222222222222222222222222',
	amount: 100n,
	payTo: '0x1111111111111111111111111111111111111111',
	resource: null,
	paymentIdentifier: null,
	errorReason: null,
	errorMessage: null,
	Network: { caip2Id: 'eip155:8453' },
	EvmWallet: null,
	CounterpartyWallet: { address: '0x3333333333333333333333333333333333333333' },
	SupportedPaymentSource: null,
	Settlement: null,
};

describe('listX402PaymentAttempts', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockPaymentAttemptCount.mockResolvedValue(0);
	});

	it('keeps the immutable inbound payee after its registered source is replaced', async () => {
		mockPaymentAttemptFindMany.mockResolvedValueOnce([inboundAttempt]);

		const [attempt] = await listX402PaymentAttempts({ take: 20 });

		expect(attempt.payTo).toBe(inboundAttempt.payTo);
		expect(attempt.payer).toBe(inboundAttempt.CounterpartyWallet.address);
	});

	it('falls back to the live source for transition rows without a payee snapshot', async () => {
		mockPaymentAttemptFindMany.mockResolvedValueOnce([
			{
				...inboundAttempt,
				payTo: null,
				supportedPaymentSourceId: 'source-1',
				SupportedPaymentSource: { payTo: '0x4444444444444444444444444444444444444444' },
			},
		]);

		const [attempt] = await listX402PaymentAttempts({ take: 20 });

		expect(attempt.payTo).toBe('0x4444444444444444444444444444444444444444');
	});

	it('reports legacy inbound facilitator history as unknown instead of using current config', async () => {
		mockPaymentAttemptFindMany.mockResolvedValueOnce([inboundAttempt]);

		const [attempt] = await listX402PaymentAttempts({ take: 20 });

		expect(attempt.facilitator).toEqual({ mode: 'unknown', address: null });
	});

	it('reports the immutable facilitator-mode snapshot for new inbound attempts', async () => {
		mockPaymentAttemptFindMany.mockResolvedValueOnce([
			{
				...inboundAttempt,
				evmWalletId: 'wallet-1',
				facilitatorMode: 'SelfHosted',
				EvmWallet: { address: '0x5555555555555555555555555555555555555555' },
			},
			{ ...inboundAttempt, id: 'attempt-inbound-2', facilitatorMode: 'Remote' },
		]);

		const [selfHosted, remote] = await listX402PaymentAttempts({ take: 20 });

		expect(selfHosted.facilitator).toEqual({
			mode: 'self_hosted',
			address: '0x5555555555555555555555555555555555555555',
		});
		expect(remote.facilitator).toEqual({ mode: 'remote', address: null });
	});

	it('uses the database clock for the manual-action list cutoff', async () => {
		const databaseNow = new Date('2026-07-16T10:00:00.000Z');
		mockQueryRaw.mockResolvedValueOnce([{ now: databaseNow }]);
		mockPaymentAttemptFindMany.mockResolvedValueOnce([]);

		await listX402PaymentAttempts({ take: 20, filterNeedsManualAction: true });

		expect(mockQueryRaw).toHaveBeenCalledTimes(1);
		expect(mockPaymentAttemptFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					OR: expect.arrayContaining([
						expect.objectContaining({
							updatedAt: { lt: new Date(databaseNow.getTime() - SETTLE_STALE_MS) },
						}),
					]),
				}),
			}),
		);
	});

	it('uses the database clock for the manual-action count cutoff', async () => {
		const databaseNow = new Date('2026-07-16T10:00:00.000Z');
		mockQueryRaw.mockResolvedValueOnce([{ now: databaseNow }]);

		await countX402PaymentAttempts({ filterNeedsManualAction: true });

		expect(mockQueryRaw).toHaveBeenCalledTimes(1);
		expect(mockPaymentAttemptCount).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					OR: expect.arrayContaining([
						expect.objectContaining({
							updatedAt: { lt: new Date(databaseNow.getTime() - SETTLE_STALE_MS) },
						}),
					]),
				}),
			}),
		);
	});
});
