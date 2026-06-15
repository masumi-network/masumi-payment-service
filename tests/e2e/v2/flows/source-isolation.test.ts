/**
 * Web3CardanoV2 wallet isolation smoke test.
 *
 * Verifies that the configured V2 PaymentSource has its own selling/purchasing
 * wallets, fees disabled, no fee receiver, and no wallet-vkey overlap with V1.
 *
 * V2-only by design: the shared flow tests already cover V1+V2 happy paths.
 * This file pins `global.testConfig.paymentSourceType` to V2 for the duration
 * of the suite so helper utilities (which read the global when no explicit
 * type is passed) resolve to the V2 source.
 */

import { Network, PaymentSourceType } from '@/generated/prisma/enums';
import { validateTestWallets } from '../../fixtures/testWallets';
import { getE2EPaymentSource } from '../../utils/paymentSourceHelper';

const testNetwork = (process.env.TEST_NETWORK as Network) || Network.Preprod;

const envFilter = process.env.TEST_PAYMENT_SOURCE_TYPE as PaymentSourceType | undefined;
// V2-only suite. Skip when the workflow pinned this jest invocation to V1.
const describeFn = envFilter && envFilter !== PaymentSourceType.Web3CardanoV2 ? describe.skip : describe;

describeFn(`Web3CardanoV2 source isolation (${testNetwork})`, () => {
	beforeAll(async () => {
		if (!global.testConfig) {
			throw new Error('Global test configuration not available. Check testEnvironment.ts setup.');
		}
		if (!global.testApiClient) {
			throw new Error('Test API client not initialized. Make sure test setup ran correctly.');
		}

		// Pin the global so any helper that reads `global.testConfig.paymentSourceType`
		// (without an explicit override) resolves to V2 inside this suite.
		global.testConfig.paymentSourceType = PaymentSourceType.Web3CardanoV2;

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
		expect(v2Source.SellingWalletsCount).toBeGreaterThan(0);
		expect(v2Source.PurchasingWalletsCount).toBeGreaterThan(0);
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

			// Hot wallets are served by /wallet/list now; fetch each source's
			// wallets and assert no vkey overlap between V1 and V2.
			const [{ Wallets: v1Wallets }, { Wallets: v2Wallets }] = await Promise.all([
				global.testApiClient.queryWallets({ paymentSourceId: v1Source.id, take: 100 }),
				global.testApiClient.queryWallets({ paymentSourceId: v2Source.id, take: 100 }),
			]);
			const v1Vkeys = new Set<string>(v1Wallets.map((w) => w.walletVkey));
			for (const wallet of v2Wallets) {
				expect(v1Vkeys.has(wallet.walletVkey)).toBe(false);
			}
		}
	});
});
