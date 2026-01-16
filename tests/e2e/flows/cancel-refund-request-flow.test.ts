/**
 * Cancel Refund Request Flow E2E Test
 *
 * This test demonstrates the cancel refund request flow where a refund is requested
 * early, result is submitted, then the refund request is cancelled.
 *
 * Complete Flow:
 * 1. Register Agent → 2. Create Payment → 3. Create Purchase → 4. Wait for Funds Locked
 * 5. Request Refund (Early) → 6. Submit Result → 7. Wait for Disputed → 8. Cancel Refund Request
 *
 * Key Features:
 * - Early refund request followed by cancellation
 * - Uses helper functions for clean orchestration
 * - End-to-end cancel refund request scenario
 */

import { Network } from '../../../src/generated/prisma/enums';
import { validateTestWallets } from '../fixtures/testWallets';
import {
  registerAndConfirmAgent,
  createPayment,
  createPurchase,
  waitForFundsLocked,
  requestRefund,
  submitResult,
  waitForDisputed,
  cancelRefundRequest,
  deregisterAgent,
  waitForRefundRequested,
} from '../helperFunctions';

const testNetwork = (process.env.TEST_NETWORK as Network) || Network.Preprod;

describe(`Cancel Refund Request Flow E2E Tests (${testNetwork})`, () => {
  const testCleanupData: Array<{
    agentId?: string;
    agentIdentifier?: string;
    paymentId?: string;
    purchaseId?: string;
    blockchainIdentifier?: string;
    resultHash?: string;
    refundCancelled?: boolean;
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

    console.log(
      `✅ Cancel Refund Request Flow environment validated for ${testNetwork}`,
    );
  });

  afterAll(async () => {
    if (testCleanupData.length > 0) {
      console.log('🧹 Cancel Refund Request Flow cleanup data:');
      testCleanupData.forEach((item) => {
        console.log(
          `   Agent: ${item.agentId}, Payment: ${item.paymentId}, Purchase: ${item.purchaseId}`,
        );
        console.log(
          `   Result Hash: ${item.resultHash}, Refund Cancelled: ${item.refundCancelled}`,
        );
      });
    }
  });

  test(
    'Complete cancel refund request flow: setup → request refund → submit result → cancel refund request',
    async () => {
      console.log('🚀 Starting Cancel Refund Request Flow...');
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
      console.log('💸 Step 5: Requesting refund while funds are locked...');
      await requestRefund(payment.blockchainIdentifier, testNetwork);

      console.log('✅ Refund request submitted while funds were locked');
      console.log('⏳ Step 6: Waiting for refund requested state...');
      await waitForRefundRequested(payment.blockchainIdentifier, testNetwork);

      // ============================
      // STEP 6: SUBMIT RESULT (Using Helper Function)
      // ============================
      console.log('📋 Step 7: Submitting result after refund request...');
      const result = await submitResult(
        payment.blockchainIdentifier,
        testNetwork,
      );

      console.log(`✅ Result submitted after refund request:
        - Result Hash: ${result.resultHash}
      `);

      // Track for cleanup
      testCleanupData[0].resultHash = result.resultHash;

      // ============================
      // STEP 7: WAIT FOR DISPUTED STATE (Using Helper Function)
      // ============================
      console.log('⏳ Step 8: Waiting for disputed state...');
      await waitForDisputed(payment.blockchainIdentifier, testNetwork);

      // ============================
      // STEP 8: CANCEL REFUND REQUEST (Using Helper Function)
      // ============================
      console.log('⏳ Step 9: Cancelling refund request...');
      await cancelRefundRequest(payment.blockchainIdentifier, testNetwork);

      // Track cancellation
      testCleanupData[0].refundCancelled = true;

      console.log('✅ Refund request cancelled successfully');

      // ============================
      // FINAL SUCCESS
      // ============================
      const totalFlowMinutes = Math.floor((Date.now() - flowStartTime) / 60000);
      console.log(`🎉 CANCEL REFUND REQUEST FLOW SUCCESSFUL! (${totalFlowMinutes}m total)
        ✅ Registration: ${agent.name}
        ✅ Agent ID: ${agent.agentIdentifier}
        ✅ Payment: ${payment.id}
        ✅ Purchase: ${purchase.id}
        ✅ Refund Request: Submitted while funds locked
        ✅ SHA256 Result: ${result.resultHash}
        ✅ Result Submitted → Disputed State
        ✅ Refund Request → CANCELLED
        ✅ Blockchain ID: ${payment.blockchainIdentifier.substring(0, 50)}...
        
        🎯 Complete 8-step cancel refund request flow successfully executed using helper functions!
        
        📋 Cancel Refund Request Flow Summary:
        1. Agent registered and confirmed
        2. Payment created with default timing
        3. Purchase created matching payment
        4. Waited for FundsLocked state
        5. Refund requested while funds locked
        6. Waited for RefundRequested state
        7. Result submitted after refund request
        8. Waited for Disputed state
        9. 🚫 CANCELLED refund request → COMPLETE
      `);
    },
    20 * 60 * 1000, // 20 minutes timeout
  );
});
