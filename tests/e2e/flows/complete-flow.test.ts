import { Network } from '@prisma/client';
import { validateTestWallets, getTestWallet } from '../fixtures/testWallets';
import {
  generateTestPaymentData,
  generateTestRegistrationData,
  getTestScenarios,
  generateRandomSubmitResultHash,
} from '../fixtures/testData';
import { PaymentResponse, PurchaseResponse } from '../utils/apiClient';
import waitForExpect from 'wait-for-expect';

const testNetwork = (process.env.TEST_NETWORK as Network) || Network.Preprod;

describe(`Complete E2E Flow Tests (${testNetwork})`, () => {
  let testCleanupData: Array<{
    registrationId?: string;
    paymentId?: string;
    purchaseId?: string;
    blockchainIdentifier?: string;
    agentIdentifier?: string;
    resultHash?: string;
  }> = [];

  beforeAll(async () => {
    console.log(`🚀 Starting Complete E2E Flow for ${testNetwork}...`);

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
      `✅ Complete E2E Flow environment validated for ${testNetwork}`,
    );
  });

  afterAll(async () => {
    if (testCleanupData.length > 0) {
      console.log('🧹 Complete flow test created:');
      testCleanupData.forEach((item) => {
        console.log(
          `   Registration: ${item.registrationId}, Payment: ${item.paymentId}, Purchase: ${item.purchaseId}`,
        );
      });
    }
  });

  test(
    'should complete full registration → confirmation → payment → purchase → funds locked → submit result flow',
    async () => {
      // =======================
      // STEP 1: REGISTER AGENT (from registration.test.ts)
      // =======================
      console.log('📝 Step 1: Preparing and submitting agent registration...');

      const testWallet = getTestWallet(testNetwork, 'seller', 0);
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
      // STEP 2: WAIT FOR REGISTRATION CONFIRMATION (from registration.test.ts)
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
      // STEP 3: WAIT FOR AGENT IDENTIFIER (from registration.test.ts)
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
      // STEP 4: CREATE PAYMENT (from payment.test.ts)
      // =======================
      console.log('🔍 Step 4: Creating payment...');

      const paymentData = generateTestPaymentData(
        testNetwork,
        confirmedRegistration.agentIdentifier!,
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
      // STEP 5: CREATE PURCHASE (from purchase.test.ts)
      // =======================
      console.log('🔍 Step 5: Creating purchase with matching identifiers...');

      // Create purchase data manually using the original purchaser identifier (exact copy from purchase.test.ts)
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
        metadata: `Complete E2E test purchase - ${new Date().toISOString()}`,
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
      // STEP 6: WAIT FOR FUNDS LOCKED (same logic as submit-result.test.ts)
      // =======================
      console.log(
        '⏳ Step 6: Waiting for payment to reach FundsLocked state...',
      );

      const fundsLockedStartTime = Date.now();
      await waitForExpect(
        async () => {
          const elapsedMinutes = Math.floor(
            (Date.now() - fundsLockedStartTime) / 60000,
          );
          console.log(
            `⏱️  Checking payment state... (${elapsedMinutes}m elapsed)`,
          );

          const queryResponse = await (
            global as any
          ).testApiClient.queryPayments({
            network: testNetwork,
          });

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
        },
        waitForExpect.defaults.timeout,
        30000,
      );

      const fundsLockedMinutes = Math.floor(
        (Date.now() - fundsLockedStartTime) / 60000,
      );
      console.log(
        `✅ Payment reached FundsLocked state after ${fundsLockedMinutes}m`,
      );

      // =======================
      // STEP 7: SUBMIT RESULT (from submit-result.test.ts)
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

      // Verify response structure matches expected schema
      expect(submitResultResponse.inputHash).toBeDefined();
      expect(submitResultResponse.PaymentSource).toBeDefined();
      expect(submitResultResponse.RequestedFunds).toBeDefined();
      expect(Array.isArray(submitResultResponse.RequestedFunds)).toBe(true);

      // Track result hash in cleanup data
      testCleanupData[0].resultHash = randomSHA256Hash;

      console.log(`✅ Result submitted successfully:
        - Previous State: ${paymentResponse.NextAction.requestedAction}
        - New State: ${submitResultResponse.NextAction.requestedAction}
        - Result Hash: ${submitResultResponse.NextAction.resultHash}
      `);

      // =======================
      // FINAL SUCCESS
      // =======================
      const totalFlowMinutes = Math.floor((Date.now() - startTime) / 60000);
      console.log(`🎉 COMPLETE E2E FLOW SUCCESSFUL! (${totalFlowMinutes}m total)
        ✅ Registration: ${confirmedRegistration.name}
        ✅ Agent ID: ${confirmedRegistration.agentIdentifier!}
        ✅ Payment: ${paymentResponse.id}
        ✅ Purchase: ${purchaseResponse.id}  
        ✅ SHA256 Result: ${randomSHA256Hash}
        ✅ Blockchain ID: ${paymentResponse.blockchainIdentifier.substring(0, 50)}...
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
        const bufferTime = 5 * 60 * 1000; // 5 minute buffer
        console.log(
          `🔧 Jest timeout set to ${Math.floor((configTimeout + bufferTime) / 60000)} minutes`,
        );
        return configTimeout + bufferTime;
      }
    })(),
  );
});
