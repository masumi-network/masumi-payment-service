/**
 * What "Check now" records about a Host.
 *
 * The probe used to run the free-slot check with the compatibility checks, so a
 * healthy Host whose only slot held a live head was marked Unreachable. It also
 * stopped at the first failed check, so an operator fixed one problem per probe.
 */

import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { HydraHostStatus, Network } from '@/generated/prisma/client';
import type { Mock } from 'jest-mock';
import type { HostCapabilities } from './client';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindUnique = jest.fn() as AnyMock;
const mockUpdate = jest.fn() as AnyMock;
const mockFetchCapabilities = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraHost: { findUnique: mockFindUnique },
		$transaction: async (run: (tx: unknown) => Promise<unknown>) =>
			await run({
				hydraHost: {
					findUniqueOrThrow: async () => ({ status: HydraHostStatus.Active }),
					update: mockUpdate,
				},
			}),
	},
}));

jest.unstable_mockModule('@/utils/security/encryption', () => ({
	encrypt: (value: string) => `enc:${value}`,
	decrypt: (value: string) => value.replace(/^enc:/, ''),
}));

jest.unstable_mockModule('./client', () => ({
	fetchHostCapabilities: mockFetchCapabilities,
	truncateError: (message: string, limit = 500) => (message.length <= limit ? message : message.slice(0, limit)),
}));

jest.unstable_mockModule('./compatibility', () => ({
	expectedHostCapabilitiesForNetwork: () => ({
		network: 'mainnet',
		hydraVersion: '2.4.1',
		scriptCatalogueHash: 'catalogue-hash',
		ledgerParamsHash: 'sha256:abc',
	}),
}));

let refreshHydraHostCapabilities: typeof import('./registry').refreshHydraHostCapabilities;

beforeAll(async () => {
	({ refreshHydraHostCapabilities } = await import('./registry'));
});

function capabilities(overrides: Partial<HostCapabilities> = {}): HostCapabilities {
	return {
		hydraVersion: '2.4.1',
		scriptCatalogueHash: 'catalogue-hash',
		ledgerParamsHash: 'sha256:abc',
		network: 'mainnet',
		exchangePort: 8444,
		exchangeUrl: 'https://exchange.example.com:8444/exchange',
		release: { version: null, commit: null },
		nodeSlots: { used: 0, capacity: 32 },
		probeError: null,
		...overrides,
	};
}

beforeEach(() => {
	jest.clearAllMocks();
	mockFindUnique.mockResolvedValue({
		id: 'host-1',
		network: Network.Mainnet,
		baseUrl: 'https://host',
		allowInsecureHttp: false,
		encryptedAdminToken: 'enc:admin-token',
	});
	// Echo the write back as the row, so the result shows what was recorded.
	mockUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
		id: 'host-1',
		createdAt: new Date(0),
		updatedAt: new Date(0),
		name: 'hydra-soko',
		network: Network.Mainnet,
		baseUrl: 'https://host',
		allowInsecureHttp: false,
		publicPeerHost: 'host',
		encryptedAdminToken: 'enc:admin-token',
		releaseVersion: null,
		releaseCommit: null,
		pausedAt: null,
		_count: { Participants: 1 },
		...data,
	}));
});

describe('refreshHydraHostCapabilities', () => {
	it('keeps a full host Active', async () => {
		mockFetchCapabilities.mockResolvedValue(capabilities({ nodeSlots: { used: 1, capacity: 1 } }));

		const host = await refreshHydraHostCapabilities('host-1');

		expect(host.status).toBe(HydraHostStatus.Active);
		expect(host.lastHealthError).toBeNull();
	});

	it('records every failed check, one per line', async () => {
		mockFetchCapabilities.mockResolvedValue(
			capabilities({ network: 'preprod', hydraVersion: '9.9.9', ledgerParamsHash: 'sha256:other' }),
		);

		const host = await refreshHydraHostCapabilities('host-1');

		expect(host.status).toBe(HydraHostStatus.Unreachable);
		const lines = host.lastHealthError?.split('\n') ?? [];
		expect(lines).toHaveLength(3);
		expect(lines[0]).toMatch(/runs preprod/);
		expect(lines[1]).toMatch(/runs 9\.9\.9/);
		expect(lines[2]).toMatch(/sha256:other/);
	});

	// Each ledger or catalogue mismatch is about 400 characters, so the old
	// 500-character cut would drop every problem after the first.
	it('keeps every problem when several long ones fail', async () => {
		mockFetchCapabilities.mockResolvedValue(
			capabilities({ exchangeUrl: null, scriptCatalogueHash: 'other-catalogue', ledgerParamsHash: 'sha256:other' }),
		);

		const host = await refreshHydraHostCapabilities('host-1');

		const lines = host.lastHealthError?.split('\n') ?? [];
		expect(lines).toHaveLength(3);
		expect(lines[2]).toMatch(/regenerate that file from the pinned mesh line$/);
	});

	// A Host's stderr can be long. Cut alone, it would leave no room for the
	// other problems.
	it('cuts each problem on its own', async () => {
		mockFetchCapabilities.mockResolvedValue(
			capabilities({ probeError: 'x'.repeat(3000), ledgerParamsHash: 'sha256:other' }),
		);

		const host = await refreshHydraHostCapabilities('host-1');

		const lines = host.lastHealthError?.split('\n') ?? [];
		expect(lines).toHaveLength(2);
		expect(lines[0].length).toBeLessThanOrEqual(500);
		expect(lines[1]).toMatch(/sha256:other/);
	});

	// An unreachable Host can answer with a proxy's HTML error page. It is one
	// problem, so it must not show as one bullet per line.
	it('records an unreachable host on one line', async () => {
		mockFetchCapabilities.mockRejectedValue(
			new Error('hydra host returned 502: <html>\n<body>Bad gateway</body>\n</html>'),
		);

		const host = await refreshHydraHostCapabilities('host-1');

		expect(host.status).toBe(HydraHostStatus.Unreachable);
		expect(host.lastHealthError).toBe('hydra host returned 502: <html> <body>Bad gateway</body> </html>');
	});
});
