import { beforeEach, describe, expect, it, jest } from '@jest/globals';

type AnyMock = jest.Mock<(...args: any[]) => any>;
const mockLoad = jest.fn() as AnyMock;
const mockConnect = jest.fn() as AnyMock;
const mockDisconnect = jest.fn() as AnyMock;
const mockConstruct = jest.fn() as AnyMock;

jest.unstable_mockModule('@/services/hydra-connection-manager/head-configuration', () => ({
	loadValidatedHeadConfiguration: mockLoad,
}));
jest.unstable_mockModule('@/lib/hydra/hydra/snapshot-accumulator-worker-client', () => ({
	createWorkerAccumulatorComputer: () => jest.fn(),
}));
jest.unstable_mockModule('@/lib/hydra/hydra/node', () => ({
	HydraNode: class {
		constructor(config: unknown) {
			mockConstruct(config);
		}
		connect = mockConnect;
		disconnect = mockDisconnect;
	},
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { ContestObserverConfigurationError, readOnlyContestNode, releaseUnusedContestObservers } =
	await import('./read-only-observer');

beforeEach(() => {
	jest.clearAllMocks();
	mockLoad.mockResolvedValue({
		configuredHead: { headIdentifier: 'a'.repeat(56) },
		nodeUrls: { httpUrl: 'http://127.0.0.1:4001', wsUrl: 'ws://127.0.0.1:4001' },
		nodeAuthToken: 'user-token',
		localVerificationKey: 'local',
		remoteVerificationKeys: ['remote'],
		reconciledHistoryCursor: undefined,
	});
	mockConnect.mockResolvedValue(undefined);
	mockDisconnect.mockResolvedValue(undefined);
});

describe('read-only contest observer', () => {
	it('opens one pinned, authenticated evidence socket and releases it when no longer needed', async () => {
		const first = await readOnlyContestNode('head-1');
		expect(await readOnlyContestNode('head-1')).toBe(first);
		expect(mockLoad).toHaveBeenCalledTimes(1);
		expect(mockLoad).toHaveBeenCalledWith('head-1', { readOnlyContestObserver: true });
		expect(mockConstruct).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedHeadId: 'a'.repeat(56),
				guardHostDestination: true,
				authToken: 'user-token',
				snapshotVerificationKeys: ['local', 'remote'],
				retainConfirmedTransactions: false,
			}),
		);
		await releaseUnusedContestObservers(new Set());
		expect(mockDisconnect).toHaveBeenCalledTimes(1);
		await readOnlyContestNode('head-1');
		expect(mockLoad).toHaveBeenCalledTimes(2);
		await releaseUnusedContestObservers(new Set());
	});

	it('drops a failed connection so the next tick can retry', async () => {
		mockConnect.mockRejectedValueOnce(new Error('socket unavailable'));
		await expect(readOnlyContestNode('head-2')).rejects.not.toBeInstanceOf(ContestObserverConfigurationError);
		await readOnlyContestNode('head-2');
		expect(mockLoad).toHaveBeenCalledTimes(2);
		await releaseUnusedContestObservers(new Set());
	});

	// The watch reports this as a service problem, not as a node that is down.
	it('marks a configuration failure as one, before any socket opens', async () => {
		mockLoad.mockRejectedValueOnce(new Error('no pinned identifier'));
		await expect(readOnlyContestNode('head-3')).rejects.toBeInstanceOf(ContestObserverConfigurationError);
		expect(mockConstruct).not.toHaveBeenCalled();
	});
});
