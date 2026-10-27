import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindHost = jest.fn() as AnyMock;
const mockStartHostNode = jest.fn() as AnyMock;
const mockWithPauseLease = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraHost: { findUnique: mockFindHost } },
}));
jest.unstable_mockModule('@/utils/security/encryption', () => ({ decrypt: (value: string) => value }));
jest.unstable_mockModule('@/services/hydra-host/client', () => ({
	startHostNode: mockStartHostNode,
	checkHostPeerTarget: jest.fn(),
	fetchHostNodePeers: jest.fn(),
	setHostNodePeers: jest.fn(),
}));
jest.unstable_mockModule('@/services/hydra-host/pause', () => ({ withHostPauseLease: mockWithPauseLease }));
jest.unstable_mockModule('./exchange-client', () => ({ attemptRedemption: jest.fn() }));
jest.unstable_mockModule('./redemption-store', () => ({
	LIVE_REDEEMER_STATUSES: [],
	claimUnconfirmed: jest.fn(),
	discardUnlanded: jest.fn(),
	failUnconfirmed: jest.fn(),
	linkRedeemerToHead: jest.fn(),
	markAcknowledged: jest.fn(),
	markStarted: jest.fn(),
}));

let buildRedemptionPorts: typeof import('./redemption-ports').buildRedemptionPorts;

beforeAll(async () => {
	({ buildRedemptionPorts } = await import('./redemption-ports'));
});

beforeEach(() => {
	jest.clearAllMocks();
	mockFindHost.mockResolvedValue({ pausedAt: null });
	mockStartHostNode.mockResolvedValue(undefined);
	mockWithPauseLease.mockImplementation(async (_hostId: string, action: () => Promise<void>) => {
		await action();
		return true;
	});
});

function start(): Promise<void> {
	const ports = buildRedemptionPorts({
		record: {
			id: 'invite-1',
			updatedAt: new Date(),
			hydraHostId: 'host-1',
			hostNodeId: 'node-1',
			HydraHost: {
				baseUrl: 'https://host.example',
				encryptedAdminToken: 'admin-token',
				allowInsecureHttp: false,
			},
		} as Parameters<typeof buildRedemptionPorts>[0]['record'],
		transport: { allowInsecureHttp: false, allowPrivateNetwork: false },
		createHead: jest.fn() as Parameters<typeof buildRedemptionPorts>[0]['createHead'],
	});
	return ports.start();
}

describe('redemption node start', () => {
	it('does not start while token rotation or Resume holds the Host lease', async () => {
		mockWithPauseLease.mockResolvedValue(false);

		await expect(start()).rejects.toMatchObject({ status: 409 });
		expect(mockStartHostNode).not.toHaveBeenCalled();
	});

	it('rechecks the pause after taking the lease', async () => {
		mockFindHost.mockResolvedValue({ pausedAt: new Date() });

		await expect(start()).rejects.toMatchObject({ status: 409 });
		expect(mockStartHostNode).not.toHaveBeenCalled();
	});

	it('holds the lease until the Host confirms the start', async () => {
		let hasLease = false;
		mockWithPauseLease.mockImplementation(async (_hostId: string, action: () => Promise<void>) => {
			hasLease = true;
			try {
				await action();
			} finally {
				hasLease = false;
			}
			return true;
		});
		mockStartHostNode.mockImplementation(async () => {
			expect(hasLease).toBe(true);
		});

		await start();
		expect(hasLease).toBe(false);
		expect(mockStartHostNode).toHaveBeenCalledTimes(1);
	});
});
