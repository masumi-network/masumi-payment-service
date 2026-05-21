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
		const v2Source = await getE2EPaymentSource(testNetwork, PaymentSourceType.Web3CardanoV2);

		expect(v2Source.paymentSourceType).toBe(PaymentSourceType.Web3CardanoV2);
		expect(v2Source.SellingWallets.length).toBeGreaterThan(0);
		expect(v2Source.PurchasingWallets.length).toBeGreaterThan(0);
		expect(v2Source.feeRatePermille).toBe(0);
		expect(v2Source.FeeReceiverNetworkWallet).toBeNull();

		// Cross-check against V1 source (if seeded) so a misrouted dispatch that
		// silently reuses V1 wallets/contracts surfaces here as a test failure
		// rather than as on-chain corruption later.
		let v1Source: Awaited<ReturnType<typeof getE2EPaymentSource>> | null = null;
		try {
			v1Source = await getE2EPaymentSource(testNetwork, PaymentSourceType.Web3CardanoV1);
		} catch {
			// V1 source not seeded in this environment — nothing to compare against.
		}

		if (v1Source != null) {
			expect(v2Source.policyId).not.toBe(v1Source.policyId);
			expect(v2Source.smartContractAddress).not.toBe(v1Source.smartContractAddress);

			const v1Vkeys = new Set<string>([
				...v1Source.SellingWallets.map((w) => w.walletVkey),
				...v1Source.PurchasingWallets.map((w) => w.walletVkey),
			]);
			for (const wallet of [...v2Source.SellingWallets, ...v2Source.PurchasingWallets]) {
				expect(v1Vkeys.has(wallet.walletVkey)).toBe(false);
			}
		}
	});
});
