/**
 * Web3CardanoV2 complete flow with refund authorization E2E test.
 *
 * Mirrors tests/e2e/flows/complete-flow-with-refund.test.ts but routes through
 * the V2 PaymentSource. Verifies the full V2 happy path including admin refund
 * authorization after dispute.
 *
 *   Register → Create Payment → Create Purchase → Funds Locked → Submit Result →
 *   Result Submitted → Request Refund → Disputed → Authorize Refund (V2)
 */

import { Network, PaymentSourceType } from '@/generated/prisma/enums';
import { validateTestWallets } from '../../fixtures/testWallets';
import {
	authorizeRefund,
	createPaymentWithCustomTiming,
	createPurchase,
	requestRefund,
	submitResult,
	TimingConfig,
	waitForDisputed,
	waitForFundsLocked,
	waitForResultSubmitted,
} from '../../helperFunctions';

const testNetwork = (process.env.TEST_NETWORK as Network) || Network.Preprod;

describe(`Web3CardanoV2 complete flow with refund (${testNetwork})`, () => {
	beforeAll(async () => {
		if (global.testConfig?.paymentSourceType !== PaymentSourceType.Web3CardanoV2) {
			throw new Error('V2 E2E tests require TEST_PAYMENT_SOURCE_TYPE=Web3CardanoV2.');
		}
		if (!global.testApiClient) {
			throw new Error('Test API client not initialized.');
		}
		const walletValidation = await validateTestWallets(testNetwork, PaymentSourceType.Web3CardanoV2);
		if (!walletValidation.valid) {
			walletValidation.errors.forEach((error) => console.error(`  - ${error}`));
			throw new Error('V2 test wallets are not properly configured.');
		}
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
});
