import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { testEndpoint } from 'express-zod-api';
import { ApiKeyStatus, Network, RegistrationState } from '@/generated/prisma/enums';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindApiKey = jest.fn() as AnyMock;
const mockFindSellingWallet = jest.fn() as AnyMock;
const mockFindRecipientWallet = jest.fn() as AnyMock;
const mockCreateInboxAgentRegistrationRequest = jest.fn() as AnyMock;

jest.unstable_mockModule('@/utils/db', () => ({
	prisma: {
		apiKey: {
			findUnique: mockFindApiKey,
		},
		hotWallet: {
			findUnique: mockFindSellingWallet,
			findFirst: mockFindRecipientWallet,
		},
		inboxAgentRegistrationRequest: {
			create: mockCreateInboxAgentRegistrationRequest,
			count: jest.fn(),
			findUnique: jest.fn(),
			delete: jest.fn(),
		},
	},
}));

jest.unstable_mockModule('@/utils/config', () => ({
	CONFIG: {
		ENCRYPTION_KEY: '12345678901234567890',
	},
	DEFAULTS: {
		DEFAULT_METADATA_VERSION: 1,
	},
	SERVICE_CONSTANTS: {
		SMART_CONTRACT: {
			collateralAmount: '5000000',
		},
	},
}));

jest.unstable_mockModule('@/utils/logger', () => ({
	logger: {
		info: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
		debug: jest.fn(),
	},
}));

jest.unstable_mockModule('@/utils/metrics', () => ({
	recordBusinessEndpointError: jest.fn(),
}));

jest.unstable_mockModule('@/generated/prisma/client', async () => await import('@/generated/prisma/enums'));

const { registerInboxAgentPost } = await import('./index');

function asApiKey(walletScopeIds: string[] | null = null) {
	return {
		id: 'api-key-1',
		canRead: true,
		canPay: true,
		canAdmin: walletScopeIds == null,
		status: ApiKeyStatus.Active,
		token: null,
		tokenHash: null,
		usageLimited: false,
		networkLimit: walletScopeIds == null ? [] : [Network.Preprod],
		walletScopeEnabled: walletScopeIds != null,
		WalletScopes: (walletScopeIds ?? []).map((hotWalletId) => ({ hotWalletId })),
	};
}

function buildSellingWallet() {
	return {
		id: 'selling-wallet-id',
		paymentSourceId: 'payment-source-1',
		walletVkey: 'selling-wallet-vkey',
		walletAddress: 'addr_test1sellingwallet',
		PaymentSource: {
			PaymentSourceConfig: {
				rpcProviderApiKey: 'provider-key',
			},
		},
	};
}

function buildInboxRequestResponse(
	recipientWallet: { walletVkey: string; walletAddress: string } | null,
	sendFundingLovelace: bigint | null = null,
) {
	return {
		id: 'inbox-request-1',
		error: null,
		name: 'Inbox Agent',
		description: 'Inbox description',
		agentSlug: 'inbox-agent',
		state: RegistrationState.RegistrationRequested,
		createdAt: new Date('2026-04-12T10:00:00.000Z'),
		updatedAt: new Date('2026-04-12T10:00:00.000Z'),
		lastCheckedAt: null,
		agentIdentifier: null,
		metadataVersion: 1,
		sendFundingLovelace,
		SmartContractWallet: {
			walletVkey: 'selling-wallet-vkey',
			walletAddress: 'addr_test1sellingwallet',
		},
		RecipientWallet: recipientWallet,
		CurrentTransaction: null,
	};
}

describe('registerInboxAgentPost', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockFindApiKey.mockResolvedValue(asApiKey());
		mockFindSellingWallet.mockResolvedValue(buildSellingWallet());
		mockFindRecipientWallet.mockResolvedValue(null);
		mockCreateInboxAgentRegistrationRequest.mockResolvedValue(buildInboxRequestResponse(null));
	});

	it('keeps the current flow when no recipient wallet is provided', async () => {
		const { responseMock } = await testEndpoint({
			endpoint: registerInboxAgentPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					network: Network.Preprod,
					sellingWalletVkey: 'selling-wallet-vkey',
					name: 'Inbox Agent',
					description: 'Inbox description',
					agentSlug: 'inbox-agent',
				},
			},
		});

		expect(responseMock.statusCode).toBe(200);
		expect(mockFindRecipientWallet).not.toHaveBeenCalled();
		expect(mockCreateInboxAgentRegistrationRequest.mock.calls[0]?.[0]?.data?.RecipientWallet).toBeUndefined();
		expect(mockCreateInboxAgentRegistrationRequest.mock.calls[0]?.[0]?.data?.sendFundingLovelace).toBeUndefined();
		expect(responseMock._getJSONData().data.RecipientWallet).toBeNull();
		expect(responseMock._getJSONData().data.sendFundingLovelace).toBeNull();
	});

	it('stores a managed recipient wallet override when provided', async () => {
		mockFindRecipientWallet.mockResolvedValue({
			id: 'recipient-wallet-id',
			walletVkey: 'recipient-wallet-vkey',
			walletAddress: 'addr_test1recipientwallet',
		});
		mockCreateInboxAgentRegistrationRequest.mockResolvedValue(
			buildInboxRequestResponse({
				walletVkey: 'recipient-wallet-vkey',
				walletAddress: 'addr_test1recipientwallet',
			}),
		);

		const { responseMock } = await testEndpoint({
			endpoint: registerInboxAgentPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					network: Network.Preprod,
					sellingWalletVkey: 'selling-wallet-vkey',
					recipientWalletAddress: 'addr_test1recipientwallet',
					name: 'Inbox Agent',
					description: 'Inbox description',
					agentSlug: 'inbox-agent',
				},
			},
		});

		expect(responseMock.statusCode).toBe(200);
		expect(mockFindRecipientWallet).toHaveBeenCalledWith({
			where: {
				walletAddress: 'addr_test1recipientwallet',
				paymentSourceId: 'payment-source-1',
				deletedAt: null,
			},
			select: {
				id: true,
				walletVkey: true,
				walletAddress: true,
			},
		});
		expect(mockCreateInboxAgentRegistrationRequest.mock.calls[0]?.[0]?.data?.RecipientWallet).toEqual({
			connect: {
				id: 'recipient-wallet-id',
			},
		});
		expect(responseMock._getJSONData().data.RecipientWallet).toEqual({
			walletVkey: 'recipient-wallet-vkey',
			walletAddress: 'addr_test1recipientwallet',
		});
	});

	it('stores a normalized send funding lovelace override when provided', async () => {
		mockCreateInboxAgentRegistrationRequest.mockResolvedValue(
			buildInboxRequestResponse(null, BigInt(5_000_000)),
		);

		const { responseMock } = await testEndpoint({
			endpoint: registerInboxAgentPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					network: Network.Preprod,
					sellingWalletVkey: 'selling-wallet-vkey',
					sendFundingLovelace: '2000000',
					name: 'Inbox Agent',
					description: 'Inbox description',
					agentSlug: 'inbox-agent',
				},
			},
		});

		expect(responseMock.statusCode).toBe(200);
		expect(mockCreateInboxAgentRegistrationRequest.mock.calls[0]?.[0]?.data?.sendFundingLovelace).toBe(
			BigInt(5_000_000),
		);
		expect(responseMock._getJSONData().data.sendFundingLovelace).toBe('5000000');
	});

	it('rejects non-canonical inbox slugs', async () => {
		const { responseMock } = await testEndpoint({
			endpoint: registerInboxAgentPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					network: Network.Preprod,
					sellingWalletVkey: 'selling-wallet-vkey',
					name: 'Inbox Agent',
					description: 'Inbox description',
					agentSlug: 'Inbox Agent',
				},
			},
		});

		expect(responseMock.statusCode).toBe(400);
		expect(mockCreateInboxAgentRegistrationRequest).not.toHaveBeenCalled();
	});
});
