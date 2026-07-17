import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockNetworkFindUnique = jest.fn() as jest.Mock<any>;
const mockSecretFindUniqueOrThrow = jest.fn() as jest.Mock<any>;
const mockWalletCreate = jest.fn() as jest.Mock<any>;
const mockExecuteRaw = jest.fn() as jest.Mock<any>;

class MockPrismaClientKnownRequestError extends Error {
	code: string;

	constructor(message: string, code: string) {
		super(message);
		this.code = code;
	}
}

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	Prisma: { PrismaClientKnownRequestError: MockPrismaClientKnownRequestError },
	X402EvmWalletType: { Purchasing: 'Purchasing', Selling: 'Selling' },
	prisma: {
		x402Network: { findUnique: mockNetworkFindUnique },
		x402WalletSecret: { findUniqueOrThrow: mockSecretFindUniqueOrThrow },
		x402EvmWallet: { create: mockWalletCreate },
		$executeRaw: mockExecuteRaw,
	},
}));

jest.unstable_mockModule('@masumi/payment-core/encryption', () => ({
	encrypt: jest.fn((value: string) => `encrypted:${value}`),
}));

const { createX402ManagedWallet } = await import('./wallets');

const privateKey = `0x${'a'.repeat(64)}`;

describe('createX402ManagedWallet', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockNetworkFindUnique.mockResolvedValue({ id: 'network-1' });
		mockExecuteRaw.mockResolvedValue(1);
		mockSecretFindUniqueOrThrow.mockResolvedValue({ id: 'secret-shared' });
		mockWalletCreate.mockImplementation(async ({ data }: any) => ({
			id: 'wallet-1',
			networkId: 'network-1',
			address: data.address,
			type: data.type,
			note: data.note,
			createdAt: new Date('2026-07-01T00:00:00.000Z'),
			updatedAt: new Date('2026-07-01T00:00:00.000Z'),
			createdById: 'api-key-1',
			Network: { caip2Id: 'eip155:8453' },
		}));
	});

	it('converges concurrent cross-network imports on the address-unique secret', async () => {
		const wallet = await createX402ManagedWallet({
			createdByApiKeyId: 'api-key-1',
			networkId: 'network-1',
			type: 'Purchasing' as Parameters<typeof createX402ManagedWallet>[0]['type'],
			privateKey,
		});

		const [rawQueryParts, address, encryptedPrivateKey] = mockExecuteRaw.mock.calls[0];
		const queryParts = rawQueryParts as readonly string[];
		expect(queryParts.join('')).toContain('ON CONFLICT ("address") DO NOTHING');
		expect(address).toBe(wallet.address);
		expect(encryptedPrivateKey).toBe(`encrypted:${privateKey}`);
		expect(mockSecretFindUniqueOrThrow).toHaveBeenCalledWith({
			where: { address: wallet.address },
			select: { id: true },
		});
		expect(mockWalletCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ Secret: { connect: { id: 'secret-shared' } } }),
			}),
		);
	});

	it('still maps a duplicate wallet on the same network to 409', async () => {
		mockWalletCreate.mockRejectedValueOnce(
			new MockPrismaClientKnownRequestError('Unique constraint failed on networkId/address', 'P2002'),
		);

		await expect(
			createX402ManagedWallet({
				createdByApiKeyId: 'api-key-1',
				networkId: 'network-1',
				type: 'Purchasing' as Parameters<typeof createX402ManagedWallet>[0]['type'],
				privateKey,
			}),
		).rejects.toMatchObject({ status: 409 });
	});

	it('maps an adapter-pg 23505 duplicate wallet error to 409', async () => {
		const error = new Error('duplicate key value violates unique constraint') as Error & {
			name: string;
			cause?: { code: string };
		};
		error.name = 'DriverAdapterError';
		error.cause = { code: '23505' };
		mockWalletCreate.mockRejectedValueOnce(error);

		await expect(
			createX402ManagedWallet({
				createdByApiKeyId: 'api-key-1',
				networkId: 'network-1',
				type: 'Purchasing' as Parameters<typeof createX402ManagedWallet>[0]['type'],
				privateKey,
			}),
		).rejects.toMatchObject({ status: 409 });
	});
});
