import { Network } from '@prisma/client';
import { validateTestWallets } from '../fixtures/testWallets';
import { generateTestPaymentData } from '../fixtures/testData';
import { PaymentResponse } from '../utils/apiClient';

const testNetwork = (process.env.TEST_NETWORK as Network) || Network.Preprod;

describe(`Payment E2E Tests (${testNetwork})`, () => {
  let testCleanupData: Array<{
    paymentId?: string;
    blockchainIdentifier?: string;
  }> = [];

  beforeAll(async () => {
    console.log(`🔧 Setting up Payment E2E tests for ${testNetwork}...`);

    // Validate test environment and wallet configuration
    const walletValidation = validateTestWallets(testNetwork);
    if (!walletValidation.valid) {
      console.error('❌ Test wallet validation failed:');
      walletValidation.errors.forEach((error) =>
        console.error(`   - ${error}`),
      );
      throw new Error('Test environment not properly configured');
    }

    // Verify API client is available
    if (!(global as any).testApiClient) {
      throw new Error(
        'Test API client not initialized. Make sure test setup ran correctly.',
      );
    }

    console.log(`✅ Payment test environment validated for ${testNetwork}`);
  });

  afterAll(async () => {
    if (testCleanupData.length > 0) {
      console.log(
        `📝 Test cleanup data (${testCleanupData.length} payments created):`,
      );
      testCleanupData.forEach((data, index) => {
        console.log(
          `   ${index + 1}. Payment ID: ${data.paymentId}, Blockchain ID: ${data.blockchainIdentifier?.substring(0, 50)}...`,
        );
      });
    }
  });

  beforeEach(() => {
    testCleanupData = [];
  });

  describe('Payment Creation (POST) - Requires confirmed agent registration', () => {
    test(
      'should create payment request using confirmed agent from registry',
      async () => {
        // Arrange - Get a confirmed agent from the registry
        console.log('📝 Preparing payment creation test...');
        console.log('🔍 Fetching confirmed agents from registry...');

        const registryResponse = await (
          global as any
        ).testApiClient.queryRegistry({
          network: testNetwork,
        });

        // Find a confirmed agent with agentIdentifier
        const confirmedAgent = registryResponse.Assets.find(
          (agent: any) =>
            agent.state === 'RegistrationConfirmed' &&
            agent.agentIdentifier !== null &&
            agent.agentIdentifier !== undefined,
        );

        if (!confirmedAgent) {
          console.log(
            '⚠️  No confirmed agents found in registry. Skipping test.',
          );
          console.log(
            '💡 Run registration test first to create a confirmed agent.',
          );
          return; // Skip this test if no confirmed agents exist
        }

        console.log(`✅ Found confirmed agent:
        - ID: ${confirmedAgent.id}
        - Name: ${confirmedAgent.name}
        - Agent Identifier: ${confirmedAgent.agentIdentifier}
        - State: ${confirmedAgent.state}
        - Pricing: ${confirmedAgent.AgentPricing.Pricing.map((p: any) => `${p.amount} ${p.unit}`).join(', ')}
      `);

        const paymentData = generateTestPaymentData(
          testNetwork,
          confirmedAgent.agentIdentifier,
        );

        console.log(`🎯 Payment Data for Agent "${confirmedAgent.name}":
        - Network: ${paymentData.network}
        - Agent ID: ${paymentData.agentIdentifier}
        - Input Hash: ${paymentData.inputHash}
        - Purchaser ID: ${paymentData.identifierFromPurchaser}
        - Payment Type: ${paymentData.paymentType}
        - Agent Pricing: ${confirmedAgent.AgentPricing.Pricing.map((p: any) => `${p.amount} ${p.unit}`).join(', ')}
      `);

        // Act - Create payment request
        console.log('🚀 Creating payment request...');
        let paymentResponse: PaymentResponse;

        try {
          paymentResponse = await (global as any).testApiClient.createPayment(
            paymentData,
          );
        } catch (error) {
          console.error('❌ Payment creation failed:', error);
          throw error;
        }

        // Assert - Verify payment creation response
        expect(paymentResponse).toBeDefined();
        expect(paymentResponse.id).toBeDefined();
        expect(paymentResponse.blockchainIdentifier).toBeDefined();
        expect(paymentResponse.inputHash).toBe(paymentData.inputHash);
        expect(paymentResponse.NextAction).toBeDefined();
        expect(paymentResponse.NextAction.requestedAction).toBe(
          'WaitingForExternalAction',
        );

        // Verify timing fields (API returns Unix timestamps as strings)
        expect(paymentResponse.payByTime).toBe(
          new Date(paymentData.payByTime).getTime().toString(),
        );
        expect(paymentResponse.submitResultTime).toBe(
          new Date(paymentData.submitResultTime).getTime().toString(),
        );
        expect(paymentResponse.unlockTime).toBe(
          new Date(paymentData.unlockTime!).getTime().toString(),
        );
        expect(paymentResponse.externalDisputeUnlockTime).toBe(
          new Date(paymentData.externalDisputeUnlockTime!).getTime().toString(),
        );

        // Verify payment source and wallet info
        expect(paymentResponse.PaymentSource).toBeDefined();
        expect(paymentResponse.PaymentSource.network).toBe(testNetwork);
        expect(paymentResponse.SmartContractWallet).toBeDefined();

        // Verify requested funds (should be populated based on agent pricing)
        expect(paymentResponse.RequestedFunds).toBeDefined();
        expect(Array.isArray(paymentResponse.RequestedFunds)).toBe(true);

        // Verify the payment was created (blockchain identifier should be present)
        expect(paymentResponse.blockchainIdentifier).toBeDefined();
        expect(paymentResponse.blockchainIdentifier.length).toBeGreaterThan(0);

        console.log(`✅ Payment created successfully for agent "${confirmedAgent.name}":
        - Payment ID: ${paymentResponse.id}
        - Blockchain ID: ${paymentResponse.blockchainIdentifier.substring(0, 50)}...
        - State: ${paymentResponse.NextAction.requestedAction}
        - Smart Contract Address: ${paymentResponse.PaymentSource.smartContractAddress}
        - Agent Used: ${confirmedAgent.name} (${confirmedAgent.agentIdentifier})
      `);

        // Track for cleanup
        testCleanupData.push({
          paymentId: paymentResponse.id,
          blockchainIdentifier: paymentResponse.blockchainIdentifier,
        });

        console.log(`🎉 Payment creation test completed successfully!
        - Successfully created payment for confirmed agent: ${confirmedAgent.name}
        - Payment can now be used for blockchain transactions
      `);
      },
      60 * 1000,
    ); // 1 minute timeout
  });

  describe('Payment Querying (GET)', () => {
    test(
      'should query payments with basic parameters',
      async () => {
        console.log('📝 Preparing payment query test...');

        // Act - Query payments
        console.log('🔍 Querying payments...');
        const queryResponse = await (global as any).testApiClient.queryPayments(
          {
            network: testNetwork,
            limit: 10,
          },
        );

        // Assert - Verify query response structure
        expect(queryResponse).toBeDefined();
        expect(queryResponse.Payments).toBeDefined();
        expect(Array.isArray(queryResponse.Payments)).toBe(true);

        console.log(`📊 Query Results:
        - Total payments found: ${queryResponse.Payments.length}
        - Network: ${testNetwork}
        - Limit: 10
      `);

        // If payments exist, validate structure
        if (queryResponse.Payments.length > 0) {
          const firstPayment = queryResponse.Payments[0];

          expect(firstPayment.id).toBeDefined();
          expect(firstPayment.blockchainIdentifier).toBeDefined();
          expect(firstPayment.NextAction).toBeDefined();
          expect(firstPayment.PaymentSource).toBeDefined();
          expect(firstPayment.RequestedFunds).toBeDefined();
          expect(Array.isArray(firstPayment.RequestedFunds)).toBe(true);

          console.log(`📋 Sample Payment Structure:
          - ID: ${firstPayment.id}
          - State: ${firstPayment.NextAction.requestedAction}
          - Network: ${firstPayment.PaymentSource.network}
          - Created: ${firstPayment.createdAt}
        `);
        } else {
          console.log(
            'ℹ️  No existing payments found - this is normal for a fresh test environment',
          );
        }

        console.log('✅ Payment query test completed successfully!');
      },
      30 * 1000,
    ); // 30 second timeout

    test(
      'should query payments with filtering',
      async () => {
        console.log('📝 Preparing payment query with filters test...');

        // Act - Query payments with includeHistory
        console.log('🔍 Querying payments with history...');
        const queryWithHistoryResponse = await (
          global as any
        ).testApiClient.queryPayments({
          network: testNetwork,
          limit: 5,
          includeHistory: true,
        });

        // Assert - Verify response includes history
        expect(queryWithHistoryResponse).toBeDefined();
        expect(queryWithHistoryResponse.Payments).toBeDefined();
        expect(Array.isArray(queryWithHistoryResponse.Payments)).toBe(true);

        console.log(`📊 Query with History Results:
        - Total payments found: ${queryWithHistoryResponse.Payments.length}
        - Include history: true
      `);

        // If payments exist, check for TransactionHistory
        if (queryWithHistoryResponse.Payments.length > 0) {
          const firstPayment = queryWithHistoryResponse.Payments[0];

          // TransactionHistory should be present (even if empty array)
          expect(firstPayment.TransactionHistory).toBeDefined();

          console.log(`📋 Sample Payment with History:
          - ID: ${firstPayment.id}
          - Transaction History: ${firstPayment.TransactionHistory ? firstPayment.TransactionHistory.length : 0} entries
        `);
        }

        console.log(
          '✅ Payment query with filters test completed successfully!',
        );
      },
      30 * 1000,
    ); // 30 second timeout
  });

  describe('Payment Result Submission (POST)', () => {
    test(
      'should submit result and move payment from FundsLocked to ResultSubmitted',
      async () => {
        console.log('📝 Preparing payment result submission test...');

        // First, we need to get an existing payment in FundsLocked state
        // Query recent payments to find one to submit a result for
        const queryResponse = await (global as any).testApiClient.queryPayments(
          {
            network: testNetwork,
            limit: 5,
          },
        );

        expect(queryResponse.Payments).toBeDefined();
        expect(queryResponse.Payments.length).toBeGreaterThan(0);

        // Debug: Log all payment states
        console.log('📊 Current payment states:');
        queryResponse.Payments.forEach((p: any, index: number) => {
          console.log(`  ${index + 1}. ID: ${p.id.substring(0, 10)}... 
     - NextAction: ${p.NextAction.requestedAction}
     - OnChain: ${p.onChainState || 'null'}
     - Created: ${p.createdAt}`);
        });

        // Find a payment that's in the right state for result submission
        // The API requires onChainState to be 'FundsLocked', 'RefundRequested', or 'Disputed'
        let paymentToUpdate = queryResponse.Payments.find(
          (p: any) =>
            p.NextAction.requestedAction === 'WaitingForExternalAction' &&
            (p.onChainState === 'FundsLocked' ||
              p.onChainState === 'RefundRequested' ||
              p.onChainState === 'Disputed'),
        );

        if (!paymentToUpdate) {
          console.log(
            '⚠️ No payments in correct on-chain state (FundsLocked, RefundRequested, or Disputed) found.',
          );
          console.log('📋 Available payment states:');
          queryResponse.Payments.forEach((p: any, index: number) => {
            console.log(
              `  ${index + 1}. ID: ${p.id.substring(0, 10)}... - OnChain: ${p.onChainState || 'null'}`,
            );
          });
          console.log(
            '💡 The submit-result API requires payments to be processed on-chain first.',
          );
          console.log(
            '⏭️  Skipping result submission test - blockchain processing needed.',
          );
          return; // Skip this test
        }

        console.log(`🎯 Selected payment for result submission:
        - Payment ID: ${paymentToUpdate.id}
        - Blockchain ID: ${paymentToUpdate.blockchainIdentifier.substring(0, 50)}...
        - Current State: ${paymentToUpdate.NextAction?.requestedAction || 'N/A'}
      `);

        // Generate random SHA256 hash for testing
        const { generateRandomSubmitResultHash } = await import(
          '../fixtures/testData'
        );
        const randomSHA256Hash = generateRandomSubmitResultHash();

        console.log(`🔢 Generated random SHA256 hash: ${randomSHA256Hash}`);

        // Act - Submit the result using your SHA256 hash
        console.log('🚀 Submitting payment result...');

        const submitResultResponse = await (
          global as any
        ).testApiClient.makeRequest('/api/v1/payment/submit-result', {
          method: 'POST',
          body: JSON.stringify({
            network: testNetwork,
            submitResultHash: randomSHA256Hash,
            blockchainIdentifier: paymentToUpdate.blockchainIdentifier,
          }),
        });

        // Assert - Verify the result submission was successful
        expect(submitResultResponse).toBeDefined();
        expect(submitResultResponse.id).toBe(paymentToUpdate.id);
        expect(submitResultResponse.NextAction).toBeDefined();
        expect(submitResultResponse.NextAction.requestedAction).toBe(
          'SubmitResultRequested',
        );
        expect(submitResultResponse.NextAction.resultHash).toBe(
          randomSHA256Hash,
        );

        console.log(`✅ Payment result submitted successfully!
        - Payment ID: ${submitResultResponse.id}
        - Previous State: WaitingForExternalAction
        - New State: ${submitResultResponse.NextAction.requestedAction}
        - Result Hash: ${submitResultResponse.NextAction.resultHash}
        - Blockchain ID: ${submitResultResponse.blockchainIdentifier.substring(0, 50)}...
      `);

        console.log(`🎉 Result submission test completed successfully!
        - Random SHA256 hash (${randomSHA256Hash}) has been submitted
        - Payment is now in SubmitResultRequested state
        - The system will process this and move to ResultSubmitted on-chain
      `);
      },
      60 * 1000,
    ); // 1 minute timeout
  });
});
