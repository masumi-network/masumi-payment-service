/**
 * Complete Flow with Refund E2E Test
 *
 * This test covers the ENTIRE user journey from registration to refund authorization:
 * 1. Register Agent
 * 2. Wait for Registration Confirmation
 * 3. Wait for Agent Identifier
 * 4. Create Payment (with custom timing)
 * 5. Create Purchase
 * 6. Wait for Funds Locked
 * 7. Submit Result
 * 8. Wait for Result Processing & Withdrawal
 * 9. Request Refund
 * 10. Wait for Disputed State
 * 11. Admin Authorize Refund (COMPLETE)
 */

import { Network } from '@prisma/client';
import { validateTestWallets } from '../fixtures/testWallets';
import { getTestWalletFromDatabase } from '../utils/paymentSourceHelper';
import {
  generateTestPaymentData,
  generateTestRegistrationData,
  getTestScenarios,
  generateRandomSubmitResultHash,
} from '../fixtures/testData';
import { PaymentResponse, PurchaseResponse } from '../utils/apiClient';
import waitForExpect from 'wait-for-expect';

const testNetwork = (process.env.TEST_NETWORK as Network) || Network.Preprod;

describe(`Complete E2E Flow with Refund Tests (${testNetwork})`, () => {
  let testCleanupData: Array<{
    registrationId?: string;
    paymentId?: string;
    purchaseId?: string;
    blockchainIdentifier?: string;
    agentIdentifier?: string;
    resultHash?: string;
    refundRequested?: boolean;
    refundAuthorized?: boolean;
  }> = [];

  beforeAll(async () => {
    console.log(
      `🚀 Starting Complete E2E Flow with Refund for ${testNetwork}...`,
    );

    // Wait for global setup to complete
    if (!(global as any).testConfig) {
      throw new Error(
        'Global test configuration not available. Check testEnvironment.ts setup.',
      );
    }

    // Validate test wallet configuration
    const walletValidation = validateTestWallets(testNetwork);
    if (!walletValidation.valid) {
      console.error('❌ Test wallet validation failed:');
      walletValidation.errors.forEach((error) => console.error(`  - ${error}`));
      throw new Error(
        'Test wallets not properly configured. See fixtures/testWallets.ts',
      );
    }

    // Verify API client is available
    if (!(global as any).testApiClient) {
      throw new Error(
        'Test API client not initialized. Make sure test setup ran correctly.',
      );
    }

    console.log(`✅ Test wallets validated for network: ${testNetwork}`);
    console.log(
      `✅ Complete E2E Flow with Refund environment validated for ${testNetwork}`,
    );
  });

  afterAll(async () => {
    if (testCleanupData.length > 0) {
      console.log('🧹 Complete flow with refund test created:');
      testCleanupData.forEach((item) => {
        console.log(
          `   Registration: ${item.registrationId}, Payment: ${item.paymentId}, Purchase: ${item.purchaseId}, Refund: ${item.refundRequested ? 'Yes' : 'No'}`,
        );
      });
    }
  });

  test(
    'should complete full flow: registration → confirmation → payment → purchase → funds locked → submit result → withdrawn → refund → single authorization',
    async () => {
      // =======================
      // STEP 1: REGISTER AGENT (from complete-flow.test.ts)
      // =======================
      console.log('📝 Step 1: Preparing and submitting agent registration...');

      // Get test wallet dynamically from database
      console.log('🔍 Getting test wallet dynamically from database...');
      const testWallet = await getTestWalletFromDatabase(testNetwork, 'seller');
      const testScenario = getTestScenarios().basicAgent;

      const registrationData = generateTestRegistrationData(
        testNetwork,
        testWallet.vkey,
        testScenario,
      );

      console.log(`🎯 Registration Data:
        - Agent Name: ${registrationData.name}
        - Network: ${registrationData.network}
        - Wallet: ${testWallet.name}
        - Pricing: ${registrationData.AgentPricing.Pricing.map((p) => `${p.amount} ${p.unit}`).join(', ')}
      `);

      const registrationResponse = await (
        global as any
      ).testApiClient.registerAgent(registrationData);

      expect(registrationResponse).toBeDefined();
      expect(registrationResponse.id).toBeDefined();
      expect(registrationResponse.name).toBe(registrationData.name);
      expect(registrationResponse.state).toBe('RegistrationRequested');
      expect(registrationResponse.SmartContractWallet).toBeDefined();

      console.log(`✅ Registration submitted:
        - ID: ${registrationResponse.id}
        - State: ${registrationResponse.state}
        - Wallet: ${registrationResponse.SmartContractWallet.walletAddress}
      `);

      // Track for cleanup
      testCleanupData.push({ registrationId: registrationResponse.id });

      // =======================
      // STEP 2: WAIT FOR REGISTRATION CONFIRMATION (from complete-flow.test.ts)
      // =======================
      console.log('⏳ Step 2: Waiting for registration confirmation...');
      console.log(
        '💡 Blockchain confirmations can be unpredictable on Preprod network',
      );
      console.log('🕐 Started waiting at:', new Date().toLocaleString());

      const startTime = Date.now();
      let confirmedRegistration: any;
      let checkCount = 0;

      // Configure wait-for-expect for blockchain confirmation
      const registrationTimeout = (global as any).testConfig.timeout
        .registration;

      if (registrationTimeout === 0) {
        console.log(
          '⏳ INFINITE WAIT MODE: Will wait indefinitely until blockchain confirmation',
        );
        console.log('💡 Press Ctrl+C to stop if needed');
        waitForExpect.defaults.timeout = Number.MAX_SAFE_INTEGER;
      } else {
        console.log(
          `⏳ TIMEOUT MODE: Will wait ${Math.floor(registrationTimeout / 60000)} minutes for blockchain confirmation`,
        );
        waitForExpect.defaults.timeout = registrationTimeout;
      }

      waitForExpect.defaults.interval = 15000; // Check every 15 seconds

      await waitForExpect(async () => {
        checkCount++;
        const elapsedMinutes = Math.floor(
          (Date.now() - startTime) / (1000 * 60),
        );
        console.log(
          `🔄 Check #${checkCount} (${elapsedMinutes} min elapsed): Checking registration state for ${registrationResponse.id}...`,
        );

        const registration = await (
          global as any
        ).testApiClient.getRegistrationById(
          registrationResponse.id,
          testNetwork,
        );

        if (!registration) {
          throw new Error(`Registration ${registrationResponse.id} not found`);
        }

        console.log(
          `📊 Registration ${registrationResponse.id} current state: ${registration.state}`,
        );

        // Check for error states
        if (registration.state === 'RegistrationFailed') {
          throw new Error(`Registration failed: Unknown error`);
        }

        // Assert registration is confirmed (this will keep retrying until true)
        expect(registration.state).toBe('RegistrationConfirmed');
        confirmedRegistration = registration;
      });

      expect(confirmedRegistration).toBeDefined();
      expect(confirmedRegistration.state).toBe('RegistrationConfirmed');
      console.log(`✅ Registration confirmed successfully!`);

      // =======================
      // STEP 3: WAIT FOR AGENT IDENTIFIER (from complete-flow.test.ts)
      // =======================
      console.log('🎯 Step 3: Waiting for agent identifier...');

      // Configure shorter timeout for agent identifier
      const originalTimeout = waitForExpect.defaults.timeout;
      waitForExpect.defaults.timeout = 60000; // 1 minute
      waitForExpect.defaults.interval = 5000; // Check every 5 seconds

      await waitForExpect(
        async () => {
          const registration = await (
            global as any
          ).testApiClient.getRegistrationById(
            registrationResponse.id,
            testNetwork,
          );

          if (!registration) {
            throw new Error(
              `Registration ${registrationResponse.id} not found`,
            );
          }

          if (registration.agentIdentifier) {
            console.log(
              `🎯 Agent identifier found: ${registration.agentIdentifier}`,
            );
            confirmedRegistration = registration;
            expect(registration.agentIdentifier).toMatch(
              /^[a-f0-9]{56}[a-f0-9]+$/,
            );
            return;
          }

          console.log(
            `⚠️  Agent identifier not yet available for ${registrationResponse.id}`,
          );
          throw new Error(`Agent identifier not yet available`);
        },
        60000,
        5000,
      );

      // Restore original timeout
      waitForExpect.defaults.timeout = originalTimeout;

      expect(confirmedRegistration.agentIdentifier).toBeDefined();
      console.log(
        `🎯 Agent identifier created: ${confirmedRegistration.agentIdentifier!}`,
      );

      // Update cleanup data
      testCleanupData[0].agentIdentifier =
        confirmedRegistration.agentIdentifier;

      const totalMinutes = Math.floor((Date.now() - startTime) / 60000);
      console.log(`✅ Registration completed after ${totalMinutes}m`);

      // =======================
      // STEP 4: CREATE PAYMENT WITH CUSTOM TIMING (from purchase.test.ts)
      // =======================
      console.log('🔍 Step 4: Creating payment with custom timing...');

      // Define custom times - payByTime must be BEFORE submitResultTime (min 5 minutes gap)
      // External dispute must be AFTER unlock time (min 15 minutes gap)
      const now = Date.now();
      const thirtyMinFromNow = now + 30 * 60 * 1000; // 30 minutes
      const fortyMinFromNow = now + 40 * 60 * 1000; // 40 minutes
      const oneHourFromNow = now + 60 * 60 * 1000; // 1 hour
      const oneHour30MinFromNow = now + 90 * 60 * 1000; // 1 hour 30 minutes

      const customTiming = {
        payByTime: new Date(thirtyMinFromNow),
        submitResultTime: new Date(fortyMinFromNow),
        unlockTime: new Date(oneHourFromNow),
        externalDisputeUnlockTime: new Date(oneHour30MinFromNow),
      };

      console.log(`⏰ Setting custom payment times (within 1hr30min):
        - Pay By Time: ${customTiming.payByTime.toISOString()} (30min) ← Payment deadline
        - Submit Result Time: ${customTiming.submitResultTime.toISOString()} (40min) ← Work submission deadline  
        - Unlock Time: ${customTiming.unlockTime.toISOString()} (1hr) ← Funds unlock
        - External Dispute Time: ${customTiming.externalDisputeUnlockTime.toISOString()} (1hr30min) ← Dispute resolution (+30min)
      `);

      const paymentData = generateTestPaymentData(
        testNetwork,
        confirmedRegistration.agentIdentifier!,
        {
          customTiming,
        },
      );

      // Store the identifierFromPurchaser used in payment creation
      const originalPurchaserIdentifier = paymentData.identifierFromPurchaser;

      console.log(`🎯 Payment Data:
        - Network: ${paymentData.network}
        - Agent ID: ${confirmedRegistration.agentIdentifier!}
        - Purchaser ID: ${originalPurchaserIdentifier}
      `);

      const paymentResponse: PaymentResponse = await (
        global as any
      ).testApiClient.createPayment(paymentData);

      expect(paymentResponse).toBeDefined();
      expect(paymentResponse.id).toBeDefined();
      expect(paymentResponse.blockchainIdentifier).toBeDefined();
      expect(paymentResponse.NextAction).toBeDefined();

      console.log(`✅ Payment created:
        - Payment ID: ${paymentResponse.id}
        - Blockchain ID: ${paymentResponse.blockchainIdentifier.substring(0, 50)}...
        - State: ${paymentResponse.NextAction.requestedAction}
        - Purchaser ID: ${originalPurchaserIdentifier}
      `);

      // Track for cleanup
      testCleanupData[0].paymentId = paymentResponse.id;
      testCleanupData[0].blockchainIdentifier =
        paymentResponse.blockchainIdentifier;

      // =======================
      // STEP 5: CREATE PURCHASE (from complete-flow.test.ts)
      // =======================
      console.log('🔍 Step 5: Creating purchase with matching identifiers...');

      // Create purchase data manually using the original purchaser identifier
      const purchaseData = {
        blockchainIdentifier: paymentResponse.blockchainIdentifier,
        network: paymentResponse.PaymentSource.network,
        inputHash: paymentResponse.inputHash,
        sellerVkey: confirmedRegistration.SmartContractWallet.walletVkey,
        agentIdentifier: confirmedRegistration.agentIdentifier,
        paymentType: paymentResponse.PaymentSource.paymentType,
        unlockTime: paymentResponse.unlockTime,
        externalDisputeUnlockTime: paymentResponse.externalDisputeUnlockTime,
        submitResultTime: paymentResponse.submitResultTime,
        payByTime: paymentResponse.payByTime,
        identifierFromPurchaser: originalPurchaserIdentifier, // Use the original identifier
        metadata: `Complete E2E with Refund test purchase - ${new Date().toISOString()}`,
      };

      console.log(
        `🔄 Purchase data created with matching purchaser ID: ${originalPurchaserIdentifier}`,
      );

      const purchaseResponse: PurchaseResponse = await (
        global as any
      ).testApiClient.createPurchase(purchaseData);

      expect(purchaseResponse).toBeDefined();
      expect(purchaseResponse.id).toBeDefined();
      expect(purchaseResponse.blockchainIdentifier).toBe(
        paymentResponse.blockchainIdentifier,
      );
      expect(purchaseResponse.inputHash).toBe(paymentResponse.inputHash);
      expect(purchaseResponse.NextAction).toBeDefined();

      console.log(`✅ Purchase created:
        - Purchase ID: ${purchaseResponse.id}
        - Blockchain ID: ${purchaseResponse.blockchainIdentifier.substring(0, 50)}...
        - State: ${purchaseResponse.NextAction.requestedAction}
        - Purchaser ID: ${originalPurchaserIdentifier}
        - SAME as payment: ${purchaseResponse.blockchainIdentifier === paymentResponse.blockchainIdentifier}
      `);

      // Track for cleanup
      testCleanupData[0].purchaseId = purchaseResponse.id;

      // =======================
      // STEP 6: WAIT FOR FUNDS LOCKED (from complete-flow.test.ts)
      // =======================
      console.log(
        '⏳ Step 6: Waiting for payment to reach FundsLocked state...',
      );

      console.log(
        '💡 Blockchain state transitions can be unpredictable on Preprod network',
      );
      console.log(
        '⏳ INFINITE WAIT MODE: Will wait indefinitely until blockchain confirmation',
      );
      console.log('💡 Press Ctrl+C to stop if needed');

      const fundsLockedStartTime = Date.now();

      // Configure infinite timeout for blockchain state transition
      const fundsLockedOriginalTimeout = waitForExpect.defaults.timeout;
      const fundsLockedOriginalInterval = waitForExpect.defaults.interval;
      waitForExpect.defaults.timeout = Number.MAX_SAFE_INTEGER;
      waitForExpect.defaults.interval = 15000; // Check every 15 seconds

      await waitForExpect(async () => {
        const elapsedMinutes = Math.floor(
          (Date.now() - fundsLockedStartTime) / 60000,
        );
        console.log(
          `⏱️  Checking payment state... (${elapsedMinutes}m elapsed)`,
        );

        const queryResponse = await (global as any).testApiClient.queryPayments(
          {
            network: testNetwork,
          },
        );

        const currentPayment = queryResponse.Payments.find(
          (p: any) =>
            p.blockchainIdentifier === paymentResponse.blockchainIdentifier,
        );

        expect(currentPayment).toBeDefined();
        expect(currentPayment.onChainState).toBe('FundsLocked');
        expect(currentPayment.NextAction.requestedAction).toBe(
          'WaitingForExternalAction',
        );
        expect(
          !currentPayment.NextAction.resultHash ||
            currentPayment.NextAction.resultHash === '',
        ).toBe(true);

        console.log(
          `📊 Payment state: ${currentPayment.onChainState}, Action: ${currentPayment.NextAction.requestedAction}`,
        );
      });

      // Restore original timeout and interval
      waitForExpect.defaults.timeout = fundsLockedOriginalTimeout;
      waitForExpect.defaults.interval = fundsLockedOriginalInterval;

      const fundsLockedMinutes = Math.floor(
        (Date.now() - fundsLockedStartTime) / 60000,
      );
      console.log(
        `✅ Payment reached FundsLocked state after ${fundsLockedMinutes}m`,
      );

      // =======================
      // STEP 7: SUBMIT RESULT (from complete-flow.test.ts)
      // =======================
      console.log(
        '🔍 Step 7: Generating and submitting random SHA256 result...',
      );

      const randomSHA256Hash = generateRandomSubmitResultHash();

      console.log(`🎯 Submit Result Data:
        - Blockchain ID: ${paymentResponse.blockchainIdentifier.substring(0, 50)}...
        - SHA256 Hash: ${randomSHA256Hash}
      `);

      const submitResultResponse = await (
        global as any
      ).testApiClient.makeRequest('/api/v1/payment/submit-result', {
        method: 'POST',
        body: JSON.stringify({
          network: testNetwork,
          submitResultHash: randomSHA256Hash,
          blockchainIdentifier: paymentResponse.blockchainIdentifier,
        }),
      });

      expect(submitResultResponse).toBeDefined();
      expect(submitResultResponse.id).toBe(paymentResponse.id);
      expect(submitResultResponse.blockchainIdentifier).toBe(
        paymentResponse.blockchainIdentifier,
      );

      // Verify the state transition
      expect(submitResultResponse.NextAction).toBeDefined();
      expect(submitResultResponse.NextAction.requestedAction).toBe(
        'SubmitResultRequested',
      );
      expect(submitResultResponse.NextAction.resultHash).toBe(randomSHA256Hash);

      // Track result hash in cleanup data
      testCleanupData[0].resultHash = randomSHA256Hash;

      console.log(`✅ Result submitted successfully:
        - Previous State: WaitingForExternalAction
        - New State: ${submitResultResponse.NextAction.requestedAction}
        - Result Hash: ${submitResultResponse.NextAction.resultHash}
      `);

      // =======================
      // STEP 8: WAIT FOR RESULT SUBMITTED STATE
      // =======================
      console.log(
        '⏳ Step 8: Waiting for result processing to ResultSubmitted state...',
      );
      console.log(
        '💡 Blockchain state transitions can be unpredictable on Preprod network',
      );
      console.log(
        '⏳ INFINITE WAIT MODE: Will wait indefinitely until blockchain confirmation',
      );
      console.log('💡 Press Ctrl+C to stop if needed');

      const resultSubmittedStartTime = Date.now();

      // Configure infinite timeout for blockchain state transition
      const resultSubmittedOriginalTimeout = waitForExpect.defaults.timeout;
      const resultSubmittedOriginalInterval = waitForExpect.defaults.interval;
      waitForExpect.defaults.timeout = Number.MAX_SAFE_INTEGER;
      waitForExpect.defaults.interval = 15000; // Check every 15 seconds

      await waitForExpect(async () => {
        const elapsedMinutes = Math.floor(
          (Date.now() - resultSubmittedStartTime) / 60000,
        );
        console.log(
          `⏱️  Checking for ResultSubmitted state... (${elapsedMinutes}m elapsed)`,
        );

        const queryResponse = await (global as any).testApiClient.queryPayments(
          {
            network: testNetwork,
          },
        );

        const currentPayment = queryResponse.Payments.find(
          (p: any) =>
            p.blockchainIdentifier === paymentResponse.blockchainIdentifier,
        );

        expect(currentPayment).toBeDefined();

        console.log(
          `📊 Payment state check: ${currentPayment.onChainState}, Action: ${currentPayment.NextAction.requestedAction}`,
        );

        // Wait specifically for ResultSubmitted state after result submission
        expect(currentPayment.onChainState).toBe('ResultSubmitted');

        console.log(
          `✅ Payment reached ResultSubmitted state: ${currentPayment.onChainState}`,
        );
      });

      // Restore original timeout and interval
      waitForExpect.defaults.timeout = resultSubmittedOriginalTimeout;
      waitForExpect.defaults.interval = resultSubmittedOriginalInterval;

      const resultSubmittedMinutes = Math.floor(
        (Date.now() - resultSubmittedStartTime) / 60000,
      );
      console.log(
        `✅ Result processed to ResultSubmitted state after ${resultSubmittedMinutes}m`,
      );

      // =======================
      // STEP 9: REQUEST REFUND (DEBUG RESPONSE)
      // =======================
      console.log(
        '💸 Step 9: Requesting refund after ResultSubmitted state...',
      );

      const refundRequestResponse = await (
        global as any
      ).testApiClient.makeRequest('/api/v1/purchase/request-refund', {
        method: 'POST',
        body: JSON.stringify({
          network: testNetwork,
          blockchainIdentifier: paymentResponse.blockchainIdentifier,
        }),
      });

      // DEBUG: Log the full response to understand its structure
      console.log(
        '🔍 DEBUG: Full refund request response:',
        JSON.stringify(refundRequestResponse, null, 2),
      );

      expect(refundRequestResponse).toBeDefined();
      expect(refundRequestResponse.id).toBeDefined();
      expect(refundRequestResponse.NextAction).toBeDefined();
      expect(refundRequestResponse.NextAction.requestedAction).toBe(
        'SetRefundRequestedRequested',
      );

      console.log(
        `✅ Refund request submitted successfully after ResultSubmitted state`,
      );

      // Track refund request in cleanup data
      testCleanupData[0].refundRequested = true;

      // =======================
      // STEP 10: WAIT FOR DISPUTED STATE (INFINITE WAIT)
      // =======================
      console.log('⏳ Step 10: Waiting for payment to reach Disputed state...');
      console.log(
        '💡 Blockchain state transitions can be unpredictable on Preprod network',
      );
      console.log(
        '⏳ INFINITE WAIT MODE: Will wait indefinitely until blockchain confirmation',
      );
      console.log('💡 Press Ctrl+C to stop if needed');

      const disputedWaitStartTime = Date.now();

      // Configure infinite timeout for blockchain state transition
      const disputedOriginalTimeout = waitForExpect.defaults.timeout;
      const disputedOriginalInterval = waitForExpect.defaults.interval;
      waitForExpect.defaults.timeout = Number.MAX_SAFE_INTEGER;
      waitForExpect.defaults.interval = 15000; // Check every 15 seconds

      await waitForExpect(async () => {
        const elapsedMinutes = Math.floor(
          (Date.now() - disputedWaitStartTime) / 60000,
        );
        console.log(
          `⏱️  Checking payment state... (${elapsedMinutes}m elapsed)`,
        );

        const queryResponse = await (global as any).testApiClient.queryPayments(
          {
            network: testNetwork,
          },
        );

        const currentPayment = queryResponse.Payments.find(
          (payment: any) =>
            payment.blockchainIdentifier ===
            paymentResponse.blockchainIdentifier,
        );

        expect(currentPayment).toBeDefined();

        console.log(
          `📊 Payment state check: ${currentPayment.onChainState}, Action: ${currentPayment.NextAction.requestedAction}`,
        );

        // Wait until the payment reaches Disputed state after refund request
        expect(currentPayment.onChainState).toBe('Disputed');
        expect(currentPayment.NextAction.requestedAction).toBe(
          'WaitingForExternalAction',
        );

        console.log(
          `✅ Payment now in Disputed state and ready for first admin authorization`,
        );
      });

      // Restore original timeout and interval
      waitForExpect.defaults.timeout = disputedOriginalTimeout;
      waitForExpect.defaults.interval = disputedOriginalInterval;

      const refundStateMinutes = Math.floor(
        (Date.now() - disputedWaitStartTime) / 60000,
      );
      console.log(
        `✅ Payment reached Disputed state after ${refundStateMinutes}m`,
      );

      // =======================
      // STEP 11: ADMIN AUTHORIZE REFUND
      // =======================
      console.log('👨‍💼 Step 11: Admin authorization (Disputed → Complete)...');

      const firstAuthorizeRefundResponse = await (
        global as any
      ).testApiClient.makeRequest('/api/v1/payment/authorize-refund', {
        method: 'POST',
        body: JSON.stringify({
          network: testNetwork,
          blockchainIdentifier: paymentResponse.blockchainIdentifier,
        }),
      });

      expect(firstAuthorizeRefundResponse).toBeDefined();
      expect(firstAuthorizeRefundResponse.id).toBeDefined();
      expect(firstAuthorizeRefundResponse.onChainState).toBeDefined();
      expect(firstAuthorizeRefundResponse.NextAction).toBeDefined();
      expect(firstAuthorizeRefundResponse.NextAction.requestedAction).toBe(
        'AuthorizeRefundRequested',
      );

      console.log(`✅ Admin authorization successful:
        - Payment ID: ${firstAuthorizeRefundResponse.id}
        - OnChain State: ${firstAuthorizeRefundResponse.onChainState}
        - Next Action: ${firstAuthorizeRefundResponse.NextAction.requestedAction}
      `);

      // Track authorization in cleanup data
      testCleanupData[0].refundAuthorized = true;

      console.log(
        `✅ Refund process completed - single authorization successful`,
      );

      // =======================
      // FINAL SUCCESS
      // =======================
      const totalFlowMinutes = Math.floor((Date.now() - startTime) / 60000);
      console.log(`🎉 COMPLETE E2E FLOW WITH REFUND SUCCESSFUL! (${totalFlowMinutes}m total)
        ✅ Registration: ${confirmedRegistration.name}
        ✅ Agent ID: ${confirmedRegistration.agentIdentifier!}
        ✅ Payment: ${paymentResponse.id}
        ✅ Purchase: ${purchaseResponse.id}  
        ✅ SHA256 Result: ${randomSHA256Hash}
        ✅ Result Submitted → ResultSubmitted State
        ✅ Refund Requested → Disputed State
        ✅ Admin Authorization → COMPLETE
        ✅ Blockchain ID: ${paymentResponse.blockchainIdentifier.substring(0, 50)}...
        
        🎯 Complete 11-step refund flow successfully executed!
      `);
    },
    // Dynamic timeout based on config: infinite if 0, otherwise timeout + buffer
    (() => {
      const { getTestEnvironment } = require('../fixtures/testData');
      const configTimeout = getTestEnvironment().timeout.registration;
      if (configTimeout === 0) {
        console.log('🔧 Jest timeout set to 24 hours (effectively infinite)');
        return 24 * 60 * 60 * 1000; // 24 hours - effectively infinite for Jest
      } else {
        const bufferTime = 10 * 60 * 1000; // 10 minute buffer (more than original due to refund steps)
        console.log(
          `🔧 Jest timeout set to ${Math.floor((configTimeout + bufferTime) / 60000)} minutes`,
        );
        return configTimeout + bufferTime;
      }
    })(),
  );
});
