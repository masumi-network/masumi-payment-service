import { beforeEach, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { testEndpoint } from 'express-zod-api';
import { ApiKeyStatus, Network } from '@/generated/prisma/client';

const findPayments = jest.fn<() => Promise<never[]>>();
const findPurchases = jest.fn<() => Promise<never[]>>();
jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		apiKey: {
			findUnique: async () => ({
				id: 'earnings-test-key',
				status: ApiKeyStatus.Active,
				canRead: true,
				canPay: false,
				canAdmin: true,
				usageLimited: false,
				networkLimit: [],
				WalletScopes: [],
				X402WalletScopes: [],
			}),
		},
		paymentRequest: { findMany: findPayments },
		purchaseRequest: { findMany: findPurchases },
	},
}));

const { getPaymentIncome } = await import('./payments/income');
const { postPurchaseSpending } = await import('./purchases/spending');
const endpoints = [getPaymentIncome, postPurchaseSpending];
const invoke = (endpoint: (typeof endpoints)[number]) =>
	testEndpoint({
		endpoint,
		requestProps: {
			method: 'POST',
			headers: { token: 'earnings-test-key' },
			body: { network: Network.Preprod, agentIdentifier: null },
		},
		responseOptions: { eventEmitter: EventEmitter },
	});

beforeEach(() => {
	findPayments.mockReset().mockResolvedValue([]);
	findPurchases.mockReset().mockResolvedValue([]);
});

it.each(endpoints)('serves earnings through the real endpoint middleware', async (endpoint) => {
	const { responseMock } = await invoke(endpoint);
	expect(responseMock.statusCode).toBe(200);
	expect(responseMock._getJSONData().data.totalTransactions).toBe(0);
});

it('shares the four-operation limit across income and spending, including admin keys', async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let notifyStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		notifyStarted = resolve;
	});
	let queries = 0;
	const query = async (): Promise<never[]> => {
		queries += 1;
		if (queries === 4) notifyStarted();
		await gate;
		return [];
	};
	findPayments.mockImplementation(query);
	findPurchases.mockImplementation(query);
	const active = [
		invoke(getPaymentIncome),
		invoke(postPurchaseSpending),
		invoke(getPaymentIncome),
		invoke(postPurchaseSpending),
	];
	try {
		await Promise.race([started, Promise.all(active)]);
		expect(queries).toBe(4);
		const blocked = await invoke(postPurchaseSpending);
		expect(blocked.responseMock.statusCode).toBe(503);
		expect(blocked.responseMock.getHeader('retry-after')).toBe('1');
		expect(queries).toBe(4);
	} finally {
		release();
		await Promise.all(active);
	}
	expect((await invoke(getPaymentIncome)).responseMock.statusCode).toBe(200);
});
