import { describe, expect, it, jest } from '@jest/globals';
import type { ParticipantNodeState } from '@/services/hydra-host/node-state';

const mockReadNodeState = jest.fn<(participantId: string) => Promise<ParticipantNodeState>>();

jest.unstable_mockModule('@masumi/payment-core/auth', () => ({
	adminAuthenticatedEndpointFactory: { build: (definition: unknown) => definition },
}));
jest.unstable_mockModule('@masumi/payment-core/db', () => ({ prisma: {} }));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('@/services/hydra-host/node-state', () => ({ readParticipantNodeState: mockReadNodeState }));
jest.unstable_mockModule('@/services/hydra-head-error/record', () => ({ recordHeadError: jest.fn() }));
jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({}),
}));
jest.unstable_mockModule('@/utils/blockfrost', () => ({ getBlockfrostInstance: () => ({}) }));
jest.unstable_mockModule('@/utils/security/encryption', () => ({ decrypt: (value: string) => value }));
jest.unstable_mockModule('@/services/shared/chain-tx-lookup', () => ({ lookupConfirmedChainTx: jest.fn() }));
jest.unstable_mockModule('@/lib/hydra', () => ({
	deriveHydraVerificationKeyCborHex: () => 'local-hydra-vk',
	HydraHeadInitObservationError: class extends Error {},
	normalizeHydraVerificationKeyCborHex: (input: string) => input,
	resolveHydraInitChainAnchor: async () => null,
	verifyHydraHeadInitOnChain: jest.fn(),
}));

const { assertNodeReadyForDeposit } = await import('./index');

describe('assertNodeReadyForDeposit', () => {
	it('refuses an L1 deposit when the Host cannot confirm chain sync', async () => {
		mockReadNodeState.mockResolvedValueOnce({
			state: 'Unknown',
			isReady: true,
			reason: null,
			chainSynced: null,
			driftSeconds: null,
		});

		await expect(assertNodeReadyForDeposit('participant-1')).rejects.toMatchObject({ status: 503 });
	});

	it('allows a deposit when the Host confirms the node is ready and synced', async () => {
		mockReadNodeState.mockResolvedValueOnce({
			state: 'Running',
			isReady: true,
			reason: null,
			chainSynced: true,
			driftSeconds: 0,
		});

		await expect(assertNodeReadyForDeposit('participant-1')).resolves.toBeUndefined();
	});
});
