/**
 * Refund From Disputed E2E Test
 * 
 * This test starts from a payment that already has refund request initiated.
 * Use this when you've already called POST /api/v1/purchase/request-refund
 * 
 * Prerequisites: 
 * - A payment that has already requested refund (either in Disputed state or transitioning to it)
 * 
 * Test Flow (4 Steps):
 * 1. Find existing payment in Disputed state (or wait for it)
 * 2. First admin authorization (POST /api/v1/payment/authorize-refund)
 * 3. Wait for RefundRequested state
 * 4. Second admin authorization (POST /api/v1/payment/authorize-refund)
 */

import { Network } from '@prisma/client';
import waitForExpect from 'wait-for-expect';

const testNetwork = (process.env.TEST_NETWORK as Network) || Network.Preprod;

describe(`Refund From Disputed E2E Tests (${testNetwork})`, () => {
  const testCleanupData: Array<{ paymentId?: string; refundCompleted?: boolean }> = [{}];

  beforeAll(async () => {
    // Timeout will be configured per-step as needed
  });

  afterAll(async () => {
    console.log('🧹 Cleaning up refund from disputed test data...');
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

  test('Refund process: disputed → first auth → refund requested → second auth', async () => {
    console.log('🔄 Starting Refund From Disputed Test...');

    // =======================
    // STEP 1: FIND PAYMENT IN DISPUTED STATE (OR WAIT FOR IT)
    // =======================
    console.log('🔍 Step 1: Finding payment in Disputed state (or waiting for transition)...');
    console.log('💡 If refund request was just made, payment might still be transitioning');
    console.log('⏳ INFINITE WAIT MODE: Will wait indefinitely until Disputed state');
    console.log('💡 Press Ctrl+C to stop if needed');
    
    const disputedStartTime = Date.now();
    
    // Configure infinite timeout for finding/waiting for disputed payment
    const disputedOriginalTimeout = waitForExpect.defaults.timeout;
    const disputedOriginalInterval = waitForExpect.defaults.interval;
    waitForExpect.defaults.timeout = Number.MAX_SAFE_INTEGER;
    waitForExpect.defaults.interval = 15000; // Check every 15 seconds
    
    let disputedPayment: any;
    
    await waitForExpect(async () => {
      const elapsedMinutes = Math.floor((Date.now() - disputedStartTime) / 60000);
      console.log(`⏱️  Searching for Disputed payment... (${elapsedMinutes}m elapsed)`);
      
      const queryResponse = await (global as any).testApiClient.queryPayments({
        network: testNetwork,
      });

      // Look for any payment in Disputed state with WaitingForExternalAction
      disputedPayment = queryResponse.Payments.find(
        (payment: any) => payment.onChainState === 'Disputed' && 
                          payment.NextAction.requestedAction === 'WaitingForExternalAction'
      );

      // Show available payment states for debugging
      console.log('🔍 Available payment states:');
      const paymentStates = queryResponse.Payments.slice(0, 5).map((p: any) => ({
        id: p.id.substring(0, 20) + '...',
        onChainState: p.onChainState,
        requestedAction: p.NextAction.requestedAction
      }));
      console.log(JSON.stringify(paymentStates, null, 2));

      if (disputedPayment) {
        console.log(`✅ Found payment in Disputed state ready for authorization`);
        expect(disputedPayment).toBeDefined();
        expect(disputedPayment.onChainState).toBe('Disputed');
        expect(disputedPayment.NextAction.requestedAction).toBe('WaitingForExternalAction');
      } else {
        console.log(`⚠️ No payment found in Disputed+WaitingForExternalAction state yet...`);
        throw new Error('No disputed payment ready for authorization found');
      }
    });
    
    // Restore original timeout and interval
    waitForExpect.defaults.timeout = disputedOriginalTimeout;
    waitForExpect.defaults.interval = disputedOriginalInterval;

    const disputedMinutes = Math.floor((Date.now() - disputedStartTime) / 60000);
    console.log(`✅ Found Disputed payment after ${disputedMinutes}m`);

    console.log(`✅ Found payment ready for authorization:
      - Payment ID: ${disputedPayment.id}
      - Blockchain ID: ${disputedPayment.blockchainIdentifier.substring(0, 50)}...
      - State: ${disputedPayment.onChainState}
      - Action: ${disputedPayment.NextAction.requestedAction}
    `);

    // Track for cleanup
    testCleanupData[0].paymentId = disputedPayment.id;

    // =======================
    // STEP 2: FIRST ADMIN AUTHORIZE REFUND
    // =======================
    console.log('👨‍💼 Step 2: First admin authorization (Disputed → RefundRequested)...');

    const firstAuthorizeRefundResponse = await (global as any).testApiClient.makeRequest('/api/v1/payment/authorize-refund', {
      method: 'POST',
      body: JSON.stringify({
        network: testNetwork,
        blockchainIdentifier: disputedPayment.blockchainIdentifier,
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
    // STEP 3: WAIT FOR REFUND REQUESTED STATE (INFINITE WAIT)
    // =======================
    console.log('⏳ Step 3: Waiting for payment to reach RefundRequested state...');
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
        (payment: any) => payment.blockchainIdentifier === disputedPayment.blockchainIdentifier
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
    // STEP 4: SECOND ADMIN AUTHORIZE REFUND
    // =======================
    console.log('👨‍💼 Step 4: Second admin authorization (final completion)...');

    const secondAuthorizeRefundResponse = await (global as any).testApiClient.makeRequest('/api/v1/payment/authorize-refund', {
      method: 'POST',
      body: JSON.stringify({
        network: testNetwork,
        blockchainIdentifier: disputedPayment.blockchainIdentifier,
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
    console.log(`🎉 REFUND FROM DISPUTED SUCCESSFUL!
      ✅ Found Disputed Payment: ${disputedPayment.id}
      ✅ First Admin Authorization → RefundRequested State  
      ✅ Second Admin Authorization → Final Completion
      ✅ Blockchain ID: ${disputedPayment.blockchainIdentifier.substring(0, 50)}...
      
      🚀 Fast 4-step refund authorization process completed successfully!
    `);
  },
  // Dynamic timeout: 24 hours (effectively infinite for Jest)
  24 * 60 * 60 * 1000
  );
});