import { Network } from '@prisma/client';
import { validateTestWallets, getTestWallet } from '../fixtures/testWallets';
import {
  generateTestPaymentData,
  generateTestRegistrationData,
  getTestScenarios,
} from '../fixtures/testData';
import { PaymentResponse, PurchaseResponse } from '../utils/apiClient';
import waitForExpect from 'wait-for-expect';

const testNetwork = (process.env.TEST_NETWORK as Network) || Network.Preprod;

describe(`Refund Flow E2E Tests (${testNetwork})`, () => {
  let testCleanupData: Array<{
    registrationId?: string;
    paymentId?: string;
    purchaseId?: string;
    blockchainIdentifier?: string;
    agentIdentifier?: string;
    refundRequested?: boolean;
    refundAuthorized?: boolean;
  }> = [];

  beforeAll(async () => {
    console.log(`🚀 Starting Refund Flow E2E Test for ${testNetwork}...`);

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
    console.log(`✅ Refund Flow E2E environment validated for ${testNetwork}`);
  });

  afterAll(async () => {
    if (testCleanupData.length > 0) {
      console.log('🧹 Refund flow test created:');
      testCleanupData.forEach((item) => {
        console.log(`   Registration: ${item.registrationId}, Payment: ${item.paymentId}, Purchase: ${item.purchaseId}, Refund: ${item.refundRequested ? 'Requested' : 'No'}, Authorized: ${item.refundAuthorized ? 'Yes' : 'No'}`);
      });
    }
  });

  test(
    'should complete registration → funds locked → refund request → admin authorization flow',
    async () => {
      // =======================
      // PHASE 1: SETUP (Steps 1-6) - Proven Working Code from complete-flow.test.ts
      // =======================
      
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
      // STEP 2: WAIT FOR REGISTRATION CONFIRMATION (exact copy from registration.test.ts)
      // =======================
      console.log('⏳ Step 2: Waiting for registration confirmation...');
      console.log('💡 Blockchain confirmations can be unpredictable on Preprod network');
      console.log('🕐 Started waiting at:', new Date().toLocaleString());

      const startTime = Date.now();
      let confirmedRegistration: any;
      let checkCount = 0;

      // Configure wait-for-expect for blockchain confirmation
      const registrationTimeout = (global as any).testConfig.timeout.registration;

      if (registrationTimeout === 0) {
        console.log('⏳ INFINITE WAIT MODE: Will wait indefinitely until blockchain confirmation');
        console.log('💡 Press Ctrl+C to stop if needed');
        waitForExpect.defaults.timeout = Number.MAX_SAFE_INTEGER;
      } else {
        console.log(`⏳ TIMEOUT MODE: Will wait ${Math.floor(registrationTimeout / 60000)} minutes for blockchain confirmation`);
        waitForExpect.defaults.timeout = registrationTimeout;
      }

      waitForExpect.defaults.interval = 15000; // Check every 15 seconds

      await waitForExpect(async () => {
        checkCount++;
        const elapsedMinutes = Math.floor((Date.now() - startTime) / (1000 * 60));
        console.log(`🔄 Check #${checkCount} (${elapsedMinutes} min elapsed): Checking registration state for ${registrationResponse.id}...`);
        
        const registration = await (global as any).testApiClient.getRegistrationById(
          registrationResponse.id,
          testNetwork,
        );

        if (!registration) {
          throw new Error(`Registration ${registrationResponse.id} not found`);
        }

        console.log(`📊 Registration ${registrationResponse.id} current state: ${registration.state}`);

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

      await waitForExpect(async () => {
        const registration = await (global as any).testApiClient.getRegistrationById(
          registrationResponse.id,
          testNetwork,
        );

        if (!registration) {
          throw new Error(`Registration ${registrationResponse.id} not found`);
        }

        if (registration.agentIdentifier) {
          console.log(`🎯 Agent identifier found: ${registration.agentIdentifier}`);
          confirmedRegistration = registration;
          expect(registration.agentIdentifier).toMatch(/^[a-f0-9]{56}[a-f0-9]+$/);
          return;
        }

        console.log(`⚠️  Agent identifier not yet available for ${registrationResponse.id}`);
        throw new Error(`Agent identifier not yet available`);
      }, 60000, 5000);

      // Restore original timeout
      waitForExpect.defaults.timeout = originalTimeout;

      expect(confirmedRegistration.agentIdentifier).toBeDefined();
      console.log(`🎯 Agent identifier created: ${confirmedRegistration.agentIdentifier!}`);

      // Update cleanup data
      testCleanupData[0].agentIdentifier = confirmedRegistration.agentIdentifier;

      const totalMinutes = Math.floor((Date.now() - startTime) / 60000);
      console.log(`✅ Registration completed after ${totalMinutes}m`);

      // =======================
      // STEP 4: CREATE PAYMENT (from payment.test.ts)
      // =======================
      console.log('🔍 Step 4: Creating payment...');

      const paymentData = generateTestPaymentData(testNetwork, confirmedRegistration.agentIdentifier!);

      // Store the identifierFromPurchaser used in payment creation
      const originalPurchaserIdentifier = paymentData.identifierFromPurchaser;

      console.log(`🎯 Payment Data:
        - Network: ${paymentData.network}
        - Agent ID: ${confirmedRegistration.agentIdentifier!}
        - Purchaser ID: ${originalPurchaserIdentifier}
      `);

      const paymentResponse: PaymentResponse = await (global as any).testApiClient.createPayment(paymentData);

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
      testCleanupData[0].blockchainIdentifier = paymentResponse.blockchainIdentifier;

      // =======================
      // STEP 5: CREATE PURCHASE (from purchase.test.ts)
      // =======================
      console.log('🔍 Step 5: Creating purchase with matching identifiers...');

      // Create purchase data with custom time values (2 hours from now)
      const now = Date.now();
      const twoHoursFromNow = now + (2 * 60 * 60 * 1000); // 2 hours in milliseconds
      const fourHoursFromNow = now + (4 * 60 * 60 * 1000); // 4 hours in milliseconds
      const eightHoursFromNow = now + (8 * 60 * 60 * 1000); // 8 hours in milliseconds

      console.log(`⏰ Setting custom times:
        - Created: ${new Date(now).toISOString()}
        - Submit Result Time: ${new Date(twoHoursFromNow).toISOString()} (2hrs)
        - Unlock Time: ${new Date(twoHoursFromNow).toISOString()} (2hrs)
        - Pay By Time: ${new Date(fourHoursFromNow).toISOString()} (4hrs)
        - External Dispute Unlock: ${new Date(eightHoursFromNow).toISOString()} (8hrs)
      `);

      const purchaseData = {
        blockchainIdentifier: paymentResponse.blockchainIdentifier,
        network: paymentResponse.PaymentSource.network,
        inputHash: paymentResponse.inputHash,
        sellerVkey: confirmedRegistration.SmartContractWallet.walletVkey,
        agentIdentifier: confirmedRegistration.agentIdentifier,
        paymentType: paymentResponse.PaymentSource.paymentType,
        unlockTime: twoHoursFromNow.toString(),
        externalDisputeUnlockTime: eightHoursFromNow.toString(),
        submitResultTime: twoHoursFromNow.toString(),
        payByTime: fourHoursFromNow.toString(),
        identifierFromPurchaser: originalPurchaserIdentifier, // Use the original identifier
        metadata: `Refund flow E2E test purchase - ${new Date().toISOString()}`,
      };

      console.log(`🔄 Purchase data created with matching purchaser ID: ${originalPurchaserIdentifier}`);

      const purchaseResponse: PurchaseResponse = await (global as any).testApiClient.createPurchase(purchaseData);

      expect(purchaseResponse).toBeDefined();
      expect(purchaseResponse.id).toBeDefined();
      expect(purchaseResponse.blockchainIdentifier).toBe(paymentResponse.blockchainIdentifier);
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
      // STEP 6: WAIT FOR FUNDS LOCKED (same logic as complete-flow.test.ts)
      // =======================
      console.log('⏳ Step 6: Waiting for payment to reach FundsLocked state...');
      
      const fundsLockedStartTime = Date.now();
      await waitForExpect(async () => {
        const elapsedMinutes = Math.floor((Date.now() - fundsLockedStartTime) / 60000);
        console.log(`⏱️  Checking payment state... (${elapsedMinutes}m elapsed)`);
        
        const queryResponse = await (global as any).testApiClient.queryPayments({
          network: testNetwork,
        });

        const currentPayment = queryResponse.Payments.find(
          (p: any) => p.blockchainIdentifier === paymentResponse.blockchainIdentifier
        );

        expect(currentPayment).toBeDefined();
        expect(currentPayment.onChainState).toBe('FundsLocked');
        expect(currentPayment.NextAction.requestedAction).toBe('WaitingForExternalAction');
        
        console.log(`📊 Payment state: ${currentPayment.onChainState}, Action: ${currentPayment.NextAction.requestedAction}`);
      }, waitForExpect.defaults.timeout, 30000);

      const fundsLockedMinutes = Math.floor((Date.now() - fundsLockedStartTime) / 60000);
      console.log(`✅ Payment reached FundsLocked state after ${fundsLockedMinutes}m`);

      // =======================
      // PHASE 2: REFUND PROCESS (Steps 7-9) - NEW IMPLEMENTATION
      // =======================

      // =======================
      // STEP 7: QUERY PURCHASE STATUS (GET /purchase/)
      // =======================
      console.log('🔍 Step 7: Querying purchase status to verify funds locked state...');

      const purchaseQueryResponse = await (global as any).testApiClient.queryPurchases({
        network: testNetwork,
        limit: 10,
      });

      expect(purchaseQueryResponse).toBeDefined();
      expect(purchaseQueryResponse.Purchases).toBeDefined();
      expect(Array.isArray(purchaseQueryResponse.Purchases)).toBe(true);

      // Find our specific purchase
      const ourPurchase = purchaseQueryResponse.Purchases.find(
        (p: any) => p.blockchainIdentifier === paymentResponse.blockchainIdentifier
      );

      expect(ourPurchase).toBeDefined();
      expect(ourPurchase.blockchainIdentifier).toBe(paymentResponse.blockchainIdentifier);

      console.log(`✅ Purchase query successful:
        - Purchase ID: ${ourPurchase.id}
        - Blockchain ID: ${ourPurchase.blockchainIdentifier.substring(0, 50)}...
        - State: ${ourPurchase.NextAction.requestedAction}
        - Ready for refund: ${ourPurchase.NextAction.requestedAction === 'WaitingForExternalAction' ? 'Yes' : 'No'}
      `);

      // =======================
      // STEP 8: REQUEST REFUND (POST /purchase/request-refund/)
      // =======================
      console.log('🔄 Step 8: Requesting refund via API...');

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
      expect(refundRequestResponse.id).toBe(ourPurchase.id);
      expect(refundRequestResponse.blockchainIdentifier).toBe(paymentResponse.blockchainIdentifier);

      // Verify the state transition after refund request
      expect(refundRequestResponse.NextAction).toBeDefined();

      console.log(`✅ Refund request submitted successfully:
        - Purchase ID: ${refundRequestResponse.id}
        - Previous State: ${ourPurchase.NextAction.requestedAction}
        - New State: ${refundRequestResponse.NextAction.requestedAction}
        - Blockchain ID: ${refundRequestResponse.blockchainIdentifier.substring(0, 50)}...
      `);

      // Track refund request
      testCleanupData[0].refundRequested = true;

      // =======================
      // STEP 8.5: WAIT FOR PAYMENT TO REACH DISPUTED STATE (NEW)
      // =======================
      console.log('⏳ Step 8.5: Waiting for payment to reach Disputed state (required for admin authorization)...');
      
      const refundStateStartTime = Date.now();
      await waitForExpect(async () => {
        const elapsedMinutes = Math.floor((Date.now() - refundStateStartTime) / 60000);
        console.log(`⏱️  Checking payment state for admin authorization... (${elapsedMinutes}m elapsed)`);
        
        const paymentQueryResponse = await (global as any).testApiClient.queryPayments({
          network: testNetwork,
        });

        const currentPayment = paymentQueryResponse.Payments.find(
          (p: any) => p.blockchainIdentifier === paymentResponse.blockchainIdentifier
        );

        expect(currentPayment).toBeDefined();
        
        // Check payment state - authorize-refund endpoint accepts RefundRequested state  
        console.log(`📊 Payment state check: ${currentPayment.onChainState}, Action: ${currentPayment.NextAction.requestedAction}`);
        
        // Wait until the payment reaches RefundRequested state (required for admin authorization)
        expect(currentPayment.onChainState).toBe('RefundRequested');
        expect(currentPayment.NextAction.requestedAction).toBe('WaitingForExternalAction');
        
        console.log(`✅ Payment ready for admin authorization: ${currentPayment.onChainState}`);
      }, waitForExpect.defaults.timeout, 10000); // Infinite wait, 10-second intervals

      const refundStateMinutes = Math.floor((Date.now() - refundStateStartTime) / 60000);
      console.log(`✅ Payment reached Disputed state after ${refundStateMinutes}m (ready for admin authorization)`);

      // =======================
      // STEP 9: AUTHORIZE REFUND - ADMIN ACTION (POST /payment/authorize-refund/)
      // =======================
      console.log('🔐 Step 9: Admin authorizing refund...');

      const refundAuthorizationResponse = await (
        global as any
      ).testApiClient.makeRequest('/api/v1/payment/authorize-refund', {
        method: 'POST',
        body: JSON.stringify({
          network: testNetwork,
          blockchainIdentifier: paymentResponse.blockchainIdentifier,
        }),
      });

      expect(refundAuthorizationResponse).toBeDefined();
      expect(refundAuthorizationResponse.id).toBe(paymentResponse.id);
      expect(refundAuthorizationResponse.blockchainIdentifier).toBe(paymentResponse.blockchainIdentifier);

      // Verify the final state transition after admin authorization
      expect(refundAuthorizationResponse.NextAction).toBeDefined();

      console.log(`✅ Refund authorized successfully by admin:
        - Payment ID: ${refundAuthorizationResponse.id}
        - Previous State: ${paymentResponse.NextAction.requestedAction}
        - Final State: ${refundAuthorizationResponse.NextAction.requestedAction}
        - Blockchain ID: ${refundAuthorizationResponse.blockchainIdentifier.substring(0, 50)}...
      `);

      // Track refund authorization
      testCleanupData[0].refundAuthorized = true;

      // =======================
      // FINAL SUCCESS
      // =======================
      const totalFlowMinutes = Math.floor((Date.now() - startTime) / 60000);
      console.log(`🎉 REFUND FLOW E2E TEST SUCCESSFUL! (${totalFlowMinutes}m total)
        ✅ Registration: ${confirmedRegistration.name}
        ✅ Agent ID: ${confirmedRegistration.agentIdentifier!}
        ✅ Payment: ${paymentResponse.id}
        ✅ Purchase: ${purchaseResponse.id}  
        ✅ Refund Requested: ${testCleanupData[0].refundRequested ? 'Yes' : 'No'}
        ✅ Refund Authorized: ${testCleanupData[0].refundAuthorized ? 'Yes' : 'No'}
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
        console.log(`🔧 Jest timeout set to ${Math.floor((configTimeout + bufferTime) / 60000)} minutes`);
        return configTimeout + bufferTime;
      }
    })(),
  );
});