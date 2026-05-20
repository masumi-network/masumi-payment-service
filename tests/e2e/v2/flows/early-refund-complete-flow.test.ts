/**
 * Web3CardanoV2 early-refund flow reaching disputed authorization.
 *
 * Mirrors tests/e2e/flows/early-refund-complete-flow.test.ts on V2. Buyer
 * requests refund before the seller submits a result; the seller still submits
 * later and the flow reaches the V2 disputed/authorize-refund path.
 *
 *   Register → Create Payment → Create Purchase → Funds Locked → Request Refund →
 *   Refund Requested → Submit Result → Disputed → Authorize Refund (V2)
 */

import { Network, PaymentSourceType } from '@/generated/prisma/enums';
import { validateTestWallets } from '../../fixtures/testWallets';
import {
	authorizeRefund,
	createPayment,
	createPurchase,
	requestRefund,
	submitResult,
	waitForDisputed,
	waitForFundsLocked,
	waitForRefundRequested,
} from '../../helperFunctions';

const testNetwork = (process.env.TEST_NETWORK as Network) || Network.Preprod;

describe(`Web3CardanoV2 early refund flow (${testNetwork})`, () => {
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
});
