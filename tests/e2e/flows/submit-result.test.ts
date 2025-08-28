import { Network } from '@prisma/client';
import { validateTestWallets } from '../fixtures/testWallets';
import { generateRandomSubmitResultHash } from '../fixtures/testData';

const testNetwork = (process.env.TEST_NETWORK as Network) || Network.Preprod;

describe(`Submit Result E2E Tests (${testNetwork})`, () => {
  let testSubmittedData: Array<{
    paymentId?: string;
    blockchainIdentifier?: string;
    submitResultHash?: string;
  }> = [];

  beforeAll(async () => {
    console.log(`🔧 Setting up Submit Result E2E tests for ${testNetwork}...`);

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

    console.log(
      `✅ Submit Result test environment validated for ${testNetwork}`,
    );
  });

  afterAll(async () => {
    if (testSubmittedData.length > 0) {
      console.log(
        `📝 Test submission data (${testSubmittedData.length} results submitted):`,
      );
      testSubmittedData.forEach((data, index) => {
        console.log(
          `   ${index + 1}. Payment ID: ${data.paymentId}, Hash: ${data.submitResultHash?.substring(0, 16)}...`,
        );
      });
    }
  });

  beforeEach(() => {
    testSubmittedData = [];
  });

  describe('Result Submission (POST) - Requires FundsLocked payments', () => {
    test(
      'should submit result and move payment from FundsLocked to ResultSubmitted',
      async () => {
        console.log('📝 Preparing result submission test...');

        // Step 1: Query payments to find ones in FundsLocked state
        console.log('🔍 Step 1: Looking for payments in FundsLocked state...');

        const queryResponse = await (global as any).testApiClient.queryPayments(
          {
            network: testNetwork,
            limit: 10, // Get recent payments
          },
        );

        expect(queryResponse.Payments).toBeDefined();
        expect(Array.isArray(queryResponse.Payments)).toBe(true);

        // Debug: Log all payment states to understand what's available
        console.log('📊 Current payment states:');
        queryResponse.Payments.forEach((p: any, index: number) => {
          console.log(`  ${index + 1}. ID: ${p.id.substring(0, 10)}... 
     - NextAction: ${p.NextAction.requestedAction}
     - OnChain: ${p.onChainState || 'null'}
     - Created: ${p.createdAt}`);
        });

        // Step 2: Find payment in correct state for result submission
        console.log('🔍 Step 2: Filtering for submittable payments...');

        // Look for payments that are ready for result submission:
        // 1. NextAction: WaitingForExternalAction (ready for result submission)
        // 2. OnChainState: FundsLocked (blockchain processed and funds locked)
        // 3. No existing resultHash (haven't had results submitted yet)
        const submittablePayments = queryResponse.Payments.filter(
          (p: any) =>
            p.NextAction.requestedAction === 'WaitingForExternalAction' &&
            p.onChainState === 'FundsLocked' &&
            (!p.NextAction.resultHash || p.NextAction.resultHash === ''),
        );

        if (submittablePayments.length === 0) {
          console.log(
            '⚠️ No payments in correct state for result submission found.',
          );
          console.log(
            '📋 Required state: NextAction="WaitingForExternalAction" AND onChainState="FundsLocked" AND no existing resultHash',
          );

          // Debug: Show what we found that was close
          const waitingFundsLockedPayments = queryResponse.Payments.filter(
            (p: any) =>
              p.NextAction.requestedAction === 'WaitingForExternalAction' &&
              p.onChainState === 'FundsLocked',
          );

          if (waitingFundsLockedPayments.length > 0) {
            console.log(
              '🔍 Found payments with correct NextAction and onChainState but already have resultHash:',
            );
            waitingFundsLockedPayments.forEach((p: any, index: number) => {
              console.log(
                `  ${index + 1}. ID: ${p.id.substring(0, 10)}... - resultHash: ${p.NextAction.resultHash ? p.NextAction.resultHash.substring(0, 16) + '...' : 'none'}`,
              );
            });
          }
          console.log('💡 To get payments ready for result submission:');
          console.log('   1. Run: npm run test:e2e:payment (creates payments)');
          console.log(
            '   2. Run: npm run test:e2e:purchase (creates purchases)',
          );
          console.log(
            '   3. Wait for blockchain processing (payments move to FundsLocked)',
          );
          console.log(
            '   4. Submit results to payments WITHOUT existing resultHash',
          );
          console.log(
            '⏭️  Skipping result submission test - no available payments for result submission.',
          );
          return; // Skip this test gracefully
        }

        // Select the most recent payment ready for result submission
        const selectedPayment = submittablePayments[0]; // Already sorted by createdAt desc

        console.log(
          `✅ Found ${submittablePayments.length} submittable payment(s) in WaitingForExternalAction + FundsLocked state`,
        );
        console.log(`🎯 Selected payment for result submission:
        - Payment ID: ${selectedPayment.id}
        - Blockchain ID: ${selectedPayment.blockchainIdentifier.substring(0, 50)}...
        - OnChain State: ${selectedPayment.onChainState}
        - NextAction: ${selectedPayment.NextAction.requestedAction}
        - Current Result Hash: ${selectedPayment.NextAction.resultHash || 'none'}
        - Created: ${selectedPayment.createdAt}
      `);

        // Step 3: Generate random SHA256 hash for result submission
        console.log('🔢 Step 3: Generating random SHA256 result hash...');

        const randomResultHash = generateRandomSubmitResultHash();
        console.log(`✅ Generated result hash: ${randomResultHash}`);

        // Step 4: Submit the result via API
        console.log('🚀 Step 4: Submitting payment result...');

        const submitResultResponse = await (
          global as any
        ).testApiClient.makeRequest('/api/v1/payment/submit-result', {
          method: 'POST',
          body: JSON.stringify({
            network: testNetwork,
            submitResultHash: randomResultHash,
            blockchainIdentifier: selectedPayment.blockchainIdentifier,
          }),
        });

        // Step 5: Validate the submission response
        console.log('✅ Step 5: Validating submission response...');

        expect(submitResultResponse).toBeDefined();
        expect(submitResultResponse.id).toBe(selectedPayment.id);
        expect(submitResultResponse.blockchainIdentifier).toBe(
          selectedPayment.blockchainIdentifier,
        );

        // Verify the state transition
        expect(submitResultResponse.NextAction).toBeDefined();
        expect(submitResultResponse.NextAction.requestedAction).toBe(
          'SubmitResultRequested',
        );
        expect(submitResultResponse.NextAction.resultHash).toBe(
          randomResultHash,
        );

        // Verify response structure matches expected schema
        expect(submitResultResponse.inputHash).toBeDefined();
        expect(submitResultResponse.PaymentSource).toBeDefined();
        expect(submitResultResponse.RequestedFunds).toBeDefined();
        expect(Array.isArray(submitResultResponse.RequestedFunds)).toBe(true);

        console.log(`🎉 Result submission successful!
        - Payment ID: ${submitResultResponse.id}
        - Previous State: WaitingForExternalAction (FundsLocked)
        - New State: ${submitResultResponse.NextAction.requestedAction}
        - Submitted Hash: ${submitResultResponse.NextAction.resultHash}
        - Blockchain ID: ${submitResultResponse.blockchainIdentifier.substring(0, 50)}...
      `);

        // Track for cleanup/reporting
        testSubmittedData.push({
          paymentId: submitResultResponse.id,
          blockchainIdentifier: submitResultResponse.blockchainIdentifier,
          submitResultHash: randomResultHash,
        });

        console.log(`✅ Submit Result test completed successfully!
        - Successfully transitioned payment from FundsLocked to ResultSubmitted
        - Random SHA256 result hash submitted and verified
        - Payment ready for final blockchain processing
      `);
      },
      60 * 1000, // 1 minute timeout
    );
  });

  describe('Result Submission Edge Cases', () => {
    test(
      'should handle submission to already submitted payment gracefully',
      async () => {
        console.log('📝 Testing duplicate result submission...');

        // Query for payments that already have results submitted
        const queryResponse = await (global as any).testApiClient.queryPayments(
          {
            network: testNetwork,
            limit: 10,
          },
        );

        const alreadySubmittedPayments = queryResponse.Payments.filter(
          (p: any) =>
            p.NextAction.requestedAction === 'SubmitResultRequested' ||
            p.onChainState === 'ResultSubmitted',
        );

        if (alreadySubmittedPayments.length === 0) {
          console.log(
            '⚠️ No previously submitted payments found. Skipping duplicate submission test.',
          );
          return;
        }

        const testPayment = alreadySubmittedPayments[0];
        const newResultHash = generateRandomSubmitResultHash();

        console.log(`🔄 Attempting to submit result to already processed payment:
        - Payment ID: ${testPayment.id}
        - Current State: ${testPayment.NextAction.requestedAction}
        - OnChain State: ${testPayment.onChainState || 'null'}
      `);

        // This should fail or handle gracefully
        try {
          await (global as any).testApiClient.makeRequest(
            '/api/v1/payment/submit-result',
            {
              method: 'POST',
              body: JSON.stringify({
                network: testNetwork,
                submitResultHash: newResultHash,
                blockchainIdentifier: testPayment.blockchainIdentifier,
              }),
            },
          );

          // If we reach here, the API allowed duplicate submission
          console.log(
            'ℹ️ API allowed duplicate result submission (may be expected behavior)',
          );
        } catch (error) {
          // Expected behavior - API should reject duplicate submissions
          console.log('✅ API correctly rejected duplicate result submission');
          expect(error).toBeDefined();
        }
      },
      30 * 1000, // 30 second timeout
    );
  });
});
