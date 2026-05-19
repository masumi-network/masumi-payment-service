/**
 * Web3CardanoV2 payment source E2E tests.
 *
 * These run through the public /api/v1 routes but require the V2 runner so wallet
 * lookup, registry setup, payment creation, and purchase creation all use a V2
 * PaymentSource.
 */

import { Network, PaymentSourceType } from '@/generated/prisma/enums';
import { validateTestWallets } from '../../fixtures/testWallets';
import {
	authorizeRefund,
	cancelRefundRequest,
	createPayment,
	createPaymentWithCustomTiming,
	createPurchase,
	requestRefund,
	submitResult,
	TimingConfig,
	waitForDisputed,
	waitForFundsLocked,
	waitForRefundRequested,
	waitForResultSubmitted,
} from '../../helperFunctions';
import { getE2EPaymentSource } from '../../utils/paymentSourceHelper';

const testNetwork = (process.env.TEST_NETWORK as Network) || Network.Preprod;

describe(`Web3CardanoV2 E2E Payment Source Tests (${testNetwork})`, () => {
	beforeAll(async () => {
		if (!global.testConfig) {
			throw new Error('Global test configuration not available. Check testEnvironment.ts setup.');
		}
		if (global.testConfig.paymentSourceType !== PaymentSourceType.Web3CardanoV2) {
			throw new Error(
				`V2 E2E tests must run with TEST_PAYMENT_SOURCE_TYPE=${PaymentSourceType.Web3CardanoV2}. ` +
					`Received ${global.testConfig.paymentSourceType}.`,
			);
		}
		if (!global.testApiClient) {
			throw new Error('Test API client not initialized. Make sure test setup ran correctly.');
		}

		const walletValidation = await validateTestWallets(testNetwork, PaymentSourceType.Web3CardanoV2);
		if (!walletValidation.valid) {
			walletValidation.errors.forEach((error) => console.error(`  - ${error}`));
			throw new Error('V2 test wallets are not properly configured.');
		}

		console.log(`✅ V2 E2E environment validated for ${testNetwork}`);
	});

	test('uses a V2 source with wallets isolated from V1', async () => {
		const paymentSource = await getE2EPaymentSource(testNetwork, PaymentSourceType.Web3CardanoV2);

		expect(paymentSource.paymentSourceType).toBe(PaymentSourceType.Web3CardanoV2);
		expect(paymentSource.SellingWallets.length).toBeGreaterThan(0);
		expect(paymentSource.PurchasingWallets.length).toBeGreaterThan(0);
		expect(paymentSource.feeRatePermille).toBe(0);
		expect(paymentSource.FeeReceiverNetworkWallet).toBeNull();
	});

	test(
		'complete V2 refund authorization flow',
		async () => {
			const agent = global.testAgent;
			if (!agent) {
				throw new Error('Test agent not available.');
			}

			const now = Date.now();
			const customTiming: TimingConfig = {
				payByTime: new Date(now + 30 * 60 * 1000),
				submitResultTime: new Date(now + 40 * 60 * 1000),
				unlockTime: new Date(now + 60 * 60 * 1000),
				externalDisputeUnlockTime: new Date(now + 90 * 60 * 1000),
			};

			const payment = await createPaymentWithCustomTiming(agent.agentIdentifier, testNetwork, customTiming);
			expect(payment.response.PaymentSource.paymentSourceType).toBe(PaymentSourceType.Web3CardanoV2);

			const purchase = await createPurchase(payment, agent);
			expect(purchase.response.PaymentSource.paymentSourceType).toBe(PaymentSourceType.Web3CardanoV2);

			await waitForFundsLocked(payment.blockchainIdentifier, testNetwork);

			const result = await submitResult(payment.blockchainIdentifier, testNetwork);
			expect(result.resultHash).toMatch(/^[a-f0-9]{64}$/);

			await waitForResultSubmitted(payment.blockchainIdentifier, testNetwork);
			await requestRefund(payment.blockchainIdentifier, testNetwork);
			await waitForDisputed(payment.blockchainIdentifier, testNetwork);

			const authorization = await authorizeRefund(payment.blockchainIdentifier, testNetwork);
			expect(authorization.PaymentSource.paymentSourceType).toBe(PaymentSourceType.Web3CardanoV2);
			expect(authorization.NextAction.requestedAction).toBe('AuthorizeRefundRequested');
		},
		20 * 60 * 1000,
	);

	test(
		'early V2 refund flow reaches disputed authorization',
		async () => {
			const agent = global.testAgent;
			if (!agent) {
				throw new Error('Test agent not available.');
			}

			const payment = await createPayment(agent.agentIdentifier, testNetwork);
			expect(payment.response.PaymentSource.paymentSourceType).toBe(PaymentSourceType.Web3CardanoV2);

			const purchase = await createPurchase(payment, agent);
			expect(purchase.response.PaymentSource.paymentSourceType).toBe(PaymentSourceType.Web3CardanoV2);

			await waitForFundsLocked(payment.blockchainIdentifier, testNetwork);
			await requestRefund(payment.blockchainIdentifier, testNetwork);
			await waitForRefundRequested(payment.blockchainIdentifier, testNetwork);

			const result = await submitResult(payment.blockchainIdentifier, testNetwork);
			expect(result.resultHash).toMatch(/^[a-f0-9]{64}$/);

			await waitForDisputed(payment.blockchainIdentifier, testNetwork);

			const authorization = await authorizeRefund(payment.blockchainIdentifier, testNetwork);
			expect(authorization.PaymentSource.paymentSourceType).toBe(PaymentSourceType.Web3CardanoV2);
			expect(authorization.NextAction.requestedAction).toBe('AuthorizeRefundRequested');
		},
		20 * 60 * 1000,
	);

	test(
		'V2 cancel-refund route requests withdrawal authorization',
		async () => {
			const agent = global.testAgent;
			if (!agent) {
				throw new Error('Test agent not available.');
			}

			const payment = await createPayment(agent.agentIdentifier, testNetwork);
			expect(payment.response.PaymentSource.paymentSourceType).toBe(PaymentSourceType.Web3CardanoV2);

			const purchase = await createPurchase(payment, agent);
			expect(purchase.response.PaymentSource.paymentSourceType).toBe(PaymentSourceType.Web3CardanoV2);

			await waitForFundsLocked(payment.blockchainIdentifier, testNetwork);
			await requestRefund(payment.blockchainIdentifier, testNetwork);
			await waitForRefundRequested(payment.blockchainIdentifier, testNetwork);

			const result = await submitResult(payment.blockchainIdentifier, testNetwork);
			expect(result.resultHash).toMatch(/^[a-f0-9]{64}$/);

			await waitForDisputed(payment.blockchainIdentifier, testNetwork);

			const cancellation = await cancelRefundRequest(payment.blockchainIdentifier, testNetwork);
			expect(cancellation.PaymentSource.paymentSourceType).toBe(PaymentSourceType.Web3CardanoV2);
			expect(cancellation.NextAction.requestedAction).toBe('AuthorizeWithdrawalRequested');
		},
		20 * 60 * 1000,
	);
});
