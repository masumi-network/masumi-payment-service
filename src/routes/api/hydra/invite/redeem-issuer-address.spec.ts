import { beforeEach, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { testEndpoint } from 'express-zod-api';
import { ApiKeyStatus } from '@/generated/prisma/client';
import { encodeInviteCode } from '@/services/hydra-invite/invite-code';

const redeem = jest.fn<() => Promise<{ inviteId: string; hydraHeadId: string; issuerWalletAddress: string }>>();

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		apiKey: {
			findUnique: async () => ({
				id: 'admin-key',
				status: ApiKeyStatus.Active,
				canRead: true,
				canPay: true,
				canAdmin: true,
				usageLimited: false,
				networkLimit: [],
				WalletScopes: [],
				X402WalletScopes: [],
			}),
		},
	},
}));
jest.unstable_mockModule('@/services/hydra-invite/orchestrator', () => ({
	createHeadFromExchange: jest.fn(),
	mintHeadInvite: jest.fn(),
	redeemHeadInvite: redeem,
}));

const { redeemInvitePost } = await import('./index');
const code = encodeInviteCode({
	payload: {
		nonce: 'nonce123456',
		expiresAt: '1785600000000',
		network: 'Preprod',
		issuerWalletAddress: 'addr_test1issuer',
		issuerWalletRole: 'Seller',
		hydraVerificationKey: 'hvk',
		cardanoVerificationKey: '5820' + 'ab'.repeat(32),
		advertise: 'them.example.com:5101',
		exchangeUrl: 'https://them.example.com:8444/exchange',
		contestationPeriodSeconds: 220,
		depositPeriodSeconds: 300,
		unsyncedPeriodSeconds: 1800,
		ledgerParamsHash: 'sha256:abc',
	},
	signature: { signature: 'sig', key: 'key' },
});

const request = (expectedIssuerWalletAddress?: string) =>
	testEndpoint({
		endpoint: redeemInvitePost,
		requestProps: {
			method: 'POST',
			headers: { token: 'admin-key' },
			body: { code, hotWalletId: 'wallet', expectedIssuerWalletAddress },
		},
		responseOptions: { eventEmitter: EventEmitter },
	});

beforeEach(() => {
	jest.clearAllMocks();
	redeem.mockResolvedValue({ inviteId: 'invite', hydraHeadId: 'head', issuerWalletAddress: 'addr_test1issuer' });
});

it.each([
	['a missing address', undefined],
	['a different address', 'addr_test1other'],
])('refuses %s before any redeem or node provisioning', async (_description, expectedAddress) => {
	const { responseMock } = await request(expectedAddress);
	expect(responseMock.statusCode).toBe(400);
	expect(redeem).not.toHaveBeenCalled();
});

it('passes an exact address match to the redeem path', async () => {
	const { responseMock } = await request('addr_test1issuer');
	expect(responseMock.statusCode).toBe(200);
	expect(redeem).toHaveBeenCalledTimes(1);
});
