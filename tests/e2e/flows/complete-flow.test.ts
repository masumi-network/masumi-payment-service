import { Network } from '@prisma/client';
import { validateTestWallets } from '../fixtures/testWallets';
import { generateTestPaymentData } from '../fixtures/testData';
import { PaymentResponse, PurchaseResponse } from '../utils/apiClient';

const testNetwork = (process.env.TEST_NETWORK as Network) || Network.Preprod;

describe(`Complete E2E Flow Tests (${testNetwork})`, () => {
  let confirmedAgent: any;
  let paymentResponse: PaymentResponse;
  let purchaseResponse: PurchaseResponse;

  beforeAll(async () => {
    console.log(`🚀 Starting Complete E2E Flow for ${testNetwork}...`);

    // Validate test environment
    const walletValidation = validateTestWallets(testNetwork);
    if (!walletValidation.valid) {
      throw new Error('Test environment not properly configured');
    }

    if (!(global as any).testApiClient) {
      throw new Error('Test API client not initialized');
    }

    console.log(
      `✅ Complete E2E Flow environment validated for ${testNetwork}`,
    );
  });

  test('should complete full registration → payment → purchase → submit result flow', async () => {
    // Step 1: Get confirmed agent (assumes registration was done previously)
    console.log('🔍 Step 1: Finding confirmed agent...');

    const registryResponse = await (global as any).testApiClient.queryRegistry({
      network: testNetwork,
    });

    confirmedAgent = registryResponse.Assets.find(
      (agent: any) =>
        agent.state === 'RegistrationConfirmed' &&
        agent.agentIdentifier !== null,
    );

    expect(confirmedAgent).toBeDefined();
    console.log(`✅ Found confirmed agent: ${confirmedAgent.name}`);

    // Step 2: Create Payment
    console.log('🔍 Step 2: Creating payment...');

    const paymentData = generateTestPaymentData(
      testNetwork,
      confirmedAgent.agentIdentifier,
    );

    paymentResponse = await (global as any).testApiClient.createPayment(
      paymentData,
    );

    expect(paymentResponse).toBeDefined();
    expect(paymentResponse.blockchainIdentifier).toBeDefined();

    console.log(`✅ Payment created:
      - Payment ID: ${paymentResponse.id}
      - Blockchain ID: ${paymentResponse.blockchainIdentifier.substring(0, 50)}...`);

    // Step 3: Create Purchase using the SAME blockchain identifier
    console.log(
      '🔍 Step 3: Creating purchase with same blockchain identifier...',
    );

    const purchaseData = {
      blockchainIdentifier: paymentResponse.blockchainIdentifier, // ← SAME ID
      network: paymentResponse.PaymentSource.network,
      inputHash: paymentResponse.inputHash,
      sellerVkey: confirmedAgent.SmartContractWallet.walletVkey,
      agentIdentifier: confirmedAgent.agentIdentifier,
      paymentType: paymentResponse.PaymentSource.paymentType,
      unlockTime: paymentResponse.unlockTime,
      externalDisputeUnlockTime: paymentResponse.externalDisputeUnlockTime,
      submitResultTime: paymentResponse.submitResultTime,
      payByTime: paymentResponse.payByTime,
      identifierFromPurchaser: '1234567890abcdef12345678', // 24 characters hex identifier (max 26)
      metadata: 'Complete E2E flow test purchase',
    };

    purchaseResponse = await (global as any).testApiClient.createPurchase(
      purchaseData,
    );

    expect(purchaseResponse).toBeDefined();
    expect(purchaseResponse.blockchainIdentifier).toBe(
      paymentResponse.blockchainIdentifier,
    );

    console.log(`✅ Purchase created:
      - Purchase ID: ${purchaseResponse.id}
      - Blockchain ID: ${purchaseResponse.blockchainIdentifier.substring(0, 50)}...
      - SAME as payment: ${purchaseResponse.blockchainIdentifier === paymentResponse.blockchainIdentifier}`);

    // Step 4: Submit Result using random SHA256
    console.log('🔍 Step 4: Generating and submitting random SHA256 result...');

    const { generateRandomSubmitResultHash } = await import(
      '../fixtures/testData'
    );
    const randomSHA256Hash = generateRandomSubmitResultHash();

    console.log(`🔢 Generated random SHA256 hash: ${randomSHA256Hash}`);

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
    expect(submitResultResponse.NextAction.resultHash).toBe(randomSHA256Hash);

    console.log(`✅ Result submitted successfully:
      - Previous State: ${paymentResponse.NextAction.requestedAction}
      - New State: ${submitResultResponse.NextAction.requestedAction}
      - Result Hash: ${submitResultResponse.NextAction.resultHash}`);

    console.log(`🎉 Complete E2E Flow SUCCESSFUL!
      ✅ Registration: ${confirmedAgent.name}
      ✅ Payment: ${paymentResponse.id}
      ✅ Purchase: ${purchaseResponse.id}  
      ✅ SHA256 Result: ${randomSHA256Hash}
      ✅ Same Blockchain ID used throughout: ${paymentResponse.blockchainIdentifier.substring(0, 50)}...`);
  }, 120000); // 2 minute timeout
});
