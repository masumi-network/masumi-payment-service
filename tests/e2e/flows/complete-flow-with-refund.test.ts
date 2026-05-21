/**
 * Complete Flow with Refund E2E Test
 *
 * Parameterized over the available PaymentSource types (V1 and V2). Each
 * `describe.each` iteration pins `global.testConfig.paymentSourceType` and
 * `global.testAgent` to the source under test so the shared helper functions
 * route to the matching wallets/contracts.
 *
 * Covers the ENTIRE user journey from registration to refund authorization:
 * 1. Register Agent → 2. Create Payment → 3. Create Purchase → 4. Wait for Funds Locked
 * 5. Submit Result → 6. Wait for Result Processing → 7. Request Refund → 8. Wait for Disputed
 * 9. Admin Authorize Refund (COMPLETE)
 */

import { Network, PaymentSourceType } from '@/generated/prisma/enums';
import { validateTestWallets } from '../fixtures/testWallets';
import {
	createPaymentWithCustomTiming,
	createPurchase,
	waitForFundsLocked,
	submitResult,
	waitForResultSubmitted,
	requestRefund,
	waitForDisputed,
	authorizeRefund,
	TimingConfig,
} from '../helperFunctions';

const testNetwork = (process.env.TEST_NETWORK as Network) || Network.Preprod;

const allCases = [
	{ name: 'V1' as const, sourceType: PaymentSourceType.Web3CardanoV1 },
	{ name: 'V2' as const, sourceType: PaymentSourceType.Web3CardanoV2 },
];

// The workflow spawns one jest invocation per source type and pins it via
// TEST_PAYMENT_SOURCE_TYPE so V1 and V2 can run in parallel against the
// shared API + DB. When unset (local dev), run both iterations sequentially.
const envFilter = process.env.TEST_PAYMENT_SOURCE_TYPE as PaymentSourceType | undefined;
const cases = envFilter ? allCases.filter((c) => c.sourceType === envFilter) : allCases;

describe.each(cases)(`Complete E2E Flow with Refund Tests — $name (${testNetwork})`, ({ sourceType }) => {
	const testCleanupData: Array<{
		agentId?: string;
		agentIdentifier?: string;
		paymentId?: string;
		purchaseId?: string;
		blockchainIdentifier?: string;
		resultHash?: string;
		refundRequested?: boolean;
		refundAuthorized?: boolean;
	}> = [];

	beforeAll(async () => {
		console.log(`🚀 Starting Complete E2E Flow with Refund for ${sourceType} on ${testNetwork}...`);

		// Wait for global setup to complete
		if (!global.testConfig) {
			throw new Error('Global test configuration not available. Check testEnvironment.ts setup.');
		}

		// Verify API client is available
		if (!global.testApiClient) {
			throw new Error('Test API client not initialized. Make sure test setup ran correctly.');
		}

		const agent = global.testAgents?.[sourceType];
		if (!agent) {
			throw new Error(`No registered agent for ${sourceType}. globalSetup may have skipped this source type.`);
		}

		global.testConfig.paymentSourceType = sourceType;
		global.testAgent = agent;

		// Validate test wallet configuration
		const walletValidation = await validateTestWallets(testNetwork, sourceType);
		if (!walletValidation.valid) {
			console.error('❌ Test wallet validation failed:');
			walletValidation.errors.forEach((error) => console.error(`  - ${error}`));
			throw new Error('Test wallets not properly configured. See fixtures/testWallets.ts');
		}

		console.log(`✅ Test wallets validated for ${sourceType} on ${testNetwork}`);
		console.log(`✅ Complete E2E Flow with Refund environment validated for ${sourceType} on ${testNetwork}`);
	});

	afterAll(async () => {
		if (testCleanupData.length > 0) {
			console.log(`🧹 Complete flow with refund test created (${sourceType}):`);
			testCleanupData.forEach((item) => {
				console.log(
					`   Agent: ${item.agentId}, Payment: ${item.paymentId}, Purchase: ${item.purchaseId}, Refund: ${item.refundRequested ? 'Yes' : 'No'}`,
				);
			});
		}
	});

	test(
		'Complete flow with refund: register → payment → purchase → funds locked → submit result → refund → authorize',
		async () => {
			console.log(`🚀 Starting Complete E2E Flow with Refund (${sourceType})...`);
			const flowStartTime = Date.now();

			// ============================
			// STEP 1: REGISTER AGENT (Using Helper Function)
			// ============================
			console.log('📝 Step 1: Check if test agent is available...');
			const agent = global.testAgent;

			if (!agent) {
				throw new Error('Test agent not available.');
			}

			testCleanupData.push({
				agentId: agent.id,
				agentIdentifier: agent.agentIdentifier,
			});

			console.log(`✅ Agent registered and confirmed:
        - Agent Name: ${agent.name}
        - Agent ID: ${agent.id}
        - Agent Identifier: ${agent.agentIdentifier}
      `);

			// ============================
			// STEP 2: CREATE PAYMENT WITH CUSTOM TIMING (Using Helper Function)
			// ============================
			console.log('💰 Step 2: Creating payment with custom timing...');

			// Define custom timing for payment (30-90 minutes from now)
			const now = Date.now();
			const customTiming: TimingConfig = {
				payByTime: new Date(now + 30 * 60 * 1000), // 30 minutes
				submitResultTime: new Date(now + 40 * 60 * 1000), // 40 minutes
				unlockTime: new Date(now + 60 * 60 * 1000), // 1 hour
				externalDisputeUnlockTime: new Date(now + 90 * 60 * 1000), // 1 hour 30 minutes
			};

			const payment = await createPaymentWithCustomTiming(agent.agentIdentifier, testNetwork, customTiming);
			expect(payment.response.PaymentSource.paymentSourceType).toBe(sourceType);

			console.log(`✅ Payment created:
        - Payment ID: ${payment.id}
        - Blockchain ID: ${payment.blockchainIdentifier.substring(0, 50)}...
      `);

			// Update cleanup data
			testCleanupData[0].paymentId = payment.id;
			testCleanupData[0].blockchainIdentifier = payment.blockchainIdentifier;

			// ============================
			// STEP 3: CREATE PURCHASE (Using Helper Function)
			// ============================
			console.log('🛒 Step 3: Creating purchase...');
			const purchase = await createPurchase(payment, agent);
			expect(purchase.response.PaymentSource.paymentSourceType).toBe(sourceType);

			console.log(`✅ Purchase created:
        - Purchase ID: ${purchase.id}
        - Matches payment: ${purchase.blockchainIdentifier === payment.blockchainIdentifier}
      `);

			// Update cleanup data
			testCleanupData[0].purchaseId = purchase.id;

			// ============================
			// STEP 4: WAIT FOR FUNDS LOCKED (Using Helper Function)
			// ============================
			console.log('⏳ Step 4: Waiting for funds locked...');
			await waitForFundsLocked(payment.blockchainIdentifier, testNetwork);

			// ============================
			// STEP 5: SUBMIT RESULT (Using Helper Function)
			// ============================
			console.log('📋 Step 5: Submitting result...');
			const result = await submitResult(payment.blockchainIdentifier, testNetwork);
			expect(result.resultHash).toMatch(/^[a-f0-9]{64}$/);

			console.log(`✅ Result submitted:
        - Result Hash: ${result.resultHash}
      `);

			// Update cleanup data
			testCleanupData[0].resultHash = result.resultHash;

			// ============================
			// STEP 6: WAIT FOR RESULT SUBMITTED (Using Helper Function)
			// ============================
			console.log('⏳ Step 6: Waiting for result processing...');
			await waitForResultSubmitted(payment.blockchainIdentifier, testNetwork);

			// ============================
			// STEP 7: REQUEST REFUND (Using Helper Function)
			// ============================
			console.log('💸 Step 7: Requesting refund...');
			await requestRefund(payment.blockchainIdentifier, testNetwork);

			// Update cleanup data
			testCleanupData[0].refundRequested = true;

			// ============================
			// STEP 8: WAIT FOR DISPUTED STATE (Using Helper Function)
			// ============================
			console.log('⏳ Step 8: Waiting for disputed state...');
			await waitForDisputed(payment.blockchainIdentifier, testNetwork);

			// ============================
			// STEP 9: ADMIN AUTHORIZE REFUND (Using Helper Function)
			// ============================
			console.log('👨‍💼 Step 9: Admin authorization...');
			const authorization = await authorizeRefund(payment.blockchainIdentifier, testNetwork);
			expect(authorization.PaymentSource.paymentSourceType).toBe(sourceType);
			expect(authorization.NextAction.requestedAction).toBe('AuthorizeRefundRequested');

			// Update cleanup data
			testCleanupData[0].refundAuthorized = true;

			// ============================
			// FINAL SUCCESS
			// ============================
			const totalFlowMinutes = Math.floor((Date.now() - flowStartTime) / 60000);
			console.log(`🎉 COMPLETE E2E FLOW WITH REFUND SUCCESSFUL! (${totalFlowMinutes}m total — ${sourceType})
        ✅ Registration: ${agent.name}
        ✅ Agent ID: ${agent.agentIdentifier}
        ✅ Payment: ${payment.id}
        ✅ Purchase: ${purchase.id}
        ✅ SHA256 Result: ${result.resultHash}
        ✅ Result Submitted → ResultSubmitted State
        ✅ Refund Requested → Disputed State
        ✅ Admin Authorization → COMPLETE
        ✅ Blockchain ID: ${payment.blockchainIdentifier.substring(0, 50)}...

        🎯 Complete 9-step refund flow successfully executed using helper functions!
      `);
		},
		20 * 60 * 1000, // 20 minutes timeout
	);
});
