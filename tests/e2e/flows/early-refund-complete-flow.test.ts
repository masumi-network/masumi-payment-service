/**
 * Early Refund Complete Flow E2E Test
 *
 * Parameterized over the available PaymentSource types (V1 and V2). Each
 * `describe.each` iteration pins `global.testConfig.paymentSourceType` and
 * `global.testAgent` to the source under test so the shared helper functions
 * route to the matching wallets/contracts.
 *
 * Complete Flow:
 * 1. Register Agent → 2. Create Payment → 3. Create Purchase → 4. Wait for Funds Locked
 * 5. Request Refund (EARLY) → 6. Submit Result → 7. Wait for Disputed → 8. Authorize Refund
 *
 * Key Features:
 * - Early refund scenario (refund before result submission)
 * - Complete end-to-end early refund scenario
 */

import { Network, PaymentSourceType } from '@/generated/prisma/enums';
import { validateTestWallets } from '../fixtures/testWallets';
import {
	createPayment,
	createPurchase,
	waitForFundsLocked,
	requestRefund,
	waitForRefundRequested,
	submitResult,
	waitForDisputed,
	authorizeRefund,
} from '../helperFunctions';

const testNetwork = (process.env.TEST_NETWORK as Network) || Network.Preprod;

// V2 is intentionally NOT covered by this single-item flow test. V2's
// equivalent action surface is exercised by
// `tests/e2e/v2/flows/batch-verification.test.ts` via the batch path.
// Running V2 here just duplicated the assertions through V2's single-item
// fallback while adding ~10 minutes of on-chain wait time per e2e run.
const allCases = [{ name: 'V1' as const, sourceType: PaymentSourceType.Web3CardanoV1 }];

// The workflow spawns one jest invocation per source type and pins it via
// TEST_PAYMENT_SOURCE_TYPE so V1 and V2 can run in parallel against the
// shared API + DB. When unset (local dev), run both iterations sequentially.
const envFilter = process.env.TEST_PAYMENT_SOURCE_TYPE as PaymentSourceType | undefined;
const cases = envFilter ? allCases.filter((c) => c.sourceType === envFilter) : allCases;

describe.each(cases)(`Early Refund Complete Flow E2E Tests — $name (${testNetwork})`, ({ sourceType }) => {
	const testCleanupData: Array<{
		agentId?: string;
		agentIdentifier?: string;
		paymentId?: string;
		purchaseId?: string;
		blockchainIdentifier?: string;
		resultHash?: string;
		refundCompleted?: boolean;
	}> = [{}];

	beforeAll(async () => {
		if (!global.testConfig) {
			throw new Error('Global test configuration not available.');
		}
		if (!global.testApiClient) {
			throw new Error('Test API client not initialized.');
		}

		const agent = global.testAgents?.[sourceType];
		if (!agent) {
			throw new Error(`No registered agent for ${sourceType}. globalSetup may have skipped this source type.`);
		}

		global.testConfig.paymentSourceType = sourceType;
		global.testAgent = agent;

		const walletValidation = await validateTestWallets(testNetwork, sourceType);
		if (!walletValidation.valid) {
			walletValidation.errors.forEach((error) => console.error(`  - ${error}`));
			throw new Error('Test wallets not properly configured.');
		}

		console.log(`✅ Early Refund Complete Flow environment validated for ${sourceType} on ${testNetwork}`);
	});

	afterAll(async () => {
		if (testCleanupData.length > 0) {
			console.log(`🧹 Early Refund Complete Flow cleanup data (${sourceType}):`);
			testCleanupData.forEach((item) => {
				console.log(`   Agent: ${item.agentId}, Payment: ${item.paymentId}, Purchase: ${item.purchaseId}`);
				console.log(`   Result Hash: ${item.resultHash}, Refund Completed: ${item.refundCompleted}`);
			});
		}
	});

	test(
		'Complete early refund flow: setup → request refund → submit result → authorize refund',
		async () => {
			console.log(`🚀 Starting Early Refund Complete Flow (${sourceType})...`);
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
			// STEP 2: CREATE PAYMENT (Using Helper Function)
			// ============================
			console.log('💰 Step 2: Creating payment...');
			const payment = await createPayment(agent.agentIdentifier, testNetwork);
			expect(payment.response.PaymentSource.paymentSourceType).toBe(sourceType);

			console.log(`✅ Payment created:
        - Payment ID: ${payment.id}
        - Blockchain ID: ${payment.blockchainIdentifier.substring(0, 50)}...
      `);

			// Track for cleanup
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

			// Track for cleanup
			testCleanupData[0].purchaseId = purchase.id;

			// ============================
			// STEP 4: WAIT FOR FUNDS LOCKED (Using Helper Function)
			// ============================
			console.log('⏳ Step 4: Waiting for funds locked...');
			await waitForFundsLocked(payment.blockchainIdentifier, testNetwork);

			// ============================
			// STEP 5: REQUEST REFUND (EARLY - WHILE FUNDS LOCKED) (Using Helper Function)
			// ============================
			console.log('💸 Step 5: Requesting refund while funds are locked (EARLY REFUND)...');
			await requestRefund(payment.blockchainIdentifier, testNetwork);

			console.log('✅ Early refund request submitted while funds were still locked');

			// ============================
			// WAIT FOR REFUND REQUESTED STATE (Using Helper Function)
			// ============================
			console.log('⏳ Waiting for refund request to be processed on blockchain...');
			await waitForRefundRequested(payment.blockchainIdentifier, testNetwork);

			// ============================
			// STEP 6: SUBMIT RESULT (Using Helper Function)
			// ============================
			console.log('📋 Step 6: Submitting result after refund request...');
			const result = await submitResult(payment.blockchainIdentifier, testNetwork);
			expect(result.resultHash).toMatch(/^[a-f0-9]{64}$/);

			console.log(`✅ Result submitted after early refund request:
        - Result Hash: ${result.resultHash}
      `);

			// Track for cleanup
			testCleanupData[0].resultHash = result.resultHash;

			// ============================
			// STEP 7: WAIT FOR DISPUTED STATE (Using Helper Function)
			// ============================
			console.log('⏳ Step 7: Waiting for disputed state...');
			await waitForDisputed(payment.blockchainIdentifier, testNetwork);

			// ============================
			// STEP 8: ADMIN AUTHORIZE REFUND (Using Helper Function)
			// ============================
			console.log('👨‍💼 Step 8: Admin authorization...');
			const authorization = await authorizeRefund(payment.blockchainIdentifier, testNetwork);
			expect(authorization.PaymentSource.paymentSourceType).toBe(sourceType);
			expect(authorization.NextAction.requestedAction).toBe('AuthorizeRefundRequested');

			// Track completion
			testCleanupData[0].refundCompleted = true;

			// ============================
			// FINAL SUCCESS
			// ============================
			const totalFlowMinutes = Math.floor((Date.now() - flowStartTime) / 60000);
			console.log(`🎉 EARLY REFUND COMPLETE FLOW SUCCESSFUL! (${totalFlowMinutes}m total — ${sourceType})
        ✅ Registration: ${agent.name}
        ✅ Agent ID: ${agent.agentIdentifier}
        ✅ Payment: ${payment.id}
        ✅ Purchase: ${purchase.id}
        ✅ Early Refund Request: BEFORE result submission
        ✅ SHA256 Result: ${result.resultHash}
        ✅ Result Submitted → Disputed State
        ✅ Admin Authorization → COMPLETE
        ✅ Blockchain ID: ${payment.blockchainIdentifier.substring(0, 50)}...

        🎯 Complete 8-step early refund flow successfully executed using helper functions!

        📋 Early Refund Flow Summary:
        1. Agent registered and confirmed
        2. Payment created with default timing
        3. Purchase created matching payment
        4. Waited for FundsLocked state
        5. 🔥 EARLY REFUND requested while funds locked
        6. Result submitted after refund request
        7. Waited for Disputed state
        8. Admin authorized refund → COMPLETE
      `);
		},
		20 * 60 * 1000, // 20 minutes timeout
	);
});
