/**
 * Refund After Submit E2E Test
 * 
 * This test focuses ONLY on the refund process after result submission.
 * 
 * Prerequisites: 
 * - Run complete-flow.test.ts first to create payments in ResultSubmitted state
 * - Or ensure there is a payment that has submitted results
 * 
 * Test Flow (7 Steps):
 * 1. Find existing payment in ResultSubmitted state
 * 2. Verify prerequisites for refund
 * 3. Request refund (POST /api/v1/purchase/request-refund)
 * 4. Wait for Disputed state  
 * 5. First admin authorization (POST /api/v1/payment/authorize-refund)
 * 6. Wait for RefundRequested state
 * 7. Second admin authorization (POST /api/v1/payment/authorize-refund)
 */

import { Network } from '@prisma/client';
import waitForExpect from 'wait-for-expect';

const testNetwork = (process.env.TEST_NETWORK as Network) || Network.Preprod;

describe(`Refund After Submit E2E Tests (${testNetwork})`, () => {
  const testCleanupData: Array<{ paymentId?: string; purchaseId?: string; refundCompleted?: boolean }> = [{}];

  beforeAll(async () => {
    // Timeout will be configured per-step as needed
  });

  afterAll(async () => {
    console.log('🧹 Cleaning up refund after submit test data...');
    for (const cleanup of testCleanupData) {
      if (cleanup.paymentId) {
        try {
          console.log(`📝 Test used payment: ${cleanup.paymentId}, Refund completed: ${cleanup.refundCompleted}`);
        } catch (error) {
          console.warn(`⚠️ Cleanup note failed:`, error);
        }
      }
    }
  });

  test('Refund process: ResultSubmitted → request refund → disputed → first auth → refund requested → second auth', async () => {
    console.log('🔄 Starting Refund After Submit Test...');

    // =======================
    // STEP 1: FIND EXISTING PAYMENT IN RESULT SUBMITTED STATE
    // =======================
    console.log('🔍 Step 1: Finding existing payment in ResultSubmitted state...');
    
    const queryResponse = await (global as any).testApiClient.queryPayments({
      network: testNetwork,
    });

    const resultSubmittedPayment = queryResponse.Payments.find(
      (payment: any) => payment.onChainState === 'ResultSubmitted'
    );

    if (!resultSubmittedPayment) {
      console.log('❌ No payment found in ResultSubmitted state. Please run complete-flow.test.ts first or ensure there is a payment that has submitted results.');
      expect(resultSubmittedPayment).toBeDefined();
      return;
    }

    console.log(`✅ Found payment ready for refund:
      - Payment ID: ${resultSubmittedPayment.id}
      - Blockchain ID: ${resultSubmittedPayment.blockchainIdentifier.substring(0, 50)}...
      - State: ${resultSubmittedPayment.onChainState}
      - Action: ${resultSubmittedPayment.NextAction.requestedAction}
      - Result Hash: ${resultSubmittedPayment.NextAction.resultHash || 'N/A'}
    `);

    // Track for cleanup
    testCleanupData[0].paymentId = resultSubmittedPayment.id;

    // =======================
    // STEP 2: VERIFY PREREQUISITES FOR REFUND
    // =======================
    console.log('🔍 Step 2: Verifying prerequisites for refund...');
    
    // Find corresponding purchase
    const purchaseQueryResponse = await (global as any).testApiClient.queryPurchases({
      network: testNetwork,
    });

    const correspondingPurchase = purchaseQueryResponse.Purchases.find(
      (purchase: any) => purchase.blockchainIdentifier === resultSubmittedPayment.blockchainIdentifier
    );

    if (!correspondingPurchase) {
      console.log('❌ No corresponding purchase found for the payment.');
      expect(correspondingPurchase).toBeDefined();
      return;
    }

    console.log(`✅ Found corresponding purchase:
      - Purchase ID: ${correspondingPurchase.id}
      - State: ${correspondingPurchase.NextAction.requestedAction}
      - Same blockchain ID: ${correspondingPurchase.blockchainIdentifier === resultSubmittedPayment.blockchainIdentifier}
    `);

    // Track for cleanup
    testCleanupData[0].purchaseId = correspondingPurchase.id;

    // =======================
    // STEP 3: REQUEST REFUND
    // =======================
    console.log('💸 Step 3: Requesting refund after ResultSubmitted state...');

    const refundRequestResponse = await (global as any).testApiClient.makeRequest('/api/v1/purchase/request-refund', {
      method: 'POST',
      body: JSON.stringify({
        network: testNetwork,
        blockchainIdentifier: resultSubmittedPayment.blockchainIdentifier,
      }),
    });

    // DEBUG: Log the full response to understand its structure
    console.log('🔍 DEBUG: Full refund request response:', JSON.stringify(refundRequestResponse, null, 2));

    expect(refundRequestResponse).toBeDefined();
    expect(refundRequestResponse.id).toBeDefined();
    expect(refundRequestResponse.NextAction).toBeDefined();
    expect(refundRequestResponse.NextAction.requestedAction).toBe('SetRefundRequestedRequested');

    console.log(`✅ Refund request submitted successfully:
      - Updated action: ${refundRequestResponse.NextAction.requestedAction}
      - Response ID: ${refundRequestResponse.id}
    `);

    // =======================
    // STEP 4: WAIT FOR DISPUTED STATE (INFINITE WAIT)
    // =======================
    console.log('⏳ Step 4: Waiting for payment to reach Disputed state...');
    console.log('💡 Blockchain state transitions can be unpredictable on Preprod network');
    console.log('⏳ INFINITE WAIT MODE: Will wait indefinitely until blockchain confirmation');
    console.log('💡 Press Ctrl+C to stop if needed');
    
    const disputedStartTime = Date.now();
    
    // Configure infinite timeout for blockchain state transition
    const disputedOriginalTimeout = waitForExpect.defaults.timeout;
    const disputedOriginalInterval = waitForExpect.defaults.interval;
    waitForExpect.defaults.timeout = Number.MAX_SAFE_INTEGER;
    waitForExpect.defaults.interval = 15000; // Check every 15 seconds
    
    await waitForExpect(async () => {
      const elapsedMinutes = Math.floor((Date.now() - disputedStartTime) / 60000);
      console.log(`⏱️  Checking payment state... (${elapsedMinutes}m elapsed)`);
      
      const queryResponse = await (global as any).testApiClient.queryPayments({
        network: testNetwork,
      });

      const currentPayment = queryResponse.Payments.find(
        (payment: any) => payment.blockchainIdentifier === resultSubmittedPayment.blockchainIdentifier
      );

      expect(currentPayment).toBeDefined();
      
      console.log(`📊 Payment state check: ${currentPayment.onChainState}, Action: ${currentPayment.NextAction.requestedAction}`);
      
      // Wait until the payment reaches Disputed state after refund request
      expect(currentPayment.onChainState).toBe('Disputed');
      expect(currentPayment.NextAction.requestedAction).toBe('WaitingForExternalAction');
      
      console.log(`✅ Payment now in Disputed state and ready for first admin authorization`);
    });
    
    // Restore original timeout and interval
    waitForExpect.defaults.timeout = disputedOriginalTimeout;
    waitForExpect.defaults.interval = disputedOriginalInterval;

    const disputedMinutes = Math.floor((Date.now() - disputedStartTime) / 60000);
    console.log(`✅ Payment reached Disputed state after ${disputedMinutes}m`);

    // =======================
    // STEP 5: FIRST ADMIN AUTHORIZE REFUND
    // =======================
    console.log('👨‍💼 Step 5: First admin authorization (Disputed → RefundRequested)...');

    const firstAuthorizeRefundResponse = await (global as any).testApiClient.makeRequest('/api/v1/payment/authorize-refund', {
      method: 'POST',
      body: JSON.stringify({
        network: testNetwork,
        blockchainIdentifier: resultSubmittedPayment.blockchainIdentifier,
      }),
    });

    expect(firstAuthorizeRefundResponse).toBeDefined();
    expect(firstAuthorizeRefundResponse.id).toBeDefined();
    expect(firstAuthorizeRefundResponse.onChainState).toBeDefined();
    expect(firstAuthorizeRefundResponse.NextAction).toBeDefined();
    expect(firstAuthorizeRefundResponse.NextAction.requestedAction).toBe('AuthorizeRefundRequested');

    console.log(`✅ First admin authorization successful:
      - Payment ID: ${firstAuthorizeRefundResponse.id}
      - OnChain State: ${firstAuthorizeRefundResponse.onChainState}
      - Next Action: ${firstAuthorizeRefundResponse.NextAction.requestedAction}
    `);

    // =======================
    // STEP 6: WAIT FOR REFUND REQUESTED STATE (INFINITE WAIT)
    // =======================
    console.log('⏳ Step 6: Waiting for payment to reach RefundRequested state...');
    console.log('💡 Blockchain state transitions can be unpredictable on Preprod network');
    console.log('⏳ INFINITE WAIT MODE: Will wait indefinitely until blockchain confirmation');
    console.log('💡 Press Ctrl+C to stop if needed');
    
    const refundRequestedStartTime = Date.now();
    
    // Configure infinite timeout for blockchain state transition  
    const originalTimeout = waitForExpect.defaults.timeout;
    const originalInterval = waitForExpect.defaults.interval;
    waitForExpect.defaults.timeout = Number.MAX_SAFE_INTEGER;
    waitForExpect.defaults.interval = 15000; // Check every 15 seconds
    
    await waitForExpect(async () => {
      const elapsedMinutes = Math.floor((Date.now() - refundRequestedStartTime) / 60000);
      console.log(`⏱️  Checking payment state... (${elapsedMinutes}m elapsed)`);
      
      const queryResponse = await (global as any).testApiClient.queryPayments({
        network: testNetwork,
      });

      const currentPayment = queryResponse.Payments.find(
        (payment: any) => payment.blockchainIdentifier === resultSubmittedPayment.blockchainIdentifier
      );

      expect(currentPayment).toBeDefined();
      
      console.log(`📊 Payment state check: ${currentPayment.onChainState}, Action: ${currentPayment.NextAction.requestedAction}`);
      
      // Wait until the payment reaches RefundRequested state after first authorization
      expect(currentPayment.onChainState).toBe('RefundRequested');
      expect(currentPayment.NextAction.requestedAction).toBe('WaitingForExternalAction');
      
      console.log(`✅ Payment now in RefundRequested state and ready for second admin authorization`);
    });
    
    // Restore original timeout and interval
    waitForExpect.defaults.timeout = originalTimeout;
    waitForExpect.defaults.interval = originalInterval;

    const refundRequestedMinutes = Math.floor((Date.now() - refundRequestedStartTime) / 60000);
    console.log(`✅ Payment reached RefundRequested state after ${refundRequestedMinutes}m`);

    // =======================
    // STEP 7: SECOND ADMIN AUTHORIZE REFUND
    // =======================
    console.log('👨‍💼 Step 7: Second admin authorization (final completion)...');

    const secondAuthorizeRefundResponse = await (global as any).testApiClient.makeRequest('/api/v1/payment/authorize-refund', {
      method: 'POST',
      body: JSON.stringify({
        network: testNetwork,
        blockchainIdentifier: resultSubmittedPayment.blockchainIdentifier,
      }),
    });

    expect(secondAuthorizeRefundResponse).toBeDefined();
    expect(secondAuthorizeRefundResponse.id).toBeDefined();
    expect(secondAuthorizeRefundResponse.onChainState).toBeDefined();
    expect(secondAuthorizeRefundResponse.NextAction).toBeDefined();
    expect(secondAuthorizeRefundResponse.NextAction.requestedAction).toBe('AuthorizeRefundRequested');

    console.log(`✅ Second admin authorization successful:
      - Payment ID: ${secondAuthorizeRefundResponse.id}
      - OnChain State: ${secondAuthorizeRefundResponse.onChainState}
      - Next Action: ${secondAuthorizeRefundResponse.NextAction.requestedAction}
    `);

    // Track completion in cleanup data
    testCleanupData[0].refundCompleted = true;

    console.log(`✅ Refund process completed - both authorizations successful`);

    // =======================
    // FINAL SUCCESS
    // =======================
    console.log(`🎉 REFUND AFTER SUBMIT SUCCESSFUL!
      ✅ Found Payment: ${resultSubmittedPayment.id}
      ✅ Found Purchase: ${correspondingPurchase.id}
      ✅ Refund Requested → Disputed State
      ✅ First Admin Authorization → RefundRequested State  
      ✅ Second Admin Authorization → Final Completion
      ✅ Blockchain ID: ${resultSubmittedPayment.blockchainIdentifier.substring(0, 50)}...
      
      🚀 Fast 7-step refund process completed successfully!
    `);
  },
  // Dynamic timeout: 24 hours (effectively infinite for Jest)
  24 * 60 * 60 * 1000
  );
});