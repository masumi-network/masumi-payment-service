import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Prisma } from '@/generated/prisma/client';

type Participant = {
	id: string;
	keysDisclosedAt: Date | null;
	HydraSecretKey: { hydraSK: string; cardanoSK: string | null };
};
type RevealResult = {
	id: string;
	disclosedAt: string;
	hydraSigningKey: string;
	cardanoSigningKey: string | null;
};
type TransactionClient = {
	$queryRaw: (sql: Prisma.Sql) => Promise<Array<{ id: string; keysDisclosedAt: Date | null }>>;
	hydraLocalParticipant: {
		update: (args: { data: { keysDisclosedAt: Date } }) => Promise<Participant>;
	};
};

const mockTransaction =
	jest.fn<
		(
			run: (tx: TransactionClient) => Promise<unknown>,
			options: { isolationLevel: string; maxWait: number; timeout: number },
		) => Promise<unknown>
	>();
const mockQueryRaw = jest.fn<TransactionClient['$queryRaw']>();
const mockUpdate = jest.fn<TransactionClient['hydraLocalParticipant']['update']>();
const transactionClient = { $queryRaw: mockQueryRaw, hydraLocalParticipant: { update: mockUpdate } };

jest.unstable_mockModule('@masumi/payment-core/auth', () => ({
	adminAuthenticatedEndpointFactory: { build: (definition: unknown) => definition },
}));
jest.unstable_mockModule('@masumi/payment-core/db', () => ({ prisma: { $transaction: mockTransaction } }));
jest.unstable_mockModule('@masumi/payment-core/serializable-semaphore', () => ({
	withSerializableSlotRetry: async (operation: () => Promise<unknown>) => await operation(),
}));
jest.unstable_mockModule('../deletion-guard', () => ({
	quiesceHydraHeadsForDeletion: jest.fn(),
	assertNoUnrecoveredHydraDeposits: jest.fn(),
	reconciledFinalHeadFilter: {},
	unsettledL2TransactionWhere: {},
	unrecoveredHydraTopupWhere: {},
}));

let revealParticipantKeysPost: { handler: (args: unknown) => Promise<RevealResult> };
let encrypt: (value: string) => string;
let storedParticipant: Participant | null;
let transactionDraft: Participant | null;
let beforeCommit: () => Promise<void>;
const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() };
const HYDRA_SIGNING_KEY = '5820' + '11'.repeat(32);
const CARDANO_SIGNING_KEY = '5820' + '22'.repeat(32);

function call() {
	return revealParticipantKeysPost.handler({ input: { id: 'p1' }, logger });
}

beforeAll(async () => {
	({ encrypt } = await import('@/utils/security/encryption'));
	({ revealParticipantKeysPost } = (await import('./index')) as unknown as {
		revealParticipantKeysPost: typeof revealParticipantKeysPost;
	});
});

beforeEach(() => {
	jest.clearAllMocks();
	storedParticipant = {
		id: 'p1',
		keysDisclosedAt: null,
		HydraSecretKey: { hydraSK: encrypt(HYDRA_SIGNING_KEY), cardanoSK: encrypt(CARDANO_SIGNING_KEY) },
	};
	beforeCommit = async () => undefined;
	// Model only the database boundary: failed callbacks/commits cannot persist
	// their draft. The endpoint and encryption implementation remain real.
	mockTransaction.mockImplementation(async (run) => {
		transactionDraft = structuredClone(storedParticipant);
		const result = await run(transactionClient);
		await beforeCommit();
		storedParticipant = structuredClone(transactionDraft);
		return result;
	});
	mockQueryRaw.mockImplementation(async () =>
		transactionDraft === null ? [] : [{ id: transactionDraft.id, keysDisclosedAt: transactionDraft.keysDisclosedAt }],
	);
	mockUpdate.mockImplementation(async ({ data }) => {
		if (transactionDraft === null) throw new Error('Missing transaction participant');
		transactionDraft.keysDisclosedAt = data.keysDisclosedAt;
		return structuredClone(transactionDraft);
	});
});

describe('revealParticipantKeysPost', () => {
	it('returns both real decrypted keys after sealing under the existing row lock', async () => {
		const response = await call();
		expect(response).toEqual({
			id: 'p1',
			disclosedAt: storedParticipant?.keysDisclosedAt?.toISOString(),
			hydraSigningKey: HYDRA_SIGNING_KEY,
			cardanoSigningKey: CARDANO_SIGNING_KEY,
		});
		expect(mockTransaction).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({ isolationLevel: 'Serializable' }),
		);
		expect(mockQueryRaw.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				strings: expect.arrayContaining([expect.stringContaining('FOR UPDATE')]),
			}),
		);
		expect(logger.warn).toHaveBeenCalledWith('Hydra node signing keys disclosed for participant p1');
		await expect(call()).rejects.toMatchObject({ status: 409 });
		expect(mockUpdate).toHaveBeenCalledTimes(1);
	});

	it.each(['hydraSK', 'cardanoSK'] as const)(
		'does not seal when %s cannot decrypt, and permits a corrected retry',
		async (key) => {
			const participant = storedParticipant!;
			const originalCipher = participant.HydraSecretKey[key]!;
			// Too short to contain the required salt and IV. Real decryption must fail.
			participant.HydraSecretKey[key] = '00';
			await expect(call()).rejects.toThrow();
			expect(storedParticipant?.keysDisclosedAt).toBeNull();
			expect(logger.warn).not.toHaveBeenCalled();

			participant.HydraSecretKey[key] = originalCipher;
			await expect(call()).resolves.toMatchObject({
				hydraSigningKey: HYDRA_SIGNING_KEY,
				cardanoSigningKey: CARDANO_SIGNING_KEY,
			});
			await expect(call()).rejects.toMatchObject({ status: 409 });
		},
	);

	it('returns no keys or disclosure log when the commit fails, and permits retry', async () => {
		beforeCommit = async () => {
			throw new Error('database commit failed');
		};
		await expect(call()).rejects.toThrow('database commit failed');
		expect(storedParticipant?.keysDisclosedAt).toBeNull();
		expect(logger.warn).not.toHaveBeenCalled();
		beforeCommit = async () => undefined;
		await expect(call()).resolves.toMatchObject({ hydraSigningKey: HYDRA_SIGNING_KEY });
	});

	it('does not resolve keys or log disclosure while the commit is pending', async () => {
		let enterCommit!: () => void;
		let releaseCommit!: () => void;
		const entered = new Promise<void>((resolve) => {
			enterCommit = resolve;
		});
		const commit = new Promise<void>((resolve) => {
			releaseCommit = resolve;
		});
		beforeCommit = async () => {
			enterCommit();
			await commit;
		};
		let resolved = false;
		const response = call().then((result) => {
			resolved = true;
			return result;
		});
		await entered;
		expect(resolved).toBe(false);
		expect(storedParticipant?.keysDisclosedAt).toBeNull();
		expect(logger.warn).not.toHaveBeenCalled();
		releaseCommit();
		await expect(response).resolves.toMatchObject({ hydraSigningKey: HYDRA_SIGNING_KEY });
		expect(logger.warn).toHaveBeenCalledTimes(1);
	});

	it('reports a missing participant without disclosing or sealing', async () => {
		storedParticipant = null;
		await expect(call()).rejects.toMatchObject({ status: 404 });
		expect(mockUpdate).not.toHaveBeenCalled();
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('backs up legacy participants without a stored Cardano key', async () => {
		storedParticipant!.HydraSecretKey.cardanoSK = null;
		await expect(call()).resolves.toMatchObject({ hydraSigningKey: HYDRA_SIGNING_KEY, cardanoSigningKey: null });
	});
});
