import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { testEndpoint } from 'express-zod-api';
import { ApiKeyStatus, HotWalletType, Network, PaymentSourceType } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindApiKey = jest.fn() as AnyMock;
const mockFindWallet = jest.fn() as AnyMock;
const mockCreateGuarded = jest.fn() as AnyMock;
const mockDeleteGuarded = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		apiKey: { findUnique: mockFindApiKey },
		hotWallet: { findFirst: mockFindWallet },
		guardedWallet: { create: mockCreateGuarded, delete: mockDeleteGuarded },
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('@opentelemetry/api', () => ({
	trace: { getActiveSpan: jest.fn(() => null) },
}));

const { deleteWalletGuardEndpointDelete, postWalletGuardEndpointPost, postWalletGuardReadTokenEndpointPost } =
	await import('./guard');
const { deriveSmartWalletScript } = await import('@masumi/payment-source-v2/smart-wallet/wallet-lifecycle');

const NODE_TOKEN = 'node-token-secret';
const ESCROW_ADDRESS = 'addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g';
const EXCHAIN_WALLET_ID = 'wal_01J9XK3M4N5P6Q7R8S9T0V1W2Z';
const agentKeyHash = '55'.repeat(28);
const ownerKeyHash = '11'.repeat(28);
const quorumKeyHashes = ['22'.repeat(28), '33'.repeat(28), '44'.repeat(28)];
const script = deriveSmartWalletScript({
	owner: ownerKeyHash,
	stakeKeyHash: null,
	quorumVkhs: quorumKeyHashes,
	threshold: 2,
	network: 'preprod',
});

const asApiKey = (canAdmin: boolean) => ({
	id: 'api-key-1',
	canRead: true,
	canPay: true,
	canAdmin,
	status: ApiKeyStatus.Active,
	token: null,
	tokenHash: null,
	tokenHashSecure: 'pbkdf2-placeholder',
	usageLimited: !canAdmin,
	networkLimit: canAdmin ? [] : [Network.Preprod],
	walletScopeEnabled: false,
	WalletScopes: [],
});

const hotWallet = (overrides: Record<string, unknown> = {}) => ({
	id: 'wallet-1',
	walletVkey: agentKeyHash,
	type: HotWalletType.Purchasing,
	lockedAt: null,
	pendingTransactionId: null,
	GuardedWallet: null,
	PaymentSource: {
		network: Network.Preprod,
		paymentSourceType: PaymentSourceType.Web3CardanoV2,
		smartContractAddress: ESCROW_ADDRESS,
	},
	...overrides,
});

const guardBody = (overrides: Record<string, unknown> = {}) => ({
	walletId: 'wallet-1',
	walletAddress: script.address,
	stateToken: `${script.policyId}.${'cd'.repeat(32)}`,
	ownerKeyHash,
	agentKeyHash,
	quorumKeyHashes,
	quorumThreshold: 2,
	cosignBaseUrl: 'https://cosign.test',
	nodeId: 'node-1',
	orgId: 'org-1',
	template: 'enterprise-pilot',
	params: {
		perTxCap: '200000000',
		daily: '8000000000',
		perSeller: '8000000000',
		perAgent: '8000000000',
		envelope: '200000000000',
		burstPerMinute: 10,
	},
	...overrides,
});

const storedGuarded = {
	id: 'guarded-1',
	hotWalletId: 'wallet-1',
	walletAddress: script.address,
	stateToken: `${script.policyId}.${'cd'.repeat(32)}`,
	scriptHash: script.policyId,
	ownerKeyHash,
	quorumKeyHashes,
	quorumThreshold: 2,
	cosignBaseUrl: 'https://cosign.test',
	cosignTokenRef: 'EXCHAIN_COSIGN_API_KEY',
	exchainWalletId: EXCHAIN_WALLET_ID,
	nodeId: 'node-1',
	orgId: 'org-1',
	registeredAt: new Date('2026-09-18T12:00:00.000Z'),
};

let mockFetch: AnyMock;

const post = (body: Record<string, unknown>) =>
	testEndpoint({
		endpoint: postWalletGuardEndpointPost,
		requestProps: { method: 'POST', body, headers: { token: 'valid' } },
	});

beforeEach(() => {
	jest.clearAllMocks();
	process.env.EXCHAIN_COSIGN_API_KEY = NODE_TOKEN;
	mockFindApiKey.mockResolvedValue(asApiKey(true));
	mockFindWallet.mockResolvedValue(hotWallet());
	mockCreateGuarded.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
		...storedGuarded,
		...data,
	}));
	mockFetch = jest.fn(
		async () =>
			new Response(
				JSON.stringify({ walletId: EXCHAIN_WALLET_ID, mandateEnglish: 'No single payment above 200 ADA.' }),
				{
					status: 201,
				},
			),
	) as AnyMock;
	globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
	delete process.env.EXCHAIN_COSIGN_API_KEY;
});

describe('postWalletGuardEndpointPost', () => {
	it('registers the wallet with Exchain and stores a reference to the token, never the token', async () => {
		const { responseMock } = await post(guardBody());

		expect(responseMock.statusCode).toBe(200);
		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://cosign.test/v1/wallets');
		expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${NODE_TOKEN}`);
		expect(JSON.parse(String(init.body))).toMatchObject({
			walletAddress: script.address,
			agentKeyHashes: [agentKeyHash],
			quorumKeyHashes,
			quorumThreshold: 2,
			escrowAddresses: [ESCROW_ADDRESS],
			governedAsset: { id: 'lovelace', decimals: 6 },
			constitution: { template: 'enterprise-pilot' },
			network: 'preprod',
			nodeId: 'node-1',
			orgId: 'org-1',
			registryGate: true,
		});

		const stored = (mockCreateGuarded.mock.calls[0][0] as { data: Record<string, unknown> }).data;
		expect(stored).toMatchObject({
			hotWalletId: 'wallet-1',
			scriptHash: script.policyId,
			exchainWalletId: EXCHAIN_WALLET_ID,
			cosignTokenRef: 'EXCHAIN_COSIGN_API_KEY',
		});
		expect(JSON.stringify(stored)).not.toContain(NODE_TOKEN);
		expect(JSON.stringify(responseMock._getJSONData())).not.toContain(NODE_TOKEN);
		expect(responseMock._getJSONData().data).toMatchObject({
			walletId: 'wallet-1',
			exchainWalletId: EXCHAIN_WALLET_ID,
			mandateEnglish: 'No single payment above 200 ADA.',
		});
	});

	it.each([
		['a zero threshold', guardBody({ quorumThreshold: 0 }), {}],
		['a threshold above the distinct quorum keys', guardBody({ quorumThreshold: 4 }), {}],
		['a selling wallet', guardBody(), { type: HotWalletType.Selling }],
		['an agent key that is not the wallet key', guardBody({ agentKeyHash: '66'.repeat(28) }), {}],
		['mint facts that do not derive the address', guardBody({ ownerKeyHash: '77'.repeat(28) }), {}],
		['a token reference outside EXCHAIN_COSIGN_API_KEY*', guardBody({ cosignTokenRef: 'ENCRYPTION_KEY' }), {}],
	])('rejects %s without calling Exchain', async (_label, body, walletOverrides) => {
		mockFindWallet.mockResolvedValue(hotWallet(walletOverrides));

		const { responseMock } = await post(body);

		expect(responseMock.statusCode).toBe(400);
		expect(mockFetch).not.toHaveBeenCalled();
		expect(mockCreateGuarded).not.toHaveBeenCalled();
	});

	it('rejects a key without admin access', async () => {
		mockFindApiKey.mockResolvedValue(asApiKey(false));

		const { responseMock } = await post(guardBody());

		expect(responseMock.statusCode).toBe(401);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it('answers 409 and stores nothing when Exchain knows the wallet with a different mandate', async () => {
		mockFetch.mockResolvedValue(new Response(JSON.stringify({ error: 'wallet_exists' }), { status: 409 }));

		const { responseMock } = await post(guardBody());

		expect(responseMock.statusCode).toBe(409);
		expect(mockCreateGuarded).not.toHaveBeenCalled();
	});
});

describe('deleteWalletGuardEndpointDelete', () => {
	it('removes the local record only', async () => {
		mockFindWallet.mockResolvedValue(hotWallet({ GuardedWallet: storedGuarded }));
		mockDeleteGuarded.mockResolvedValue(storedGuarded);

		const { responseMock } = await testEndpoint({
			endpoint: deleteWalletGuardEndpointDelete,
			requestProps: { method: 'DELETE', query: { walletId: 'wallet-1' }, headers: { token: 'valid' } },
		});

		expect(responseMock.statusCode).toBe(200);
		expect(mockDeleteGuarded).toHaveBeenCalledWith({ where: { id: 'guarded-1' } });
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it('refuses while the wallet is funding a batch', async () => {
		mockFindWallet.mockResolvedValue(hotWallet({ GuardedWallet: storedGuarded, lockedAt: new Date() }));

		const { responseMock } = await testEndpoint({
			endpoint: deleteWalletGuardEndpointDelete,
			requestProps: { method: 'DELETE', query: { walletId: 'wallet-1' }, headers: { token: 'valid' } },
		});

		expect(responseMock.statusCode).toBe(409);
		expect(mockDeleteGuarded).not.toHaveBeenCalled();
	});
});

describe('postWalletGuardReadTokenEndpointPost', () => {
	it('returns the hosted page URL with a wallet-scoped read token, not the node token', async () => {
		mockFindWallet.mockResolvedValue(hotWallet({ GuardedWallet: storedGuarded }));
		mockFetch.mockResolvedValue(
			new Response(JSON.stringify({ token: 'read-token', expiresAt: '2026-09-18T12:15:00Z' }), { status: 201 }),
		);

		const { responseMock } = await testEndpoint({
			endpoint: postWalletGuardReadTokenEndpointPost,
			requestProps: { method: 'POST', body: { walletId: 'wallet-1' }, headers: { token: 'valid' } },
		});

		expect(responseMock.statusCode).toBe(200);
		expect((mockFetch.mock.calls[0] as [string])[0]).toBe(
			`https://cosign.test/v1/wallets/${EXCHAIN_WALLET_ID}/read-token`,
		);
		expect(responseMock._getJSONData().data).toEqual({
			url: `https://cosign.test/protected/${EXCHAIN_WALLET_ID}?t=read-token`,
			expiresAt: '2026-09-18T12:15:00Z',
		});
		expect(JSON.stringify(responseMock._getJSONData())).not.toContain(NODE_TOKEN);
	});
});
