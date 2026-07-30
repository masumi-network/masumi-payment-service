import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockTransaction = jest.fn() as AnyMock;
const mockQueryRaw = jest.fn() as AnyMock;
const mockUpdate = jest.fn() as AnyMock;

const transactionClient = {
	$queryRaw: mockQueryRaw,
	hydraLocalParticipant: { update: mockUpdate },
};

jest.unstable_mockModule('@masumi/payment-core/auth', () => ({
	adminAuthenticatedEndpointFactory: { build: (definition: unknown) => definition },
}));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { $transaction: mockTransaction },
}));

jest.unstable_mockModule('@masumi/payment-core/serializable-semaphore', () => ({
	withSerializableSlotRetry: async (operation: () => Promise<unknown>) => await operation(),
}));

jest.unstable_mockModule('../deletion-guard', () => ({
	quiesceHydraHeadsForDeletion: jest.fn(),
	reconciledFinalHeadFilter: {},
	unsettledL2TransactionWhere: {},
}));

// Decryption is the identity here so the test can assert the *plaintext* that
// leaves the endpoint without needing a real key.
jest.unstable_mockModule('@/utils/security/encryption', () => ({
	encrypt: (value: string) => value,
	decrypt: (value: string) => `plain:${value}`,
}));

let revealParticipantKeysPost: { handler: (args: unknown) => Promise<unknown> };

const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() };

function call(id: string) {
	return revealParticipantKeysPost.handler({ input: { id }, logger }) as Promise<{
		id: string;
		disclosedAt: string;
		hydraSigningKey: string;
		cardanoSigningKey: string | null;
	}>;
}

beforeAll(async () => {
	({ revealParticipantKeysPost } = (await import('./index')) as unknown as {
		revealParticipantKeysPost: { handler: (args: unknown) => Promise<unknown> };
	});
});

beforeEach(() => {
	jest.clearAllMocks();
	mockTransaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => await run(transactionClient));
});

describe('revealParticipantKeysPost', () => {
	it('returns both signing keys the first time', async () => {
		mockQueryRaw.mockResolvedValue([{ id: 'p1', keysDisclosedAt: null }]);
		mockUpdate.mockResolvedValue({
			id: 'p1',
			keysDisclosedAt: new Date('2026-07-30T16:00:00.000Z'),
			HydraSecretKey: { hydraSK: 'hydra-cipher', cardanoSK: 'cardano-cipher' },
		});

		await expect(call('p1')).resolves.toEqual({
			id: 'p1',
			disclosedAt: '2026-07-30T16:00:00.000Z',
			hydraSigningKey: 'plain:hydra-cipher',
			cardanoSigningKey: 'plain:cardano-cipher',
		});
	});

	// The whole point: a database copy that any admin call can print on demand is
	// a far worse secret than one that leaves exactly once.
	it('refuses once the keys have already been handed out', async () => {
		mockQueryRaw.mockResolvedValue([{ id: 'p1', keysDisclosedAt: new Date('2026-07-30T15:00:00.000Z') }]);

		await expect(call('p1')).rejects.toThrow(/sealed/);
		expect(mockUpdate).not.toHaveBeenCalled();
	});

	it('seals in the same transaction that reads the row', async () => {
		mockQueryRaw.mockResolvedValue([{ id: 'p1', keysDisclosedAt: null }]);
		mockUpdate.mockResolvedValue({
			id: 'p1',
			keysDisclosedAt: new Date('2026-07-30T16:00:00.000Z'),
			HydraSecretKey: { hydraSK: 'h', cardanoSK: 'c' },
		});

		await call('p1');

		// Serializable plus a row lock: two concurrent reveals must not both win.
		expect(mockTransaction).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({ isolationLevel: 'Serializable' }),
		);
		expect(mockQueryRaw).toHaveBeenCalled();
		expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { keysDisclosedAt: expect.any(Date) } }));
	});

	it('reports a missing participant rather than disclosing anything', async () => {
		mockQueryRaw.mockResolvedValue([]);

		await expect(call('missing')).rejects.toThrow(/not found/);
		expect(mockUpdate).not.toHaveBeenCalled();
	});

	// Nodes provisioned before the Cardano key was captured have only the Hydra
	// one; that must read as absent rather than crash the backup.
	it('tolerates a node with no stored cardano key', async () => {
		mockQueryRaw.mockResolvedValue([{ id: 'p1', keysDisclosedAt: null }]);
		mockUpdate.mockResolvedValue({
			id: 'p1',
			keysDisclosedAt: new Date('2026-07-30T16:00:00.000Z'),
			HydraSecretKey: { hydraSK: 'hydra-cipher', cardanoSK: null },
		});

		await expect(call('p1')).resolves.toMatchObject({ cardanoSigningKey: null });
	});

	it('records the disclosure in the log', async () => {
		mockQueryRaw.mockResolvedValue([{ id: 'p1', keysDisclosedAt: null }]);
		mockUpdate.mockResolvedValue({
			id: 'p1',
			keysDisclosedAt: new Date('2026-07-30T16:00:00.000Z'),
			HydraSecretKey: { hydraSK: 'h', cardanoSK: 'c' },
		});

		await call('p1');
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('p1'));
	});
});
