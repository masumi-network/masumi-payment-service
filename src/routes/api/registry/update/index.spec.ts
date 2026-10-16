import { jest } from '@jest/globals';
import { Network, PaymentSourceType, RegistryEntryType } from '@/generated/prisma/enums';
import type { AuthContext } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';

const mockRegistryFindUnique = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockBlockfrost = jest.fn();
const mockTransaction = jest.fn();
const POLICY_ID = 'a'.repeat(56);

jest.unstable_mockModule('@masumi/payment-core/auth', () => ({
	payAuthenticatedEndpointFactory: { build: (definition: object) => definition },
	checkIsAllowedNetworkOrThrowUnauthorized: jest.fn(),
}));
jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		paymentSource: {
			findFirst: async () => ({
				id: 'source',
				paymentSourceType: PaymentSourceType.Web3CardanoV2,
				PaymentSourceConfig: { rpcProviderApiKey: 'test-provider' },
				HotWallets: [],
			}),
		},
		registryRequest: { findUnique: mockRegistryFindUnique },
		$transaction: mockTransaction,
	},
}));
jest.unstable_mockModule('@/utils/generator/contract-generator', () => ({
	getRegistryScriptFromNetworkHandlerV2: async () => ({ policyId: POLICY_ID }),
}));
jest.unstable_mockModule('@/utils/blockfrost', () => ({
	getBlockfrostInstance: mockBlockfrost,
	validateAssetsOnChain: jest.fn(),
}));
jest.unstable_mockModule('@masumi/payment-core/metrics', () => ({ recordBusinessEndpointError: jest.fn() }));
jest.unstable_mockModule('@/routes/api/registry', () => ({
	registerAgentSchemaInput: z.object({ sellingWalletVkey: z.string() }),
	registryRequestOutputSchema: z.object({}),
}));

const { updateAgentPost } = await import('./index');
const endpoint = updateAgentPost as unknown as {
	handler: (args: { input: object; ctx: AuthContext }) => Promise<unknown>;
};

describe('stored registry type update guard', () => {
	beforeEach(() => jest.clearAllMocks());

	it.each([RegistryEntryType.A2A, RegistryEntryType.OpenApi, RegistryEntryType.X402])(
		'rejects stored %s when the request omits type, before any chain request or write',
		async (type) => {
			mockRegistryFindUnique.mockResolvedValue({ id: 'registration', paymentSourceId: 'source', type });
			await expect(
				endpoint.handler({
					input: { network: Network.Preprod, agentIdentifier: POLICY_ID + '01' },
					ctx: { networkLimit: [], id: 'key' } as unknown as AuthContext,
				}),
			).rejects.toMatchObject({ status: 400, message: 'Updating OpenApi/X402/A2A agents is not yet supported' });
			expect(mockBlockfrost).not.toHaveBeenCalled();
			expect(mockTransaction).not.toHaveBeenCalled();
		},
	);
});
