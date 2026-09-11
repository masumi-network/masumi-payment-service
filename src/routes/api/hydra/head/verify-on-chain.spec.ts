import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { Network } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindHead = jest.fn() as AnyMock;
const mockVerifyInit = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/auth', () => ({
	adminAuthenticatedEndpointFactory: { build: (definition: unknown) => definition },
}));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraHead: { findUnique: mockFindHead, update: jest.fn(), updateMany: jest.fn() },
		hydraHeadError: { create: jest.fn() },
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('@/services/hydra-host/node-state', () => ({
	readParticipantNodeState: jest.fn(),
}));

jest.unstable_mockModule('@/services/hydra-head-error/record', () => ({
	recordHeadError: jest.fn(),
}));

jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({}),
}));

jest.unstable_mockModule('@/utils/blockfrost', () => ({
	getBlockfrostInstance: () => ({}),
}));

jest.unstable_mockModule('@/utils/security/encryption', () => ({
	decrypt: (value: string) => value,
}));

jest.unstable_mockModule('@/services/shared/chain-tx-lookup', () => ({
	lookupConfirmedChainTx: jest.fn(),
}));

jest.unstable_mockModule('@/lib/hydra', () => ({
	deriveHydraVerificationKeyCborHex: () => 'local-hydra-vk',
	HydraHeadInitObservationError: class extends Error {},
	normalizeHydraVerificationKeyCborHex: (input: string) => input,
	resolveHydraInitChainAnchor: async () => null,
	verifyHydraHeadInitOnChain: mockVerifyInit,
}));

let verifyPersistedHydraHeadOnChain: (
	headId: string,
	options?: { allowDisabled?: boolean; persist?: boolean },
) => Promise<{ headIdentifier: string; initTxHash: string }>;

beforeAll(async () => {
	({ verifyPersistedHydraHeadOnChain } = await import('./index'));
});

const paymentSource = { network: Network.Preprod, deletedAt: null, disableSyncAt: null };

const head = {
	id: 'head-1',
	isEnabled: true,
	headIdentifier: 'a'.repeat(56),
	contestationPeriod: 43_200n,
	initChainSlot: 1n,
	Invite: { depositPeriodSeconds: 600 },
	LocalParticipant: { walletId: 'local-wallet', cardanoVkey: 'local-cardano-vk', HydraSecretKey: { hydraSK: 'sk' } },
	RemoteParticipants: [
		{ walletId: 'remote-wallet', cardanoVkey: 'remote-cardano-vk', HydraVerificationKey: { hydraVK: 'remote-vk' } },
	],
	HydraRelation: {
		network: Network.Preprod,
		localHotWalletId: 'local-wallet',
		remoteWalletId: 'remote-wallet',
		LocalHotWallet: {
			walletVkey: 'local-wallet-vk',
			deletedAt: null,
			PaymentSource: { ...paymentSource, PaymentSourceConfig: { rpcProviderApiKey: 'blockfrost-key' } },
		},
		RemoteWallet: { walletVkey: 'remote-wallet-vk', PaymentSource: paymentSource },
	},
};

beforeEach(() => {
	mockFindHead.mockReset();
	mockVerifyInit.mockReset();
	mockVerifyInit.mockResolvedValue({ initTxHash: 'b'.repeat(64), depositPeriodMilliseconds: 600_000n });
});

describe('verifyPersistedHydraHeadOnChain', () => {
	it("checks the on-chain deposit period against the head's invite", async () => {
		mockFindHead.mockResolvedValue(head);

		await verifyPersistedHydraHeadOnChain('head-1', { persist: false });

		expect(mockVerifyInit).toHaveBeenCalledTimes(1);
		expect(mockVerifyInit.mock.calls[0]![0]).toMatchObject({
			headId: head.headIdentifier,
			contestationPeriodSeconds: 43_200n,
			depositPeriodSeconds: 600n,
		});
	});

	it('leaves the deposit period unchecked for a head recorded without an invite', async () => {
		mockFindHead.mockResolvedValue({ ...head, Invite: null });

		await verifyPersistedHydraHeadOnChain('head-1', { persist: false });

		expect(mockVerifyInit.mock.calls[0]![0]).toHaveProperty('depositPeriodSeconds', undefined);
	});
});
