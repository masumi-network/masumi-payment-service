/**
 * Early Refund Complete Flow E2E Test
 *
 * This test demonstrates the complete early refund flow where a refund is requested
 * BEFORE submitting results (while funds are still locked).
 *
 * Complete Flow:
 * 1. Register Agent → 2. Create Payment → 3. Create Purchase → 4. Wait for Funds Locked
 * 5. Request Refund (EARLY) → 6. Submit Result → 7. Wait for Disputed → 8. Authorize Refund
 *
 * Key Features:
 * - Early refund scenario (refund before result submission)
 * - Uses helper functions for clean orchestration
 * - Complete end-to-end early refund scenario
 */

import { Network } from '@/generated/prisma/enums';
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

describe(`Early Refund Complete Flow E2E Tests (${testNetwork})`, () => {
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

		const walletValidation = validateTestWallets(testNetwork);
		if (!walletValidation.valid) {
			walletValidation.errors.forEach((error) => console.error(`  - ${error}`));
			throw new Error('Test wallets not properly configured.');
		}

		if (!global.testApiClient) {
			throw new Error('Test API client not initialized.');
		}

		console.log(`✅ Early Refund Complete Flow environment validated for ${testNetwork}`);
	});

	afterAll(async () => {
		if (testCleanupData.length > 0) {
			console.log('🧹 Early Refund Complete Flow cleanup data:');
			testCleanupData.forEach((item) => {
				console.log(`   Agent: ${item.agentId}, Payment: ${item.paymentId}, Purchase: ${item.purchaseId}`);
				console.log(`   Result Hash: ${item.resultHash}, Refund Completed: ${item.refundCompleted}`);
			});
		}
	});

	test(
		'Complete early refund flow: setup → request refund → submit result → authorize refund',
		async () => {
			console.log('🚀 Starting Early Refund Complete Flow...');
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
			await authorizeRefund(payment.blockchainIdentifier, testNetwork);

			// Track completion
			testCleanupData[0].refundCompleted = true;

			// ============================
			// FINAL SUCCESS
			// ============================
			const totalFlowMinutes = Math.floor((Date.now() - flowStartTime) / 60000);
			console.log(`🎉 EARLY REFUND COMPLETE FLOW SUCCESSFUL! (${totalFlowMinutes}m total)
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
