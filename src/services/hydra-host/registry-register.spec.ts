import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { HydraHostStatus, Network } from '@/generated/prisma/client';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockCreate = jest.fn() as AnyMock;
const mockFindUnique = jest.fn() as AnyMock;
const mockFetchCapabilities = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraHost: { create: mockCreate, findUnique: mockFindUnique } },
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('@/utils/security/encryption', () => ({
	encrypt: (value: string) => `enc:${value}`,
	decrypt: (value: string) => value.replace(/^enc:/, ''),
}));

jest.unstable_mockModule('./client', () => ({
	HydraHostRequestError: class extends Error {},
	fetchHostCapabilities: mockFetchCapabilities,
	fetchHostNodeHealth: jest.fn(),
	startHostNode: jest.fn(),
	stopHostNode: jest.fn(),
	truncateError: (message: string) => message,
}));

let registerHydraHost: typeof import('./registry').registerHydraHost;

beforeAll(async () => {
	({ registerHydraHost } = await import('./registry'));
});

const TOKEN = 'a'.repeat(40);

function created(baseUrl: string) {
	return {
		id: 'host-1',
		createdAt: new Date(),
		updatedAt: new Date(),
		name: 'internal',
		network: Network.Preprod,
		baseUrl,
		allowInsecureHttp: true,
		publicPeerHost: '127.0.0.1',
		encryptedAdminToken: `enc:${TOKEN}`,
		hydraVersion: null,
		releaseVersion: null,
		releaseCommit: null,
		scriptCatalogueHash: null,
		ledgerParamsHash: null,
		status: HydraHostStatus.Unreachable,
		lastHealthAt: null,
		lastHealthError: null,
		pausedAt: null,
		_count: { Participants: 0 },
	};
}

beforeEach(() => {
	jest.clearAllMocks();
	mockFindUnique.mockResolvedValue(null);
});

afterEach(() => {
	delete process.env.HYDRA_TRUSTED_PRIVATE_HOSTS;
});

describe('registerHydraHost and internal addresses', () => {
	it.each(['http://169.254.169.254', 'http://127.0.0.1:4001', 'https://10.0.0.5'])(
		'refuses %s before storing or contacting anything',
		async (baseUrl) => {
			await expect(
				registerHydraHost({
					name: 'internal',
					network: Network.Preprod,
					baseUrl,
					allowInsecureHttp: true,
					adminToken: TOKEN,
				}),
			).rejects.toMatchObject({ statusCode: 400 });

			expect(mockCreate).not.toHaveBeenCalled();
			expect(mockFetchCapabilities).not.toHaveBeenCalled();
		},
	);

	// The operator, not the caller of the API, decides which private hosts are Hosts.
	it('registers an internal address the operator has listed', async () => {
		process.env.HYDRA_TRUSTED_PRIVATE_HOSTS = '127.0.0.1';
		mockCreate.mockResolvedValue(created('http://127.0.0.1:8443'));

		await expect(
			registerHydraHost({
				name: 'internal',
				network: Network.Preprod,
				baseUrl: 'http://127.0.0.1:8443',
				allowInsecureHttp: true,
				adminToken: TOKEN,
			}),
		).resolves.toMatchObject({ baseUrl: 'http://127.0.0.1:8443' });
		expect(mockCreate).toHaveBeenCalledTimes(1);
	});
});
