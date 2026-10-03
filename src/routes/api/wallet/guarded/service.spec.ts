import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { HotWalletType, Network, PaymentSourceType } from '@/generated/prisma/client';

type AsyncFn = (...args: never[]) => Promise<unknown>;
const mockFindFirst = jest.fn<AsyncFn>();
const mockCreate = jest.fn<(args: { data: Record<string, unknown> }) => Promise<unknown>>();
const mockDelete = jest.fn<(args: unknown) => Promise<unknown>>();
const mockUpdateMany = jest.fn<(args: unknown) => Promise<{ count: number }>>();
const mockInspect = jest.fn<(params: unknown, rpcApiKey: string) => Promise<unknown>>();
const mockRegister = jest.fn<(args: Record<string, unknown>) => Promise<unknown>>();
const config = {
	EXCHAIN_COSIGN_URL: 'https://cosign.example' as string | null,
	EXCHAIN_NODE_TOKEN: 'token' as string | null,
	EXCHAIN_NODE_ID: 'node',
	EXCHAIN_ORG_ID: 'org',
};

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hotWallet: { findFirst: mockFindFirst },
		guardedWallet: { create: mockCreate, delete: mockDelete },
		$transaction: (run: (tx: unknown) => Promise<unknown>) =>
			run({ hotWallet: { updateMany: mockUpdateMany }, guardedWallet: { create: mockCreate } }),
	},
}));
jest.unstable_mockModule('@masumi/payment-core/db-retry', () => ({
	retryOnSerializationConflict: (run: () => Promise<unknown>) => run(),
}));
jest.unstable_mockModule('@masumi/payment-core/config', () => ({ CONFIG: config }));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('@masumi/payment-source-v2/smart-wallet/guarded-wallet', () => ({
	ExchainRegistrationError: class extends Error {},
	inspectGuardedWallet: mockInspect,
	registerGuardedWalletWithExchain: mockRegister,
}));

const { attachGuardedWallet, detachGuardedWallet } = await import('./service');

const AGENT = 'a'.repeat(56);
const scope = { networkLimit: [Network.Preprod], walletScopeIds: null };
const input = {
	hotWalletId: 'hw-1',
	ownerAddress: 'addr_test1owner',
	quorumVkhs: ['1'.repeat(56), '2'.repeat(56)],
	threshold: 2,
	stateTokenName: 'b'.repeat(64),
};
const mandate = {
	perTxCap: '50000000',
	daily: '1000000000',
	perSeller: '200000000',
	perAgent: '500000000',
	envelope: '50000000000',
	burstPerMinute: 10,
};

function hotWallet(overrides: Record<string, unknown> = {}) {
	return {
		id: 'hw-1',
		type: HotWalletType.Purchasing,
		walletVkey: AGENT,
		lockedAt: null,
		pendingTransactionId: null,
		GuardedWallet: null,
		PaymentSource: {
			network: Network.Preprod,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
			smartContractAddress: 'addr_test1escrow',
			PaymentSourceConfig: { rpcProviderApiKey: 'preprodKey' },
		},
		...overrides,
	};
}

beforeEach(() => {
	jest.clearAllMocks();
	mockFindFirst.mockResolvedValue(hotWallet());
	mockInspect.mockResolvedValue({
		scriptAddress: 'addr_test1script',
		policyId: 'c'.repeat(56),
		agentVkh: AGENT,
		periodLimitLovelace: 1_000_000_000n,
	});
	mockUpdateMany.mockResolvedValue({ count: 1 });
	mockCreate.mockImplementation(({ data }) => Promise.resolve({ id: 'gw-1', ...data }));
	mockRegister.mockResolvedValue({ walletId: 'wal_01M3P5ZM0EP8R4NCQWS7TBWZFZ', mandateEnglish: 'up to 50 ADA' });
});

describe('attachGuardedWallet', () => {
	it('stores the script it verified on chain', async () => {
		const record = await attachGuardedWallet(input, scope);
		expect(mockInspect).toHaveBeenCalledWith(expect.objectContaining({ network: 'preprod' }), 'preprodKey');
		expect(record).toEqual(
			expect.objectContaining({ scriptAddress: 'addr_test1script', policyId: 'c'.repeat(56), mandateEnglish: null }),
		);
	});

	it.each([
		['a Selling wallet', { type: HotWalletType.Selling }, 400],
		[
			'a V1 source',
			{
				PaymentSource: {
					...hotWallet().PaymentSource,
					paymentSourceType: PaymentSourceType.Web3CardanoV1,
				},
			},
			400,
		],
		['an already guarded wallet', { GuardedWallet: { id: 'gw-0' } }, 409],
	])('refuses %s', async (_label, overrides, status) => {
		mockFindFirst.mockResolvedValue(hotWallet(overrides));
		await expect(attachGuardedWallet(input, scope)).rejects.toMatchObject({ status });
		expect(mockCreate).not.toHaveBeenCalled();
	});

	it('refuses while a batch packed as unguarded holds the hot wallet', async () => {
		mockFindFirst.mockResolvedValue(hotWallet({ lockedAt: new Date() }));
		await expect(attachGuardedWallet(input, scope)).rejects.toMatchObject({ status: 409 });
		expect(mockInspect).not.toHaveBeenCalled();
		expect(mockCreate).not.toHaveBeenCalled();
	});

	it('refuses when a batch locks the hot wallet before the guard is written', async () => {
		mockUpdateMany.mockResolvedValue({ count: 0 });
		await expect(attachGuardedWallet(input, scope)).rejects.toMatchObject({ status: 409 });
		expect(mockCreate).not.toHaveBeenCalled();
	});

	it('refuses a smart wallet that does not verify on chain', async () => {
		mockInspect.mockRejectedValue(new Error('Expected exactly one UTxO carrying the token, found 0'));
		await expect(attachGuardedWallet(input, scope)).rejects.toMatchObject({ status: 409 });
		expect(mockCreate).not.toHaveBeenCalled();
	});

	it('refuses a smart wallet whose agent is another key', async () => {
		mockInspect.mockResolvedValue({ scriptAddress: 's', policyId: 'p', agentVkh: 'f'.repeat(56) });
		await expect(attachGuardedWallet(input, scope)).rejects.toMatchObject({ status: 409 });
		expect(mockCreate).not.toHaveBeenCalled();
	});

	it('registers with the hot wallet as agent and the source escrow', async () => {
		const record = await attachGuardedWallet({ ...input, register: { mandate } }, scope);
		expect(mockRegister).toHaveBeenCalledWith(
			expect.objectContaining({
				agentVkhs: [AGENT],
				escrowAddresses: ['addr_test1escrow'],
				nodeId: 'node',
				orgId: 'org',
				registryGate: true,
			}),
		);
		expect(record).toEqual(
			expect.objectContaining({ exchainWalletId: 'wal_01M3P5ZM0EP8R4NCQWS7TBWZFZ', mandateEnglish: 'up to 50 ADA' }),
		);
	});

	it('refuses a mandate whose daily limit is not the on-chain period limit', async () => {
		await expect(
			attachGuardedWallet({ ...input, register: { mandate: { ...mandate, daily: '5' } } }, scope),
		).rejects.toMatchObject({ status: 400 });
		expect(mockRegister).not.toHaveBeenCalled();
	});
});

describe('detachGuardedWallet', () => {
	it('refuses while the hot wallet is locked by a batch', async () => {
		mockFindFirst.mockResolvedValue(hotWallet({ GuardedWallet: { id: 'gw-1' }, lockedAt: new Date() }));
		await expect(detachGuardedWallet('hw-1', scope)).rejects.toMatchObject({ status: 409 });
		expect(mockDelete).not.toHaveBeenCalled();
	});

	it('deletes the row of an idle guarded wallet', async () => {
		mockFindFirst.mockResolvedValue(hotWallet({ GuardedWallet: { id: 'gw-1' } }));
		await detachGuardedWallet('hw-1', scope);
		expect(mockDelete).toHaveBeenCalledWith({ where: { hotWalletId: 'hw-1' } });
	});
});
