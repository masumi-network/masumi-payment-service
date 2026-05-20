/**
 * Web3CardanoV2 cancel-refund flow.
 *
 * Mirrors tests/e2e/flows/cancel-refund-request-flow.test.ts on V2. The cancel-
 * refund route on V2 emits an `AuthorizeWithdrawalRequested` action (the V2
 * equivalent of V1's `UnSetRefundRequestedRequested`) rather than reverting the
 * refund directly.
 *
 *   Register → Create Payment → Create Purchase → Funds Locked → Request Refund →
 *   Refund Requested → Submit Result → Disputed → Cancel Refund → AuthorizeWithdrawalRequested
 */

import { Network, PaymentSourceType } from '@/generated/prisma/enums';
import { validateTestWallets } from '../../fixtures/testWallets';
import {
	cancelRefundRequest,
	createPayment,
	createPurchase,
	requestRefund,
	submitResult,
	waitForDisputed,
	waitForFundsLocked,
	waitForRefundRequested,
} from '../../helperFunctions';

const testNetwork = (process.env.TEST_NETWORK as Network) || Network.Preprod;

describe(`Web3CardanoV2 cancel refund flow (${testNetwork})`, () => {
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
