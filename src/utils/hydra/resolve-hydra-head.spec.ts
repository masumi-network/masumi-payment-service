import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { HydraHeadStatus, Network } from '@/generated/prisma/client';

const mockFindUnique = jest.fn() as jest.Mock<any>;
const mockFindFirst = jest.fn() as jest.Mock<any>;

jest.unstable_mockModule('@/utils/db', () => ({
	prisma: {
		hydraRelation: { findUnique: mockFindUnique },
		hydraHead: { findFirst: mockFindFirst },
	},
}));

const { resolveUsableHydraHead, resolveUsableHydraHeadForPurchase } = await import('./resolve-hydra-head');

const NETWORK: Network = Network.Preprod;

const makeLocalParticipant = (overrides: Record<string, unknown> = {}) => ({
	id: 'local-participant-1',
	walletId: 'hot-wallet-1',
	hydraHeadId: 'head-1',
	...overrides,
});

const makeRemoteParticipant = (overrides: Record<string, unknown> = {}) => ({
	id: 'remote-participant-1',
	walletId: 'remote-wallet-1',
	hydraHeadId: 'head-1',
	...overrides,
});

const makeHead = (overrides: Record<string, unknown> = {}) => ({
	id: 'head-1',
	headIdentifier: 'head-identifier-abc',
	isEnabled: true,
	status: HydraHeadStatus.Open,
	hydraRelationId: 'relation-1',
	LocalParticipant: makeLocalParticipant(),
	RemoteParticipants: [makeRemoteParticipant()],
	...overrides,
});

const makeRelation = (overrides: Record<string, unknown> = {}) => ({
	id: 'relation-1',
	network: NETWORK,
	localHotWalletId: 'hot-wallet-1',
	remoteWalletId: 'remote-wallet-1',
	Heads: [makeHead()],
	...overrides,
});

describe('resolveUsableHydraHead', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('returns null when no relation is found', async () => {
		mockFindUnique.mockResolvedValue(null);

		const result = await resolveUsableHydraHead('hot-wallet-1', 'remote-wallet-1', NETWORK);

		expect(result).toBeNull();
	});

	it('returns null when relation has no enabled open heads', async () => {
		mockFindUnique.mockResolvedValue(makeRelation({ Heads: [] }));

		const result = await resolveUsableHydraHead('hot-wallet-1', 'remote-wallet-1', NETWORK);

		expect(result).toBeNull();
	});

	it('returns null when the head has no LocalParticipant', async () => {
		const headWithoutLocal = makeHead({ LocalParticipant: null });
		mockFindUnique.mockResolvedValue(makeRelation({ Heads: [headWithoutLocal] }));

		const result = await resolveUsableHydraHead('hot-wallet-1', 'remote-wallet-1', NETWORK);

		expect(result).toBeNull();
	});

	it('returns a UsableHydraHead on the happy path', async () => {
		const relation = makeRelation();
		mockFindUnique.mockResolvedValue(relation);

		const result = await resolveUsableHydraHead('hot-wallet-1', 'remote-wallet-1', NETWORK);

		expect(result).not.toBeNull();
		expect(result?.hydraRelationId).toBe('relation-1');
		expect(result?.hydraHead.id).toBe('head-1');
		expect(result?.localParticipant.id).toBe('local-participant-1');
		expect(result?.remoteParticipants).toHaveLength(1);
	});

	it('queries with the correct composite key and filters', async () => {
		mockFindUnique.mockResolvedValue(null);

		await resolveUsableHydraHead('hot-wallet-1', 'remote-wallet-1', NETWORK);

		expect(mockFindUnique).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					network_localHotWalletId_remoteWalletId: {
						network: NETWORK,
						localHotWalletId: 'hot-wallet-1',
						remoteWalletId: 'remote-wallet-1',
					},
				},
				include: expect.objectContaining({
					Heads: expect.objectContaining({
						where: expect.objectContaining({
							isEnabled: true,
							headIdentifier: { not: null },
							status: 'Open',
						}),
					}),
				}),
			}),
		);
	});

	it('returns the first head when multiple open heads are present', async () => {
		const head1 = makeHead({ id: 'head-first' });
		const head2 = makeHead({ id: 'head-second' });
		const relation = makeRelation({ Heads: [head1, head2] });
		mockFindUnique.mockResolvedValue(relation);

		const result = await resolveUsableHydraHead('hot-wallet-1', 'remote-wallet-1', NETWORK);

		expect(result?.hydraHead.id).toBe('head-first');
	});
});

describe('resolveUsableHydraHeadForPurchase', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('returns null when no head is found', async () => {
		mockFindFirst.mockResolvedValue(null);

		const result = await resolveUsableHydraHeadForPurchase('buyer-wallet-1', 'seller-wallet-1', NETWORK);

		expect(result).toBeNull();
	});

	it('returns null when the head has no LocalParticipant', async () => {
		const headWithoutLocal = makeHead({ LocalParticipant: null });
		mockFindFirst.mockResolvedValue(headWithoutLocal);

		const result = await resolveUsableHydraHeadForPurchase('buyer-wallet-1', 'seller-wallet-1', NETWORK);

		expect(result).toBeNull();
	});

	it('returns a UsableHydraHead on the happy path', async () => {
		const head = makeHead();
		mockFindFirst.mockResolvedValue(head);

		const result = await resolveUsableHydraHeadForPurchase('buyer-wallet-1', 'seller-wallet-1', NETWORK);

		expect(result).not.toBeNull();
		expect(result?.hydraHead.id).toBe('head-1');
		expect(result?.localParticipant.id).toBe('local-participant-1');
		expect(result?.remoteParticipants).toHaveLength(1);
		expect(result?.hydraRelationId).toBe('relation-1');
	});

	it('queries with the correct filters for the purchase flow', async () => {
		mockFindFirst.mockResolvedValue(null);

		await resolveUsableHydraHeadForPurchase('buyer-wallet-1', 'seller-wallet-1', NETWORK);

		expect(mockFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					isEnabled: true,
					headIdentifier: { not: null },
					status: HydraHeadStatus.Open,
					LocalParticipant: {
						walletId: 'buyer-wallet-1',
					},
					HydraRelation: {
						network: NETWORK,
						remoteWalletId: 'seller-wallet-1',
					},
				}),
			}),
		);
	});

	it('uses hydraRelationId from the head record', async () => {
		const head = makeHead({ hydraRelationId: 'relation-from-head' });
		mockFindFirst.mockResolvedValue(head);

		const result = await resolveUsableHydraHeadForPurchase('buyer-wallet-1', 'seller-wallet-1', NETWORK);

		expect(result?.hydraRelationId).toBe('relation-from-head');
	});
});
