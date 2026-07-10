import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockPaymentAttemptFindMany = jest.fn() as jest.Mock<any>;
const mockSettlementFindMany = jest.fn() as jest.Mock<any>;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	Prisma: {},
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
		x402PaymentAttempt: { findMany: mockPaymentAttemptFindMany },
		x402Settlement: { findMany: mockSettlementFindMany },
	},
}));

const { listX402PaymentAttempts } = await import('./queries');

const inboundAttempt = {
	id: 'attempt-inbound-1',
	createdAt: new Date('2026-07-01T00:00:00.000Z'),
	updatedAt: new Date('2026-07-01T00:00:00.000Z'),
	direction: 'InboundSettle',
	status: 'Settled',
	apiKeyId: 'api-key-1',
	evmWalletId: null,
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
});
