import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { testEndpoint } from 'express-zod-api';
import { ApiKeyStatus, Network, RegistrationState } from '@/generated/prisma/enums';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindApiKey = jest.fn() as AnyMock;
const mockFindPaymentSource = jest.fn() as AnyMock;
const mockFindInboxRequest = jest.fn() as AnyMock;
const mockUpdateInboxRequest = jest.fn() as AnyMock;
const mockAssetsAddresses = jest.fn() as AnyMock;
const mockResolvePaymentKeyHash = jest.fn() as AnyMock;
const mockGetRegistryScript = jest.fn() as AnyMock;

const txClient = {
	inboxAgentRegistrationRequest: {
		findUnique: mockFindInboxRequest,
		update: mockUpdateInboxRequest,
	},
};

// `unregisterInboxAgentPost` now wraps its update in a Serializable `$transaction`
// (with an in-tx state re-read) to close the TOCTOU window and block deregisters
// on rows mid-flight in another lifecycle action. Stub the helper so the handler
// runs once against a `tx` exposing the same inbox mocks.
const mockTransaction = jest.fn(async (arg: unknown) => {
	if (typeof arg === 'function') {
		return await (arg as (tx: typeof txClient) => Promise<unknown>)(txClient);
	}
	return arg;
}) as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		apiKey: {
			findUnique: mockFindApiKey,
		},
		paymentSource: {
			findUnique: mockFindPaymentSource,
		},
		inboxAgentRegistrationRequest: {
			findUnique: mockFindInboxRequest,
			update: mockUpdateInboxRequest,
		},
		$transaction: mockTransaction,
	},
}));

jest.unstable_mockModule('@masumi/payment-core/config', () => ({
	CONFIG: {
		ENCRYPTION_KEY: '12345678901234567890',
	},
	DEFAULTS: {
		PAYMENT_SMART_CONTRACT_ADDRESS_MAINNET: 'addr1default',
		PAYMENT_SMART_CONTRACT_ADDRESS_PREPROD: 'addr_test1default',
	},
	SERVICE_CONSTANTS: {
		SMART_CONTRACT: {
			collateralAmount: '5000000',
		},
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: {
		info: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
		debug: jest.fn(),
	},
}));

jest.unstable_mockModule('@/utils/blockfrost', () => ({
	getBlockfrostInstance: jest.fn(() => ({
		assetsAddresses: mockAssetsAddresses,
	})),
}));

jest.unstable_mockModule('@/utils/generator/contract-generator', () => ({
	getRegistryScriptFromNetworkHandler: mockGetRegistryScript,
	getRegistryScriptFromNetworkHandlerV1: mockGetRegistryScript,
}));

jest.unstable_mockModule('@meshsdk/core-cst', () => ({
	resolvePaymentKeyHash: mockResolvePaymentKeyHash,
	// Stubs for all named exports required by @meshsdk/core → @meshsdk/transaction → @meshsdk/core-cst
	Address: jest.fn(),
	AddressType: {},
	Bip32PrivateKey: jest.fn(),
	Cardano: {},
	CardanoSDKSerializer: {},
	CardanoSDKUtil: {},
	CredentialType: {},
	Crypto: {},
	DRep: jest.fn(),
	Ed25519KeyHashHex: jest.fn(),
	Ed25519PublicKey: jest.fn(),
	Ed25519PublicKeyHex: jest.fn(),
	Hash28ByteBase16: jest.fn(),
	HexBlob: jest.fn(),
	NativeScript: jest.fn(),
	PlutusV1Script: jest.fn(),
	PlutusV2Script: jest.fn(),
	PlutusV3Script: jest.fn(),
	PoolId: jest.fn(),
	Script: jest.fn(),
	Serialization: jest.fn(),
	Transaction: jest.fn(),
	TransactionId: jest.fn(),
	TransactionInput: jest.fn(),
	TransactionUnspentOutput: jest.fn(),
	TransactionWitnessSet: jest.fn(),
	VkeyWitness: jest.fn(),
	VrfVkBech32: jest.fn(),
	addressToBech32: jest.fn(),
	buildBaseAddress: jest.fn(),
	buildBip32PrivateKey: jest.fn(),
	buildDRepID: jest.fn(),
	buildEnterpriseAddress: jest.fn(),
	buildKeys: jest.fn(),
	buildRewardAddress: jest.fn(),
	buildScriptPubkey: jest.fn(),
	checkSignature: jest.fn(),
	deserializeAddress: jest.fn(),
	deserializeEd25519KeyHash: jest.fn(),
	deserializeNativeScript: jest.fn(),
	deserializePlutusScript: jest.fn(),
	deserializeTx: jest.fn(),
	deserializeTxHash: jest.fn(),
	deserializeTxUnspentOutput: jest.fn(),
	deserializeValue: jest.fn(),
	fromBuilderToPlutusData: jest.fn(),
	fromNativeScript: jest.fn(),
	fromScriptRef: jest.fn(),
	fromTxUnspentOutput: jest.fn(),
	fromValue: jest.fn(),
	generateNonce: jest.fn(),
	hexToBech32: jest.fn(),
	normalizePlutusScript: jest.fn(),
	resolvePrivateKey: jest.fn(),
	resolveRewardAddress: jest.fn(),
	resolveTxHash: jest.fn(),
	signData: jest.fn(),
	toAddress: jest.fn(),
	toDRep: jest.fn(),
	toNativeScript: jest.fn(),
	toScriptRef: jest.fn(),
	toTxUnspentOutput: jest.fn(),
}));

jest.unstable_mockModule('@/generated/prisma/client', async () => await import('@/generated/prisma/enums'));

const { unregisterInboxAgentPost } = await import('./index');

function asApiKey({ id = 'api-key-1', canAdmin = true }: { id?: string; canAdmin?: boolean } = {}) {
	return {
		id,
		canRead: true,
		canPay: true,
		canAdmin,
		status: ApiKeyStatus.Active,
		token: null,
		tokenHash: null,
		usageLimited: false,
		networkLimit: canAdmin ? [] : [Network.Preprod],
		walletScopeEnabled: false,
		WalletScopes: [],
	};
}

function buildInboxUpdateResponse() {
	return {
		id: 'inbox-request-1',
		error: null,
		name: 'Inbox Agent',
		description: 'Inbox description',
		agentSlug: 'inbox-agent',
		state: RegistrationState.DeregistrationRequested,
		createdAt: new Date('2026-04-12T10:00:00.000Z'),
		updatedAt: new Date('2026-04-12T10:00:00.000Z'),
		lastCheckedAt: null,
		agentIdentifier: 'p'.repeat(56) + 'asset',
		metadataVersion: 1,
		sendFundingLovelace: BigInt(7_500_000),
		SmartContractWallet: {
			walletVkey: 'selling-wallet-vkey',
			walletAddress: 'addr_test1sellingwallet',
		},
		RecipientWallet: {
			walletVkey: 'recipient-wallet-vkey',
			walletAddress: 'addr_test1recipientwallet',
		},
		CurrentTransaction: null,
	};
}

describe('unregisterInboxAgentPost', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockFindApiKey.mockResolvedValue(asApiKey());
		mockGetRegistryScript.mockResolvedValue({ policyId: 'p'.repeat(56) });
		mockResolvePaymentKeyHash.mockImplementation((address: string) => {
			if (address === 'addr_test1recipientwallet') {
				return 'recipient-wallet-vkey';
			}
			return 'unknown-wallet-vkey';
		});
		mockAssetsAddresses.mockResolvedValue([
			{
				address: 'addr_test1recipientwallet',
				quantity: '1',
			},
		]);
		mockFindPaymentSource.mockResolvedValue({
			id: 'payment-source-1',
			network: Network.Preprod,
			PaymentSourceConfig: {
				rpcProviderApiKey: 'provider-key',
			},
			HotWallets: [
				{
					id: 'selling-wallet-id',
					walletVkey: 'selling-wallet-vkey',
					walletAddress: 'addr_test1sellingwallet',
				},
				{
					id: 'recipient-wallet-id',
					walletVkey: 'recipient-wallet-vkey',
					walletAddress: 'addr_test1recipientwallet',
				},
			],
		});
		// Includes `state` because the route now re-reads the row inside a
		// Serializable transaction and rejects deregisters unless the current
		// state is one that may be deregistered.
		mockFindInboxRequest.mockResolvedValue({
			id: 'inbox-request-1',
			state: RegistrationState.RegistrationConfirmed,
		});
		mockUpdateInboxRequest.mockResolvedValue(buildInboxUpdateResponse());
	});

	it('uses the current managed holder wallet for inbox deregistration requests', async () => {
		const { responseMock } = await testEndpoint({
			endpoint: unregisterInboxAgentPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					agentIdentifier: 'p'.repeat(56) + 'asset',
					network: Network.Preprod,
				},
			},
		});

		expect(responseMock.statusCode).toBe(200);
		expect(mockUpdateInboxRequest.mock.calls[0]?.[0]?.data).toEqual({
			state: RegistrationState.DeregistrationRequested,
			deregistrationHotWalletId: 'recipient-wallet-id',
		});
		expect(responseMock._getJSONData().data.RecipientWallet).toEqual({
			walletVkey: 'recipient-wallet-vkey',
			walletAddress: 'addr_test1recipientwallet',
		});
		expect(responseMock._getJSONData().data.sendFundingLovelace).toBe('7500000');
	});

	it('rejects non-admin deregistration for inbox rows owned by another API key', async () => {
		mockFindApiKey.mockResolvedValue(asApiKey({ canAdmin: false }));
		mockFindInboxRequest.mockResolvedValue({
			id: 'inbox-request-1',
			requestedById: 'other-api-key',
		});

		const { responseMock } = await testEndpoint({
			endpoint: unregisterInboxAgentPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					agentIdentifier: 'p'.repeat(56) + 'asset',
					network: Network.Preprod,
				},
			},
		});

		expect(responseMock.statusCode).toBe(403);
		expect(mockUpdateInboxRequest).not.toHaveBeenCalled();
	});

	it('returns 409 when the registration is in a non-deregisterable state', async () => {
		// The in-transaction re-read reports a mid-flight lifecycle state. Only
		// RegistrationConfirmed / DeregistrationFailed may be deregistered; anything
		// else must 409 so a deregister can't race the register/deregister schedulers.
		mockFindInboxRequest.mockResolvedValue({
			id: 'inbox-request-1',
			state: RegistrationState.DeregistrationInitiated,
		});

		const { responseMock } = await testEndpoint({
			endpoint: unregisterInboxAgentPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					agentIdentifier: 'p'.repeat(56) + 'asset',
					network: Network.Preprod,
				},
			},
		});

		expect(responseMock.statusCode).toBe(409);
		expect(mockUpdateInboxRequest).not.toHaveBeenCalled();
	});

	it('returns 409 when the asset is no longer held by a managed wallet', async () => {
		mockFindPaymentSource.mockResolvedValue({
			id: 'payment-source-1',
			network: Network.Preprod,
			PaymentSourceConfig: {
				rpcProviderApiKey: 'provider-key',
			},
			HotWallets: [
				{
					id: 'selling-wallet-id',
					walletVkey: 'selling-wallet-vkey',
					walletAddress: 'addr_test1sellingwallet',
				},
			],
		});

		const { responseMock } = await testEndpoint({
			endpoint: unregisterInboxAgentPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					agentIdentifier: 'p'.repeat(56) + 'asset',
					network: Network.Preprod,
				},
			},
		});

		expect(responseMock.statusCode).toBe(409);
		expect(mockUpdateInboxRequest).not.toHaveBeenCalled();
	});
});
