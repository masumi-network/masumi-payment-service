import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import {
	PaymentAction,
	PaymentSourceType,
	PurchasingAction,
	RegistrationState,
} from '@/generated/prisma/enums';

type AnyMock = Mock<(...args: any[]) => any>;

const mockPaymentSourceFindMany = jest.fn() as AnyMock;
const mockPaymentRequestFindMany = jest.fn() as AnyMock;
const mockPurchaseRequestFindMany = jest.fn() as AnyMock;
const mockRegistryRequestFindMany = jest.fn() as AnyMock;
const mockInboxAgentRegistrationRequestFindMany = jest.fn() as AnyMock;
const mockHotWalletUpdate = jest.fn() as AnyMock;

const txClient = {
	paymentSource: {
		findMany: mockPaymentSourceFindMany,
	},
	paymentRequest: {
		findMany: mockPaymentRequestFindMany,
	},
	purchaseRequest: {
		findMany: mockPurchaseRequestFindMany,
	},
	registryRequest: {
		findMany: mockRegistryRequestFindMany,
	},
	inboxAgentRegistrationRequest: {
		findMany: mockInboxAgentRegistrationRequestFindMany,
	},
	hotWallet: {
		update: mockHotWalletUpdate,
	},
};

const mockTransaction = jest.fn(async (operation: unknown) => {
	if (typeof operation === 'function') {
		return await (operation as (tx: typeof txClient) => Promise<unknown>)(txClient);
	}
	return operation;
}) as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		paymentSource: {
			findMany: mockPaymentSourceFindMany,
		},
		$transaction: mockTransaction,
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

jest.unstable_mockModule('@/utils/db/serializable-semaphore', () => ({
	withSerializableSlotRetry: jest.fn(async (operation: () => Promise<unknown>) => await operation()),
}));

jest.unstable_mockModule('@/generated/prisma/client', async () => await import('@/generated/prisma/enums'));

const { lockAndQueryPayments } = await import('./lock-and-query-payments');
const { lockAndQueryPurchases } = await import('./lock-and-query-purchases');
const { lockAndQueryRegistryRequests } = await import('./lock-and-query-registry-request');
const { lockAndQueryInboxAgentRegistrationRequests } = await import('./lock-and-query-inbox-agent-registration-request');

function buildPaymentSource(walletIds: string[]) {
	return {
		id: 'payment-source-1',
		cooldownTime: 0,
		HotWallets: walletIds.map((id) => ({
			id,
			Secret: { encryptedMnemonic: `encrypted-${id}` },
		})),
		AdminWallets: [],
		FeeReceiverNetworkWallet: null,
		PaymentSourceConfig: { rpcProviderApiKey: 'blockfrost-key' },
	};
}

function mockWalletLock() {
	mockHotWalletUpdate.mockImplementation(async ({ where }: { where: { id: string } }) => ({
		id: where.id,
		pendingTransactionId: `pending-${where.id}`,
		lockedAt: new Date(`2026-01-01T00:00:0${where.id.endsWith('a') ? '1' : '2'}.000Z`),
	}));
}

function walletIdFromRegistryWhere(where: {
	SmartContractWallet?: { id: string };
	OR?: Array<{
		DeregistrationHotWallet?: { is: { id: string } };
		SmartContractWallet?: { id: string };
	}>;
}) {
	return where.SmartContractWallet?.id ?? where.OR?.[0]?.DeregistrationHotWallet?.is.id ?? 'unknown-wallet';
}

describe('lock-and-query helpers wallet scoping', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockWalletLock();
	});

	it('returns one payment batch per locked selling wallet', async () => {
		mockPaymentSourceFindMany.mockResolvedValue([buildPaymentSource(['selling-a', 'selling-b'])]);
		mockPaymentRequestFindMany.mockImplementation(async ({ where }: { where: { SmartContractWallet: { id: string } } }) => [
			{
				id: `payment-${where.SmartContractWallet.id}`,
				SmartContractWallet: { id: where.SmartContractWallet.id },
			},
		]);

		const result = await lockAndQueryPayments({
			paymentStatus: PaymentAction.SubmitResultRequested,
			maxBatchSize: 10,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
		});

		expect(result.map((source) => source.PaymentRequests.map((request) => request.SmartContractWallet?.id))).toEqual([
			['selling-a'],
			['selling-b'],
		]);
	});

	it('returns one purchase batch per locked purchasing wallet', async () => {
		mockPaymentSourceFindMany.mockResolvedValue([buildPaymentSource(['purchasing-a', 'purchasing-b'])]);
		mockPurchaseRequestFindMany.mockImplementation(
			async ({ where }: { where: { SmartContractWallet: { id: string } } }) => [
				{
					id: `purchase-${where.SmartContractWallet.id}`,
					SmartContractWallet: { id: where.SmartContractWallet.id },
				},
			],
		);

		const result = await lockAndQueryPurchases({
			purchasingAction: PurchasingAction.SetRefundRequestedRequested,
			maxBatchSize: 10,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
		});

		expect(result.map((source) => source.PurchaseRequests.map((request) => request.SmartContractWallet?.id))).toEqual([
			['purchasing-a'],
			['purchasing-b'],
		]);
	});

	it('returns one registry registration batch per minting wallet', async () => {
		mockPaymentSourceFindMany.mockResolvedValue([buildPaymentSource(['registry-a', 'registry-b'])]);
		mockRegistryRequestFindMany.mockImplementation(async ({ where }: { where: { SmartContractWallet: { id: string } } }) => [
			{
				id: `registry-${where.SmartContractWallet.id}`,
				SmartContractWallet: { id: where.SmartContractWallet.id },
				DeregistrationHotWallet: null,
			},
		]);

		const result = await lockAndQueryRegistryRequests({
			state: RegistrationState.RegistrationRequested,
			maxBatchSize: 10,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
		});

		expect(result.map((source) => source.RegistryRequest.map((request) => request.SmartContractWallet.id))).toEqual([
			['registry-a'],
			['registry-b'],
		]);
	});

	it('returns one registry holder-action batch per deregistration/update wallet', async () => {
		mockPaymentSourceFindMany.mockResolvedValue([buildPaymentSource(['holder-a', 'holder-b'])]);
		mockRegistryRequestFindMany.mockImplementation(async ({ where }: { where: Parameters<typeof walletIdFromRegistryWhere>[0] }) => {
			const walletId = walletIdFromRegistryWhere(where);
			return [
				{
					id: `registry-${walletId}`,
					SmartContractWallet: { id: `mint-${walletId}` },
					DeregistrationHotWallet: { id: walletId },
				},
			];
		});

		const result = await lockAndQueryRegistryRequests({
			state: RegistrationState.UpdateRequested,
			maxBatchSize: 10,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
		});

		expect(
			result.map((source) => source.RegistryRequest.map((request) => request.DeregistrationHotWallet?.id)),
		).toEqual([['holder-a'], ['holder-b']]);
	});

	it('returns one inbox registration batch per minting wallet', async () => {
		mockPaymentSourceFindMany.mockResolvedValue([buildPaymentSource(['inbox-a', 'inbox-b'])]);
		mockInboxAgentRegistrationRequestFindMany.mockImplementation(
			async ({ where }: { where: { SmartContractWallet: { id: string } } }) => [
				{
					id: `inbox-${where.SmartContractWallet.id}`,
					SmartContractWallet: { id: where.SmartContractWallet.id },
					DeregistrationHotWallet: null,
				},
			],
		);

		const result = await lockAndQueryInboxAgentRegistrationRequests({
			state: RegistrationState.RegistrationRequested,
			maxBatchSize: 10,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
		});

		expect(
			result.map((source) =>
				source.InboxAgentRegistrationRequests.map((request) => request.SmartContractWallet.id),
			),
		).toEqual([['inbox-a'], ['inbox-b']]);
	});

	it('returns one inbox holder-action batch per deregistration wallet', async () => {
		mockPaymentSourceFindMany.mockResolvedValue([buildPaymentSource(['inbox-holder-a', 'inbox-holder-b'])]);
		mockInboxAgentRegistrationRequestFindMany.mockImplementation(
			async ({ where }: { where: Parameters<typeof walletIdFromRegistryWhere>[0] }) => {
				const walletId = walletIdFromRegistryWhere(where);
				return [
					{
						id: `inbox-${walletId}`,
						SmartContractWallet: { id: `mint-${walletId}` },
						DeregistrationHotWallet: { id: walletId },
					},
				];
			},
		);

		const result = await lockAndQueryInboxAgentRegistrationRequests({
			state: RegistrationState.DeregistrationRequested,
			maxBatchSize: 10,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
		});

		expect(
			result.map((source) =>
				source.InboxAgentRegistrationRequests.map((request) => request.DeregistrationHotWallet?.id),
			),
		).toEqual([['inbox-holder-a'], ['inbox-holder-b']]);
	});
});
