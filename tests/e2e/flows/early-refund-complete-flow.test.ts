/**
 * Early Refund Complete Flow E2E Test
 *
 * This test demonstrates the complete early refund flow where a refund is requested
 * BEFORE submitting results (while funds are still locked).
 *
 * Complete Flow (3 main phases):
 * 1. Agent Registration + Payment + Purchase + Funds Locked + Request Refund → RefundRequested
 * 2. Submit Result while RefundRequested → Disputed
 * 3. Final Admin Authorization - COMPLETE
 *
 * Key Features:
 * - Infinite timeouts for blockchain state transitions
 * - Comprehensive logging and state validation
 * - End-to-end early refund scenario
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

describe(`Early Refund Complete Flow E2E Tests (${testNetwork})`, () => {
  const testCleanupData: Array<{
    registrationId?: string;
    paymentId?: string;
    purchaseId?: string;
    blockchainIdentifier?: string;
    agentIdentifier?: string;
    resultHash?: string;
    refundCompleted?: boolean;
  }> = [{}];

  beforeAll(async () => {
    if (!(global as any).testConfig) {
      throw new Error('Global test configuration not available.');
    }

    const walletValidation = validateTestWallets(testNetwork);
    if (!walletValidation.valid) {
      walletValidation.errors.forEach((error) => console.error(`  - ${error}`));
      throw new Error('Test wallets not properly configured.');
    }

    if (!(global as any).testApiClient) {
      throw new Error('Test API client not initialized.');
    }

    console.log(
      `✅ Early Refund Complete Flow environment validated for ${testNetwork}`,
    );
  });

  afterAll(async () => {
    if (testCleanupData.length > 0) {
      console.log('🧹 Early Refund Complete Flow cleanup data:');
      testCleanupData.forEach((item) => {
        console.log(
          `   Registration: ${item.registrationId}, Payment: ${item.paymentId}, Purchase: ${item.purchaseId}`,
        );
        console.log(
          `   Result Hash: ${item.resultHash}, Refund Completed: ${item.refundCompleted}`,
        );
      });
    }
  });

  test(
    'Complete early refund flow: setup → request refund → submit result → authorize refund',
    async () => {
      console.log('🚀 Starting Early Refund Complete Flow...');
      const flowStartTime = Date.now();

      // ============================
      // PHASE 1: SETUP + REQUEST REFUND (same as Step 1)
      // ============================
      console.log(
        '🏗️ PHASE 1: Agent Registration + Payment + Purchase + Funds Locked + Request Refund',
      );

      // STEP 1.1: REGISTER AGENT
      console.log('📝 Step 1.1: Agent registration...');

      // Get test wallet dynamically from database
      console.log('🔍 Getting test wallet dynamically from database...');
      const testWallet = await getTestWalletFromDatabase(testNetwork, 'seller');
      const testScenario = getTestScenarios().basicAgent;
      const registrationData = generateTestRegistrationData(
        testNetwork,
        testWallet.vkey,
        testScenario,
      );

      const registrationResponse = await (
        global as any
      ).testApiClient.registerAgent(registrationData);

      expect(registrationResponse).toBeDefined();
      expect(registrationResponse.id).toBeDefined();
      expect(registrationResponse.state).toBe('RegistrationRequested');

      console.log(`✅ Registration submitted: ${registrationResponse.id}`);
      testCleanupData[0].registrationId = registrationResponse.id;

      // STEP 1.2: WAIT FOR REGISTRATION CONFIRMATION (INFINITE WAIT)
      console.log('⏳ Step 1.2: Waiting for registration confirmation...');
      console.log(
        '💡 INFINITE WAIT MODE: Will wait indefinitely until blockchain confirmation',
      );
      console.log('💡 Press Ctrl+C to stop if needed');

      const startTime = Date.now();
      let confirmedRegistration: any;

      const registrationTimeout = (global as any).testConfig.timeout
        .registration;
      if (registrationTimeout === 0) {
        waitForExpect.defaults.timeout = Number.MAX_SAFE_INTEGER;
      } else {
        waitForExpect.defaults.timeout = registrationTimeout;
      }
      waitForExpect.defaults.interval = 15000;

      await waitForExpect(async () => {
        const registration = await (
          global as any
        ).testApiClient.getRegistrationById(
          registrationResponse.id,
          testNetwork,
        );

        if (!registration) {
          throw new Error(`Registration ${registrationResponse.id} not found`);
        }

        if (registration.state === 'RegistrationFailed') {
          throw new Error('Registration failed');
        }

        expect(registration.state).toBe('RegistrationConfirmed');
        confirmedRegistration = registration;
      });

      console.log('✅ Registration confirmed successfully!');

      // STEP 1.3: WAIT FOR AGENT IDENTIFIER
      console.log('🎯 Step 1.3: Waiting for agent identifier...');

      const originalTimeout = waitForExpect.defaults.timeout;
      waitForExpect.defaults.timeout = 60000;
      waitForExpect.defaults.interval = 5000;

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
            confirmedRegistration = registration;
            expect(registration.agentIdentifier).toMatch(
              /^[a-f0-9]{56}[a-f0-9]+$/,
            );
            return;
          }

          throw new Error('Agent identifier not yet available');
        },
        60000,
        5000,
      );

      waitForExpect.defaults.timeout = originalTimeout;

      console.log(
        `🎯 Agent identifier created: ${confirmedRegistration.agentIdentifier}`,
      );
      testCleanupData[0].agentIdentifier =
        confirmedRegistration.agentIdentifier;

      // STEP 1.4: CREATE PAYMENT
      console.log('💰 Step 1.4: Creating payment...');

      const paymentData = generateTestPaymentData(
        testNetwork,
        confirmedRegistration.agentIdentifier,
      );
      const originalPurchaserIdentifier = paymentData.identifierFromPurchaser;

      const paymentResponse: PaymentResponse = await (
        global as any
      ).testApiClient.createPayment(paymentData);

      expect(paymentResponse).toBeDefined();
      expect(paymentResponse.id).toBeDefined();
      expect(paymentResponse.blockchainIdentifier).toBeDefined();

      console.log(`✅ Payment created: ${paymentResponse.id}`);
      testCleanupData[0].paymentId = paymentResponse.id;
      testCleanupData[0].blockchainIdentifier =
        paymentResponse.blockchainIdentifier;

      // STEP 1.5: CREATE PURCHASE
      console.log('🛒 Step 1.5: Creating purchase...');

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
        identifierFromPurchaser: originalPurchaserIdentifier,
        metadata: `Early Refund Complete Flow E2E test purchase - ${new Date().toISOString()}`,
      };

      const purchaseResponse: PurchaseResponse = await (
        global as any
      ).testApiClient.createPurchase(purchaseData);

      expect(purchaseResponse).toBeDefined();
      expect(purchaseResponse.id).toBeDefined();
      expect(purchaseResponse.blockchainIdentifier).toBe(
        paymentResponse.blockchainIdentifier,
      );

      console.log(`✅ Purchase created: ${purchaseResponse.id}`);
      testCleanupData[0].purchaseId = purchaseResponse.id;

      // STEP 1.6: WAIT FOR FUNDS LOCKED (INFINITE WAIT)
      console.log('⏳ Step 1.6: Waiting for FundsLocked state...');
      console.log(
        '💡 INFINITE WAIT MODE: Will wait indefinitely until blockchain confirmation',
      );

      const fundsLockedStartTime = Date.now();

      const fundsLockedOriginalTimeout = waitForExpect.defaults.timeout;
      const fundsLockedOriginalInterval = waitForExpect.defaults.interval;
      waitForExpect.defaults.timeout = Number.MAX_SAFE_INTEGER;
      waitForExpect.defaults.interval = 15000;

      await waitForExpect(async () => {
        const elapsedMinutes = Math.floor(
          (Date.now() - fundsLockedStartTime) / 60000,
        );
        console.log(
          `⏱️  Checking FundsLocked state... (${elapsedMinutes}m elapsed)`,
        );

        const queryResponse = await (global as any).testApiClient.queryPayments(
          { network: testNetwork },
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

        console.log(`📊 Payment state: ${currentPayment.onChainState}`);
      });

      waitForExpect.defaults.timeout = fundsLockedOriginalTimeout;
      waitForExpect.defaults.interval = fundsLockedOriginalInterval;

      console.log(`✅ Funds locked confirmed`);

      // STEP 1.7: REQUEST REFUND (WHILE FUNDS LOCKED)
      console.log('💸 Step 1.7: Requesting refund while funds are locked...');

      const refundRequestResponse = await (
        global as any
      ).testApiClient.makeRequest('/api/v1/purchase/request-refund', {
        method: 'POST',
        body: JSON.stringify({
          network: testNetwork,
          blockchainIdentifier: paymentResponse.blockchainIdentifier,
        }),
      });

      expect(refundRequestResponse).toBeDefined();
      expect(refundRequestResponse.id).toBeDefined();
      expect(refundRequestResponse.NextAction).toBeDefined();

      console.log('✅ Refund requested successfully while funds locked');

      // WAIT 25 SECONDS (COOLDOWN PERIOD)
      console.log(
        '⏳ Waiting 25 seconds for cooldown period after refund request...',
      );
      await new Promise((resolve) => setTimeout(resolve, 25000));
      console.log('✅ Cooldown period complete');

      // WAIT FOR REFUND REQUEST BLOCKCHAIN CONFIRMATION (INFINITE WAIT)
      console.log('⏳ Waiting for refund request blockchain confirmation...');
      console.log(
        '💡 Payment should transition to RefundRequested + WaitingForExternalAction',
      );
      console.log(
        '💡 INFINITE WAIT MODE: Will wait indefinitely until blockchain confirmation',
      );

      const refundConfirmationStartTime = Date.now();

      waitForExpect.defaults.timeout = Number.MAX_SAFE_INTEGER;
      waitForExpect.defaults.interval = 15000;

      await waitForExpect(async () => {
        const elapsedMinutes = Math.floor(
          (Date.now() - refundConfirmationStartTime) / 60000,
        );
        console.log(
          `⏱️  Checking refund request confirmation... (${elapsedMinutes}m elapsed)`,
        );

        const queryResponse = await (global as any).testApiClient.queryPayments(
          { network: testNetwork },
        );
        const currentPayment = queryResponse.Payments.find(
          (p: any) =>
            p.blockchainIdentifier === paymentResponse.blockchainIdentifier,
        );

        expect(currentPayment).toBeDefined();
        console.log(
          `📊 Payment state check: ${currentPayment.onChainState}, Action: ${currentPayment.NextAction.requestedAction}`,
        );

        // Wait until the payment reaches RefundRequested + WaitingForExternalAction (blockchain confirmed)
        expect(currentPayment.onChainState).toBe('RefundRequested');
        expect(currentPayment.NextAction.requestedAction).toBe(
          'WaitingForExternalAction',
        );

        console.log(
          `✅ Refund request confirmed on blockchain - ready for submit result`,
        );
      });

      console.log(`✅ Refund request blockchain confirmation completed`);

      console.log(
        `🎉 PHASE 1 COMPLETE! - Setup + Early Refund Request + Blockchain Confirmation`,
      );

      // ============================
      // PHASE 2: SUBMIT RESULT WHILE REFUNDREQUESTED (same as Step 2)
      // ============================
      console.log('📝 PHASE 2: Submit Result While RefundRequested → Disputed');

      // WAIT 25 SECONDS (COOLDOWN PERIOD)
      console.log(
        '⏳ Waiting 25 seconds for cooldown period before submit result...',
      );
      await new Promise((resolve) => setTimeout(resolve, 25000));
      console.log('✅ Cooldown period complete');

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
      expect(submitResultResponse.id).toBeDefined();
      expect(submitResultResponse.NextAction.requestedAction).toBe(
        'SubmitResultRequested',
      );
      expect(submitResultResponse.NextAction.resultHash).toBe(randomSHA256Hash);

      console.log(
        `✅ Result submitted while RefundRequested - waiting for blockchain confirmation`,
      );
      testCleanupData[0].resultHash = randomSHA256Hash;

      // WAIT FOR BLOCKCHAIN STATE TRANSITION (INFINITE WAIT)
      console.log(
        '⏳ Waiting for blockchain confirmation of result submission...',
      );
      console.log(
        '💡 Payment should transition from RefundRequested to Disputed after submit-result',
      );
      console.log(
        '💡 INFINITE WAIT MODE: Will wait indefinitely until blockchain confirmation',
      );

      const stateTransitionStartTime = Date.now();

      waitForExpect.defaults.timeout = Number.MAX_SAFE_INTEGER;
      waitForExpect.defaults.interval = 15000;

      await waitForExpect(async () => {
        const elapsedMinutes = Math.floor(
          (Date.now() - stateTransitionStartTime) / 60000,
        );
        console.log(
          `⏱️  Checking payment state transition... (${elapsedMinutes}m elapsed)`,
        );

        const queryResponse = await (global as any).testApiClient.queryPayments(
          { network: testNetwork },
        );
        const currentPayment = queryResponse.Payments.find(
          (payment: any) =>
            payment.blockchainIdentifier ===
            paymentResponse.blockchainIdentifier,
        );

        expect(currentPayment).toBeDefined();
        console.log(
          `📊 Payment state check: ${currentPayment.onChainState}, Action: ${currentPayment.NextAction.requestedAction}, Result: ${currentPayment.resultHash || 'N/A'}`,
        );

        // After submitting result while RefundRequested, it should transition to Disputed state
        expect(currentPayment.onChainState).toBe('Disputed');
        expect(currentPayment.NextAction.requestedAction).toBe(
          'WaitingForExternalAction',
        );
        expect(currentPayment.resultHash).toBe(randomSHA256Hash);

        console.log(
          `✅ Blockchain confirmation complete - payment transitioned to Disputed with result hash`,
        );
      });

      console.log(`🎉 PHASE 2 COMPLETE! - Submit Result → Disputed State`);

      // ============================
      // PHASE 3: FINAL ADMIN AUTHORIZATION (same as Step 4)
      // ============================
      console.log(
        '👨‍💼 PHASE 3: Final Admin Authorization (Disputed → RefundRequested)',
      );

      // WAIT 25 SECONDS (COOLDOWN PERIOD)
      console.log(
        '⏳ Waiting 25 seconds for cooldown period before authorize refund...',
      );
      await new Promise((resolve) => setTimeout(resolve, 25000));
      console.log('✅ Cooldown period complete');

      const authorizeRefundResponse = await (
        global as any
      ).testApiClient.makeRequest('/api/v1/payment/authorize-refund', {
        method: 'POST',
        body: JSON.stringify({
          network: testNetwork,
          blockchainIdentifier: paymentResponse.blockchainIdentifier,
        }),
      });

      expect(authorizeRefundResponse).toBeDefined();
      expect(authorizeRefundResponse.NextAction.requestedAction).toBe(
        'AuthorizeRefundRequested',
      );

      console.log(`✅ Final admin authorization successful`);

      console.log(`🎉 PHASE 3 COMPLETE! - Final Admin Authorization Done`);

      // Mark refund as completed since RefundRequested is the final state
      testCleanupData[0].refundCompleted = true;

      // ============================
      // FINAL SUCCESS
      // ============================
      const totalFlowMinutes = Math.floor((Date.now() - flowStartTime) / 60000);
      console.log(`
    🎊 EARLY REFUND COMPLETE FLOW SUCCESSFUL! (${totalFlowMinutes}m total)
    
    ✅ Phase 1: Registration + Payment + Purchase + FundsLocked + Early Refund Request
    ✅ Phase 2: Submit Result While RefundRequested → Disputed State  
    ✅ Phase 3: Final Admin Authorization (COMPLETE)
    
    📊 Summary:
      - Registration: ${confirmedRegistration.name}
      - Agent ID: ${confirmedRegistration.agentIdentifier}
      - Payment: ${paymentResponse.id}
      - Purchase: ${purchaseResponse.id}
      - Result Hash: ${randomSHA256Hash}
      - Blockchain ID: ${paymentResponse.blockchainIdentifier.substring(0, 50)}...
      
    🔄 Early refund flow completed:
       1. Refund requested BEFORE submitting results (while funds locked)
       2. Result submitted while in RefundRequested state → Disputed
       3. Final admin authorization completed the refund process
       
    ✅ Early refund flow completed successfully!
    `);
    },
    24 * 60 * 60 * 1000, // 24 hours timeout
  );
});
