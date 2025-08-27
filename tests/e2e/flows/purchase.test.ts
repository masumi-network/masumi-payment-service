/**
 * Purchase E2E Tests
 *
 * These tests require both confirmed agent registrations AND created payments.
 * Run the tests in order:
 *
 *   npm run test:e2e:registration
 *   npm run test:e2e:payment
 *   npm run test:e2e:purchase
 */
import { Network } from '@prisma/client';
import { validateTestWallets } from '../fixtures/testWallets';
import { PurchaseResponse } from '../utils/apiClient';

const testNetwork = (process.env.TEST_NETWORK as Network) || Network.Preprod;

describe(`Purchase E2E Tests (${testNetwork})`, () => {
  let testCleanupData: Array<{
    purchaseId?: string;
    blockchainIdentifier?: string;
  }> = [];

  beforeAll(async () => {
    console.log(`🔧 Setting up Purchase E2E tests for ${testNetwork}...`);

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

    console.log(`✅ Purchase test environment validated for ${testNetwork}`);
  });

  afterAll(async () => {
    // Note: Cleanup implementation could be added here if needed
    // For now, we just log the test data that was created
    if (testCleanupData.length > 0) {
      console.log(
        `📝 Test cleanup data (${testCleanupData.length} purchases created):`,
      );
      testCleanupData.forEach((data, index) => {
        console.log(
          `   ${index + 1}. Purchase ID: ${data.purchaseId}, Blockchain ID: ${data.blockchainIdentifier?.substring(0, 50)}...`,
        );
      });
    }
  });

  beforeEach(() => {
    testCleanupData = [];
  });

  describe('Purchase Creation (POST) - Requires confirmed agent and payment', () => {
    test(
      'should create purchase using payment blockchainIdentifier',
      async () => {
        // Step 1: Get confirmed agent from registry
        console.log('📝 Preparing purchase creation test...');
        console.log('🔍 Step 1: Fetching confirmed agents from registry...');

        const registryResponse = await (
          global as any
        ).testApiClient.queryRegistry({
          network: testNetwork,
        });

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

        console.log(
          `✅ Found confirmed agent: ${confirmedAgent.name} (${confirmedAgent.agentIdentifier})`,
        );

        // Step 2: Create a fresh payment for this purchase test
        console.log('🔍 Step 2: Creating a fresh payment for purchase test...');

        // We need to create a payment first so we have the correct identifierFromPurchaser
        const { generateTestPaymentData } = await import(
          '../fixtures/testData'
        );
        const paymentData = generateTestPaymentData(
          testNetwork,
          confirmedAgent.agentIdentifier,
        );

        console.log('🚀 Creating payment for purchase test...');
        const newPayment = await (global as any).testApiClient.createPayment(
          paymentData,
        );

        console.log(`✅ Created payment for purchase:
        - Payment ID: ${newPayment.id}
        - Blockchain ID: ${newPayment.blockchainIdentifier.substring(0, 50)}...
        - State: ${newPayment.NextAction.requestedAction}
      `);

        // Step 3: Generate purchase data using the fresh payment and agent info
        console.log(
          '🎯 Step 3: Generating purchase data from payment and agent...',
        );

        // We need to use the same identifierFromPurchaser that was used in payment creation
        const purchaseData = {
          blockchainIdentifier: newPayment.blockchainIdentifier,
          network: newPayment.PaymentSource.network,
          inputHash: newPayment.inputHash,
          sellerVkey: confirmedAgent.SmartContractWallet.walletVkey,
          agentIdentifier: confirmedAgent.agentIdentifier,
          paymentType: newPayment.PaymentSource.paymentType,
          unlockTime: newPayment.unlockTime,
          externalDisputeUnlockTime: newPayment.externalDisputeUnlockTime,
          submitResultTime: newPayment.submitResultTime,
          payByTime: newPayment.payByTime,
          identifierFromPurchaser: paymentData.identifierFromPurchaser, // Use the SAME identifier from payment
          metadata: `E2E test purchase - ${new Date().toISOString()}`,
        };

        // Step 4: Create purchase
        console.log('🚀 Step 4: Creating purchase request...');
        let purchaseResponse: PurchaseResponse;

        try {
          purchaseResponse = await (global as any).testApiClient.createPurchase(
            purchaseData,
          );
        } catch (error) {
          console.error('❌ Purchase creation failed:', error);
          throw error;
        }

        // Assert - Verify purchase creation response
        expect(purchaseResponse).toBeDefined();
        expect(purchaseResponse.id).toBeDefined();
        expect(purchaseResponse.blockchainIdentifier).toBe(
          purchaseData.blockchainIdentifier,
        );
        expect(purchaseResponse.inputHash).toBe(purchaseData.inputHash);
        expect(purchaseResponse.NextAction).toBeDefined();

        // Verify payment source and wallet info
        expect(purchaseResponse.PaymentSource).toBeDefined();
        expect(purchaseResponse.PaymentSource.network).toBe(testNetwork);
        expect(purchaseResponse.SmartContractWallet).toBeDefined();

        // Verify paid funds (should be populated based on agent pricing)
        expect(purchaseResponse.PaidFunds).toBeDefined();
        expect(Array.isArray(purchaseResponse.PaidFunds)).toBe(true);

        console.log(`✅ Purchase created successfully for agent "${confirmedAgent.name}":
        - Purchase ID: ${purchaseResponse.id}
        - Blockchain ID: ${purchaseResponse.blockchainIdentifier.substring(0, 50)}...
        - State: ${purchaseResponse.NextAction.requestedAction}
        - Smart Contract Address: ${purchaseResponse.PaymentSource.smartContractAddress}
        - Paid Funds: ${purchaseResponse.PaidFunds.length} entries
      `);

        // Track for cleanup
        testCleanupData.push({
          purchaseId: purchaseResponse.id,
          blockchainIdentifier: purchaseResponse.blockchainIdentifier,
        });

        console.log(`🎉 Purchase creation test completed successfully!
        - Successfully created purchase for confirmed agent: ${confirmedAgent.name}
        - Purchase is now ready for blockchain processing
      `);
      },
      60 * 1000,
    ); // 1 minute timeout
  });

  describe('Purchase Querying (GET)', () => {
    test(
      'should query purchases with basic parameters',
      async () => {
        console.log('📝 Preparing purchase query test...');

        // Act - Query purchases
        console.log('🔍 Querying purchases...');
        const queryResponse = await (
          global as any
        ).testApiClient.queryPurchases({
          network: testNetwork,
          limit: 10,
        });

        // Assert - Verify query response structure
        expect(queryResponse).toBeDefined();
        expect(queryResponse.Purchases).toBeDefined();
        expect(Array.isArray(queryResponse.Purchases)).toBe(true);

        console.log(`📊 Query Results:
        - Total purchases found: ${queryResponse.Purchases.length}
        - Network: ${testNetwork}
        - Limit: 10
      `);

        // If purchases exist, validate structure
        if (queryResponse.Purchases.length > 0) {
          const firstPurchase = queryResponse.Purchases[0];

          expect(firstPurchase.id).toBeDefined();
          expect(firstPurchase.blockchainIdentifier).toBeDefined();
          expect(firstPurchase.NextAction).toBeDefined();
          expect(firstPurchase.PaymentSource).toBeDefined();
          expect(firstPurchase.PaidFunds).toBeDefined();
          expect(Array.isArray(firstPurchase.PaidFunds)).toBe(true);

          console.log(`📋 Sample Purchase Structure:
          - ID: ${firstPurchase.id}
          - State: ${firstPurchase.NextAction.requestedAction}
          - Network: ${firstPurchase.PaymentSource.network}
          - Created: ${firstPurchase.createdAt}
        `);
        } else {
          console.log(
            'ℹ️  No existing purchases found - this is normal for a fresh test environment',
          );
        }

        console.log('✅ Purchase query test completed successfully!');
      },
      30 * 1000,
    ); // 30 second timeout

    test(
      'should query purchases with filtering',
      async () => {
        console.log('📝 Preparing purchase query with filters test...');

        // Act - Query purchases with includeHistory
        console.log('🔍 Querying purchases with history...');
        const queryWithHistoryResponse = await (
          global as any
        ).testApiClient.queryPurchases({
          network: testNetwork,
          limit: 5,
          includeHistory: true,
        });

        // Assert - Verify response includes history
        expect(queryWithHistoryResponse).toBeDefined();
        expect(queryWithHistoryResponse.Purchases).toBeDefined();
        expect(Array.isArray(queryWithHistoryResponse.Purchases)).toBe(true);

        console.log(`📊 Query with History Results:
        - Total purchases found: ${queryWithHistoryResponse.Purchases.length}
        - Include history: true
      `);

        // If purchases exist, check for TransactionHistory
        if (queryWithHistoryResponse.Purchases.length > 0) {
          const firstPurchase = queryWithHistoryResponse.Purchases[0];

          // TransactionHistory should be present (even if empty array)
          expect(firstPurchase.TransactionHistory).toBeDefined();

          console.log(`📋 Sample Purchase with History:
          - ID: ${firstPurchase.id}
          - Transaction History: ${firstPurchase.TransactionHistory ? firstPurchase.TransactionHistory.length : 0} entries
        `);
        }

        console.log(
          '✅ Purchase query with filters test completed successfully!',
        );
      },
      30 * 1000,
    ); // 30 second timeout
  });
});
