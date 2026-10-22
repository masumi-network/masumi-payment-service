import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { HydraHeadStatus } from '@/generated/prisma/client';
import { encrypt } from '@/utils/security/encryption';

const mockFindHead = jest.fn<() => Promise<unknown>>();
const mockFindParticipant = jest.fn<() => Promise<unknown>>();
const mockFetchHealth = jest.fn<() => Promise<unknown>>();
const emptyCount = async () => 0;

type SessionReading = {
	networkConnected: boolean;
	confirmedTransactionHistoryReady: boolean;
	hasVerifiedPinnedSessions: boolean;
	confirmedTransactionHistoryError: Error | undefined;
};

let session: SessionReading | null;

jest.unstable_mockModule('@masumi/payment-core/auth', () => ({
	adminAuthenticatedEndpointFactory: { build: (definition: unknown) => definition },
}));
jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraHead: { findUnique: mockFindHead },
		hydraLocalParticipant: { findUnique: mockFindParticipant, findFirst: async () => null },
		transaction: { count: emptyCount },
		paymentRequest: { count: emptyCount },
		purchaseRequest: { count: emptyCount },
		hydraTopup: { count: emptyCount },
	},
}));
jest.unstable_mockModule('@/services/hydra-host/client', () => ({ fetchHostNodeHealth: mockFetchHealth }));
jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({
		getNode: () => session,
		isConnected: () => session !== null,
		getProvider: () => null,
	}),
}));

const { getHeadConnectionGet } = await import('./observability');
const readConnection = () =>
	(
		getHeadConnectionGet as unknown as {
			handler: (params: { input: { headId: string } }) => Promise<{
				connected: boolean;
				isReady: boolean;
				nodeState: string;
				reason: string | null;
				syncReady: boolean | null;
				syncReason: string | null;
			}>;
		}
	).handler({ input: { headId: 'head-1' } });

beforeEach(() => {
	session = {
		networkConnected: true,
		confirmedTransactionHistoryReady: true,
		hasVerifiedPinnedSessions: true,
		confirmedTransactionHistoryError: undefined,
	};
	mockFindHead.mockResolvedValue({
		id: 'head-1',
		status: HydraHeadStatus.Open,
		contestationPeriod: 600n,
		LocalParticipant: { id: 'participant-1' },
	});
	mockFindParticipant.mockResolvedValue({
		hostNodeId: 'node-1',
		HydraHost: { baseUrl: 'https://host.invalid', encryptedUserToken: encrypt('test-hydra-token') },
	});
	mockFetchHealth.mockResolvedValue({ usable: true, state: 'Running', chainSynced: true, driftSeconds: 0 });
});

describe('open head connection readiness', () => {
	it('does not report Ready while authenticated transaction history is still replaying', async () => {
		session!.confirmedTransactionHistoryReady = false;
		session!.hasVerifiedPinnedSessions = false;

		expect(await readConnection()).toMatchObject({
			connected: true,
			isReady: true,
			nodeState: 'Running',
			reason: null,
			syncReady: false,
			syncReason: expect.stringContaining('history'),
		});
	});

	it('reports a failed history replay even when the host and peer are healthy', async () => {
		session!.confirmedTransactionHistoryReady = false;
		session!.hasVerifiedPinnedSessions = false;
		session!.confirmedTransactionHistoryError = new Error('Invalid snapshot signature');

		expect(await readConnection()).toMatchObject({
			isReady: true,
			reason: null,
			syncReady: false,
			syncReason: expect.stringContaining('failed'),
		});
	});

	it('requires both sessions to authenticate the pinned head after replay completes', async () => {
		session!.hasVerifiedPinnedSessions = false;

		expect(await readConnection()).toMatchObject({
			syncReady: false,
			syncReason: expect.stringContaining('verified'),
		});
	});

	it('keeps checking an open head whose service session is disconnected', async () => {
		session = null;

		expect(await readConnection()).toMatchObject({
			connected: false,
			syncReady: false,
			syncReason: expect.stringContaining('session'),
		});
	});

	it('reports Ready after both sessions and transaction history are verified', async () => {
		expect(await readConnection()).toMatchObject({
			connected: true,
			isReady: true,
			reason: null,
			syncReady: true,
			syncReason: null,
		});
	});

	it('keeps the host shutdown reason while history is also incomplete', async () => {
		session!.confirmedTransactionHistoryReady = false;
		mockFetchHealth.mockResolvedValue({ usable: false, state: 'Stopped', chainSynced: true, driftSeconds: 0 });

		expect(await readConnection()).toMatchObject({
			isReady: false,
			reason: expect.stringContaining('not running'),
		});
	});

	it('does not require an open-head snapshot before Init can run', async () => {
		session!.confirmedTransactionHistoryReady = false;
		session!.hasVerifiedPinnedSessions = false;
		mockFindHead.mockResolvedValue({
			id: 'head-1',
			status: HydraHeadStatus.Idle,
			contestationPeriod: 600n,
			LocalParticipant: { id: 'participant-1' },
		});

		expect(await readConnection()).toMatchObject({ isReady: true, reason: null, syncReady: null, syncReason: null });
	});
});
