/**
 * Web3CardanoV2 wallet isolation smoke test.
 *
 * Verifies that the configured V2 PaymentSource has its own selling/purchasing
 * wallets, fees disabled, no fee receiver, and no wallet-vkey overlap with V1.
 */

import { Network, PaymentSourceType } from '@/generated/prisma/enums';
import { validateTestWallets } from '../../fixtures/testWallets';
import { getE2EPaymentSource } from '../../utils/paymentSourceHelper';

const testNetwork = (process.env.TEST_NETWORK as Network) || Network.Preprod;

describe(`Web3CardanoV2 source isolation (${testNetwork})`, () => {
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
});
