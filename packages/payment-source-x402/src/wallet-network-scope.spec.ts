import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockNetworkFindUnique = jest.fn() as jest.Mock<any>;
const mockNetworkFindMany = jest.fn() as jest.Mock<any>;
const mockWalletCreate = jest.fn() as jest.Mock<any>;
const mockWalletFindFirst = jest.fn() as jest.Mock<any>;
const mockWalletFindMany = jest.fn() as jest.Mock<any>;
const mockWalletFindUnique = jest.fn() as jest.Mock<any>;
const mockWalletUpdate = jest.fn() as jest.Mock<any>;
const mockWalletCount = jest.fn() as jest.Mock<any>;
const mockTransaction = jest.fn() as jest.Mock<any>;
const mockExecuteRaw = jest.fn() as jest.Mock<any>;
const mockSecretFindUniqueOrThrow = jest.fn() as jest.Mock<any>;

class MockPrismaClientKnownRequestError extends Error {
	code: string;

	constructor(message: string, code: string) {
		super(message);
		this.code = code;
	}
}

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	Prisma: { PrismaClientKnownRequestError: MockPrismaClientKnownRequestError },
	X402CounterpartyRole: { Payee: 'Payee', Payer: 'Payer' },
	X402EvmWalletType: { Purchasing: 'Purchasing', Selling: 'Selling' },
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
		x402Network: {
			findMany: mockNetworkFindMany,
			findUnique: mockNetworkFindUnique,
			updateMany: jest.fn(),
		},
		x402EvmWallet: {
			count: mockWalletCount,
			create: mockWalletCreate,
			findFirst: mockWalletFindFirst,
			findMany: mockWalletFindMany,
			findUnique: mockWalletFindUnique,
			update: mockWalletUpdate,
		},
		x402WalletSecret: { findUniqueOrThrow: mockSecretFindUniqueOrThrow },
		x402WalletBudget: { updateMany: jest.fn() },
		x402EvmWalletLowBalanceRule: { updateMany: jest.fn() },
		$executeRaw: mockExecuteRaw,
		$transaction: mockTransaction,
	},
}));

jest.unstable_mockModule('@masumi/payment-core/encryption', () => ({
	encrypt: jest.fn((value: string) => `encrypted:${value}`),
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.unstable_mockModule('viem/accounts', () => ({
	generatePrivateKey: jest.fn(() => `0x${'b'.repeat(64)}`),
	privateKeyToAccount: jest.fn(() => ({ address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })),
}));

const { countX402ManagedWallets } = await import('./counts');
const { listAvailableX402Networks } = await import('./networks');
const {
	createX402ManagedWallet,
	deleteX402ManagedWallet,
	getX402ManagedWallet,
	listX402ManagedWallets,
	updateX402ManagedWallet,
} = await import('./wallets');

const wallet = {
	id: 'wallet-1',
	networkId: 'network-1',
	address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	type: 'Purchasing',
	note: null,
	createdAt: new Date('2026-01-01T00:00:00.000Z'),
	updatedAt: new Date('2026-01-01T00:00:00.000Z'),
	createdById: 'api-key-1',
	Network: { caip2Id: 'eip155:8453' },
};

describe('managed wallet network limits', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockNetworkFindUnique.mockResolvedValue({ id: 'network-1', caip2Id: 'eip155:8453' });
		mockNetworkFindMany.mockResolvedValue([
			{
				id: 'network-1',
				caip2Id: 'eip155:8453',
				displayName: 'Base',
				isTestnet: false,
				isEnabled: true,
				defaultAsset: '0x1111111111111111111111111111111111111111',
				defaultAssetDecimals: 8,
			},
		]);
		mockWalletFindUnique.mockResolvedValue(wallet);
		mockWalletFindMany.mockResolvedValue([wallet]);
		mockWalletCount.mockResolvedValue(1);
		mockWalletCreate.mockResolvedValue(wallet);
		mockExecuteRaw.mockResolvedValue(1);
		mockSecretFindUniqueOrThrow.mockResolvedValue({ id: 'secret-1' });
	});

	it('rejects wallet creation when the opaque network id resolves outside the key limit', async () => {
		await expect(
			createX402ManagedWallet({
				createdByApiKeyId: 'api-key-1',
				networkId: 'network-1',
				type: 'Purchasing' as Parameters<typeof createX402ManagedWallet>[0]['type'],
				privateKey: `0x${'a'.repeat(64)}`,
				caip2NetworkLimit: ['eip155:84532'],
			}),
		).rejects.toMatchObject({ status: 404 });
		expect(mockWalletCreate).not.toHaveBeenCalled();
	});

	it('lists only the safe network projection within the key limit', async () => {
		const networks = await listAvailableX402Networks({
			isTestnet: false,
			caip2NetworkLimit: ['eip155:8453'],
		});

		expect(mockNetworkFindMany).toHaveBeenCalledWith({
			// No facilitator filter: outbound (buy) wallets need no facilitator,
			// so enabled facilitator-less networks stay discoverable and are
			// marked via `canSettle` instead.
			where: {
				isTestnet: false,
				isEnabled: true,
				caip2Id: { in: ['eip155:8453'] },
			},
			orderBy: { caip2Id: 'asc' },
			select: {
				id: true,
				caip2Id: true,
				displayName: true,
				isTestnet: true,
				isEnabled: true,
				defaultAsset: true,
				defaultAssetDecimals: true,
				facilitatorWalletId: true,
				facilitatorUrl: true,
			},
		});
		expect(networks).toEqual([
			expect.objectContaining({
				id: 'network-1',
				caip2Id: 'eip155:8453',
				canSettle: false,
			}),
		]);
		expect(networks[0]).not.toHaveProperty('facilitatorWalletId');
		expect(networks[0]).not.toHaveProperty('facilitatorUrl');
	});

	it('bootstraps a wallet from an allowed discovered network id', async () => {
		const [network] = await listAvailableX402Networks({
			caip2NetworkLimit: ['eip155:8453'],
		});
		if (network == null) throw new Error('expected a discoverable network');

		await expect(
			createX402ManagedWallet({
				createdByApiKeyId: 'api-key-1',
				networkId: network.id,
				type: 'Purchasing' as Parameters<typeof createX402ManagedWallet>[0]['type'],
				privateKey: `0x${'a'.repeat(64)}`,
				caip2NetworkLimit: ['eip155:8453'],
			}),
		).resolves.toMatchObject({
			id: 'wallet-1',
			networkId: 'network-1',
			caip2Network: 'eip155:8453',
		});
	});

	it('keeps admin discovery unlimited and empty limits restrictive', async () => {
		await listAvailableX402Networks({ caip2NetworkLimit: null });
		expect(mockNetworkFindMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ caip2Id: undefined }),
			}),
		);

		await listAvailableX402Networks({ caip2NetworkLimit: [] });
		expect(mockNetworkFindMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ caip2Id: { in: [] } }),
			}),
		);
	});

	it('combines owner and network scopes for wallet lists and counts', async () => {
		await listX402ManagedWallets({ ownerScope: 'api-key-1', caip2NetworkLimit: ['eip155:8453'] });
		await countX402ManagedWallets({ ownerScope: 'api-key-1', caip2NetworkLimit: ['eip155:8453'] });

		expect(mockWalletFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					createdById: 'api-key-1',
					Network: { caip2Id: { in: ['eip155:8453'] } },
				}),
			}),
		);
		expect(mockWalletCount).toHaveBeenCalledWith({
			where: expect.objectContaining({
				createdById: 'api-key-1',
				Network: { caip2Id: { in: ['eip155:8453'] } },
			}),
		});
	});

	it('keeps detail, update, and delete denials indistinguishable from a missing wallet', async () => {
		const limit = ['eip155:84532'];

		await expect(getX402ManagedWallet('wallet-1', 'api-key-1', limit)).rejects.toMatchObject({ status: 404 });
		await expect(
			updateX402ManagedWallet({
				id: 'wallet-1',
				note: 'blocked',
				ownerScope: 'api-key-1',
				caip2NetworkLimit: limit,
			}),
		).rejects.toMatchObject({ status: 404 });
		await expect(deleteX402ManagedWallet('wallet-1', 'api-key-1', limit)).rejects.toMatchObject({ status: 404 });

		expect(mockWalletUpdate).not.toHaveBeenCalled();
		expect(mockTransaction).not.toHaveBeenCalled();
	});

	it('keeps admin access unlimited', async () => {
		await expect(getX402ManagedWallet('wallet-1', null, null)).resolves.toMatchObject({
			id: 'wallet-1',
			caip2Network: 'eip155:8453',
		});
	});
});
