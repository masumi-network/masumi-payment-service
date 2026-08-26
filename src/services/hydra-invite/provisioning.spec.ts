/**
 * A reserved node has to be acknowledged, however many attempts it took.
 *
 * The escrow-ack used to sit inside the branch that had just written the
 * participant row. A first attempt that died after the create — or whose ack
 * call failed — left the node in `PendingEscrow`, and the retry found the row,
 * took the `existing` branch and returned without acking. The Host's supervisor
 * removes an unacknowledged node once its escrow TTL is up (an hour by
 * default), so the node named by an invite that may be valid for another thirty
 * days is deleted underneath it, leaving a participant row pointing at nothing.
 */

import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Network } from '@/generated/prisma/client';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindMany = jest.fn() as AnyMock;
const mockFindFirst = jest.fn() as AnyMock;
const mockCreate = jest.fn() as AnyMock;
const mockAcknowledge = jest.fn() as AnyMock;
const mockProvision = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraHost: { findMany: mockFindMany },
		hydraLocalParticipant: { findFirst: mockFindFirst, create: mockCreate },
	},
}));

jest.unstable_mockModule('@/utils/security/encryption', () => ({
	encrypt: (value: string) => `enc:${value}`,
	decrypt: (value: string) => value.replace(/^enc:/, ''),
}));

jest.unstable_mockModule('@/services/hydra-host/client', () => ({
	HydraHostRequestError: class extends Error {},
	acknowledgeEscrowOnHost: mockAcknowledge,
	fetchHostCapabilities: jest.fn(async () => ({ exchangePort: 4600, ledgerParamsHash: 'params-hash' })),
	hostNodeUrls: () => ({ nodeUrl: 'https://host/node', nodeHttpUrl: 'https://host/node/http' }),
	provisionNodeOnHost: mockProvision,
}));

jest.unstable_mockModule('@/services/hydra-host/placement', () => ({
	assertHostCompatible: () => undefined,
	selectPlacementHost: (hosts: Array<{ id: string }>) => hosts[0],
}));

jest.unstable_mockModule('@/services/hydra-host/compatibility', () => ({
	expectedHostCapabilitiesForNetwork: () => ({}),
}));

jest.unstable_mockModule('./node-keys', () => ({
	deriveNodeCardanoVkey: () => 'cardano-vkey',
}));

let reserveNodeForExchange: typeof import('./provisioning').reserveNodeForExchange;

const PERIODS = { contestationPeriodSeconds: 120, depositPeriodSeconds: 600, unsyncedPeriodSeconds: 300 };

beforeAll(async () => {
	({ reserveNodeForExchange } = await import('./provisioning'));
});

beforeEach(() => {
	jest.clearAllMocks();
	mockFindMany.mockResolvedValue([
		{
			id: 'host-1',
			name: 'host',
			network: Network.Preprod,
			status: 'Active',
			baseUrl: 'https://host',
			allowInsecureHttp: false,
			encryptedAdminToken: 'enc:admin-token',
			ledgerParamsHash: 'params-hash',
			exchangePort: 4600,
		},
	]);
	mockProvision.mockResolvedValue({
		nodeId: 'node-1',
		advertise: 'host:5599',
		hydraVerificationKey: 'hydra-vkey',
		cardanoVerificationKey: 'cardano-vkey-raw',
		secrets: { hydraSigningKey: 'hydra-sk', cardanoSigningKey: 'cardano-sk' },
	});
	mockFindFirst.mockResolvedValue(null);
	mockCreate.mockResolvedValue({ id: 'participant-1' });
	mockAcknowledge.mockResolvedValue(undefined);
});

describe('reserveNodeForExchange', () => {
	it('acknowledges escrow on the node it just recorded', async () => {
		await reserveNodeForExchange(Network.Preprod, 'wallet-1', 'nonce-1', PERIODS);

		expect(mockCreate).toHaveBeenCalled();
		expect(mockAcknowledge).toHaveBeenCalledWith('https://host', 'admin-token', 'node-1', expect.anything());
	});

	// The Host discloses key material exactly once, so a replayed provision
	// returns none. That path already has the keys and must still seal escrow.
	it('acknowledges escrow on a replay that reuses the participant row', async () => {
		mockFindFirst.mockResolvedValue({ id: 'participant-1' });
		mockProvision.mockResolvedValue({
			nodeId: 'node-1',
			advertise: 'host:5599',
			hydraVerificationKey: 'hydra-vkey',
			cardanoVerificationKey: 'cardano-vkey-raw',
			secrets: null,
		});

		const reserved = await reserveNodeForExchange(Network.Preprod, 'wallet-1', 'nonce-1', PERIODS);

		expect(reserved.localParticipantId).toBe('participant-1');
		expect(mockCreate).not.toHaveBeenCalled();
		expect(mockAcknowledge).toHaveBeenCalledWith('https://host', 'admin-token', 'node-1', expect.anything());
	});

	// No row and no secrets means the material exists only on the Host. Acking
	// there would seal the disclosure path on a node we could never operate.
	it('refuses, without acking, when neither the keys nor a prior row exist', async () => {
		mockProvision.mockResolvedValue({
			nodeId: 'node-1',
			advertise: 'host:5599',
			hydraVerificationKey: 'hydra-vkey',
			cardanoVerificationKey: 'cardano-vkey-raw',
			secrets: null,
		});

		await expect(reserveNodeForExchange(Network.Preprod, 'wallet-1', 'nonce-1', PERIODS)).rejects.toThrow(
			/disclosed no keys/,
		);
		expect(mockAcknowledge).not.toHaveBeenCalled();
	});
});
