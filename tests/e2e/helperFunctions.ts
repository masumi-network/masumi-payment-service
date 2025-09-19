/**
 * E2E Test Helper Functions
 *
 * This file contains all reusable helper functions extracted from E2E test flows
 * to eliminate code duplication and improve maintainability.
 *
 * Functions are organized by category:
 * - Types & Interfaces
 * - Agent Registration Functions
 * - Payment Functions
 * - Purchase Functions
 * - Blockchain State Waiting Functions
 * - Result Submission Functions
 * - Refund Functions
 */

import { Network } from '@prisma/client';
import { PaymentResponse, PurchaseResponse } from './utils/apiClient';
import {
  getTestWalletFromDatabase,
  getActiveSmartContractAddress,
} from './utils/paymentSourceHelper';
import {
  generateTestRegistrationData,
  getTestScenarios,
  generateTestPaymentData,
  generateRandomSubmitResultHash,
} from './fixtures/testData';
import waitForExpect from 'wait-for-expect';

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export interface ConfirmedAgent {
  id: string;
  agentIdentifier: string;
  name: string;
  state: string;
  SmartContractWallet: {
    walletVkey: string;
    walletAddress: string;
  };
}

export interface PaymentResult {
  id: string;
  blockchainIdentifier: string;
  payByTime: string;
  submitResultTime: string;
  unlockTime: string;
  externalDisputeUnlockTime: string;
  inputHash: string;
  identifierFromPurchaser: string; // Original purchaser identifier used in payment creation
  response: PaymentResponse;
}

export interface PurchaseResult {
  id: string;
  blockchainIdentifier: string;
  response: PurchaseResponse;
}

export interface TimingConfig {
  payByTime: Date;
  submitResultTime: Date;
  unlockTime?: Date;
  externalDisputeUnlockTime?: Date;
}

// ============================================================================
// AGENT REGISTRATION FUNCTIONS
// ============================================================================

/**
 * Register an agent and wait for full confirmation with agent identifier
 * @param network - The blockchain network (Preprod, Mainnet, etc.)
 * @returns Confirmed agent data with identifier
 */
export async function registerAndConfirmAgent(
  network: Network,
): Promise<ConfirmedAgent> {
  console.log('📝 [Helper] Starting agent registration and confirmation...');

  // Get test wallet dynamically from database
  console.log('🔍 [Helper] Getting test wallet dynamically from database...');
  const testWallet = await getTestWalletFromDatabase(network, 'seller');
  const testScenario = getTestScenarios().basicAgent;

  const registrationData = generateTestRegistrationData(
    network,
    testWallet.vkey,
    testScenario,
  );

  console.log(`🎯 [Helper] Registration Data:
    - Agent Name: ${registrationData.name}
    - Network: ${registrationData.network}
    - Wallet: ${testWallet.name}
    - Pricing: ${registrationData.AgentPricing.Pricing.map((p) => `${p.amount} ${p.unit}`).join(', ')}
  `);

  // Submit registration
  const registrationResponse = await (
    global as any
  ).testApiClient.registerAgent(registrationData);

  console.log(`✅ [Helper] Registration submitted:
    - ID: ${registrationResponse.id}
    - State: ${registrationResponse.state}
    - Wallet: ${registrationResponse.SmartContractWallet.walletAddress}
  `);

  // Wait for registration confirmation
  console.log('⏳ [Helper] Waiting for registration confirmation...');
  console.log(
    '💡 [Helper] Blockchain confirmations can be unpredictable on Preprod network',
  );

  const startTime = Date.now();
  let confirmedRegistration: any;
  let checkCount = 0;

  // Configure wait-for-expect for blockchain confirmation
  const registrationTimeout = (global as any).testConfig.timeout.registration;

  if (registrationTimeout === 0) {
    console.log(
      '⏳ [Helper] INFINITE WAIT MODE: Will wait indefinitely until blockchain confirmation',
    );
    waitForExpect.defaults.timeout = Number.MAX_SAFE_INTEGER;
  } else {
    console.log(
      `⏳ [Helper] TIMEOUT MODE: Will wait ${Math.floor(registrationTimeout / 60000)} minutes for blockchain confirmation`,
    );
    waitForExpect.defaults.timeout = registrationTimeout;
  }

  waitForExpect.defaults.interval = 15000; // Check every 15 seconds

  await waitForExpect(async () => {
    checkCount++;
    const elapsedMinutes = Math.floor((Date.now() - startTime) / (1000 * 60));
    console.log(
      `🔄 [Helper] Check #${checkCount} (${elapsedMinutes} min elapsed): Checking registration state for ${registrationResponse.id}...`,
    );

    const registration = await (
      global as any
    ).testApiClient.getRegistrationById(registrationResponse.id, network);

    if (!registration) {
      throw new Error(`Registration ${registrationResponse.id} not found`);
    }

    console.log(
      `📊 [Helper] Registration ${registrationResponse.id} current state: ${registration.state}`,
    );

    // Check for error states
    if (registration.state === 'RegistrationFailed') {
      throw new Error(`Registration failed: Unknown error`);
    }

    // Assert registration is confirmed (this will keep retrying until true)
    expect(registration.state).toBe('RegistrationConfirmed');
    confirmedRegistration = registration;
  });

  console.log(`✅ [Helper] Registration confirmed successfully!`);

  // Wait for agent identifier
  console.log('🎯 [Helper] Waiting for agent identifier...');

  // Configure shorter timeout for agent identifier
  const originalTimeout = waitForExpect.defaults.timeout;
  waitForExpect.defaults.timeout = 60000; // 1 minute
  waitForExpect.defaults.interval = 5000; // Check every 5 seconds

  await waitForExpect(
    async () => {
      const registration = await (
        global as any
      ).testApiClient.getRegistrationById(registrationResponse.id, network);

      if (!registration) {
        throw new Error(`Registration ${registrationResponse.id} not found`);
      }

      if (registration.agentIdentifier) {
        console.log(
          `🎯 [Helper] Agent identifier found: ${registration.agentIdentifier}`,
        );
        confirmedRegistration = registration;
        expect(registration.agentIdentifier).toMatch(/^[a-f0-9]{56}[a-f0-9]+$/);
        return;
      }

      console.log(
        `⚠️ [Helper] Agent identifier not yet available for ${registrationResponse.id}`,
      );
      throw new Error(`Agent identifier not yet available`);
    },
    60000,
    5000,
  );

  // Restore original timeout
  waitForExpect.defaults.timeout = originalTimeout;

  const registrationMinutes = Math.floor((Date.now() - startTime) / 60000);
  console.log(
    `✅ [Helper] Registration completed after ${registrationMinutes}m`,
  );
  console.log(
    `🎯 [Helper] Agent identifier created: ${confirmedRegistration.agentIdentifier!}`,
  );

  return {
    id: confirmedRegistration.id,
    agentIdentifier: confirmedRegistration.agentIdentifier!,
    name: confirmedRegistration.name,
    state: confirmedRegistration.state,
    SmartContractWallet: confirmedRegistration.SmartContractWallet,
  };
}

/**
 * Deregister an agent
 * @param network - The blockchain network
 * @param agentIdentifier - The agent identifier to deregister
 * @returns Deregistration response
 */
export async function deregisterAgent(
  network: Network,
  agentIdentifier: string,
): Promise<any> {
  // Query the active smart contract address dynamically from database
  const activeSmartContractAddress =
    await getActiveSmartContractAddress(network);

  const deregisterResponse = await (global as any).testApiClient.makeRequest(
    '/api/v1/registry/deregister',
    {
      method: 'POST',
      body: JSON.stringify({
        network: network,
        agentIdentifier: agentIdentifier,
        smartContractAddress: activeSmartContractAddress,
      }),
    },
  );

  expect(deregisterResponse.id).toBeDefined();
  expect(deregisterResponse.state).toBe('DeregistrationRequested');

  return deregisterResponse;
}

// ============================================================================
// PAYMENT FUNCTIONS
// ============================================================================

/**
 * Create a payment with default timing
 * @param agentIdentifier - The agent identifier to create payment for
 * @param network - The blockchain network
 * @returns Payment result with blockchain identifier
 */
export async function createPayment(
  agentIdentifier: string,
  network: Network,
): Promise<PaymentResult> {
  console.log('💰 [Helper] Creating payment with default timing...');

  const paymentData = generateTestPaymentData(network, agentIdentifier);

  console.log(`🎯 [Helper] Payment Data:
    - Network: ${paymentData.network}
    - Agent ID: ${agentIdentifier}
    - Purchaser ID: ${paymentData.identifierFromPurchaser}
  `);

  const paymentResponse: PaymentResponse = await (
    global as any
  ).testApiClient.createPayment(paymentData);

  expect(paymentResponse).toBeDefined();
  expect(paymentResponse.id).toBeDefined();
  expect(paymentResponse.blockchainIdentifier).toBeDefined();
  expect(paymentResponse.NextAction).toBeDefined();

  console.log(`✅ [Helper] Payment created:
    - Payment ID: ${paymentResponse.id}
    - Blockchain ID: ${paymentResponse.blockchainIdentifier.substring(0, 50)}...
    - State: ${paymentResponse.NextAction.requestedAction}
  `);

  return {
    id: paymentResponse.id,
    blockchainIdentifier: paymentResponse.blockchainIdentifier,
    payByTime: paymentResponse.payByTime,
    submitResultTime: paymentResponse.submitResultTime,
    unlockTime: paymentResponse.unlockTime,
    externalDisputeUnlockTime: paymentResponse.externalDisputeUnlockTime,
    inputHash: paymentResponse.inputHash,
    identifierFromPurchaser: paymentData.identifierFromPurchaser, // Store the original identifier
    response: paymentResponse,
  };
}

/**
 * Create a payment with custom timing configuration
 * @param agentIdentifier - The agent identifier to create payment for
 * @param network - The blockchain network
 * @param customTiming - Custom timing configuration for payment deadlines
 * @returns Payment result with blockchain identifier
 */
export async function createPaymentWithCustomTiming(
  agentIdentifier: string,
  network: Network,
  customTiming: TimingConfig,
): Promise<PaymentResult> {
  console.log('🔍 [Helper] Creating payment with custom timing...');

  console.log(`⏰ [Helper] Setting custom payment times:
    - Pay By Time: ${customTiming.payByTime.toISOString()} ← Payment deadline
    - Submit Result Time: ${customTiming.submitResultTime.toISOString()} ← Work submission deadline  
    - Unlock Time: ${customTiming.unlockTime?.toISOString()} ← Funds unlock
    - External Dispute Time: ${customTiming.externalDisputeUnlockTime?.toISOString()} ← Dispute resolution
  `);

  const paymentData = generateTestPaymentData(network, agentIdentifier, {
    customTiming,
  });

  console.log(`🎯 [Helper] Payment Data:
    - Network: ${paymentData.network}
    - Agent ID: ${agentIdentifier}
    - Purchaser ID: ${paymentData.identifierFromPurchaser}
  `);

  const paymentResponse: PaymentResponse = await (
    global as any
  ).testApiClient.createPayment(paymentData);

  expect(paymentResponse).toBeDefined();
  expect(paymentResponse.id).toBeDefined();
  expect(paymentResponse.blockchainIdentifier).toBeDefined();
  expect(paymentResponse.NextAction).toBeDefined();

  console.log(`✅ [Helper] Payment created with custom timing:
    - Payment ID: ${paymentResponse.id}
    - Blockchain ID: ${paymentResponse.blockchainIdentifier.substring(0, 50)}...
    - State: ${paymentResponse.NextAction.requestedAction}
  `);

  return {
    id: paymentResponse.id,
    blockchainIdentifier: paymentResponse.blockchainIdentifier,
    payByTime: paymentResponse.payByTime,
    submitResultTime: paymentResponse.submitResultTime,
    unlockTime: paymentResponse.unlockTime,
    externalDisputeUnlockTime: paymentResponse.externalDisputeUnlockTime,
    inputHash: paymentResponse.inputHash,
    identifierFromPurchaser: paymentData.identifierFromPurchaser, // Store the original identifier
    response: paymentResponse,
  };
}

// ============================================================================
// PURCHASE FUNCTIONS
// ============================================================================

/**
 * Create a purchase matching the payment data
 * @param paymentResult - The payment result to create purchase for
 * @param agentData - The confirmed agent data
 * @returns Purchase result with blockchain identifier
 */
export async function createPurchase(
  paymentResult: PaymentResult,
  agentData: ConfirmedAgent,
): Promise<PurchaseResult> {
  console.log('🛒 [Helper] Creating purchase with matching identifiers...');

  // Use the blockchain identifier for purchase creation

  // Create purchase data manually using the payment data
  const purchaseData = {
    blockchainIdentifier: paymentResult.blockchainIdentifier,
    network: paymentResult.response.PaymentSource.network,
    inputHash: paymentResult.inputHash,
    sellerVkey: agentData.SmartContractWallet.walletVkey,
    agentIdentifier: agentData.agentIdentifier,
    paymentType: paymentResult.response.PaymentSource.paymentType,
    unlockTime: paymentResult.unlockTime,
    externalDisputeUnlockTime: paymentResult.externalDisputeUnlockTime,
    submitResultTime: paymentResult.submitResultTime,
    payByTime: paymentResult.payByTime,
    identifierFromPurchaser: paymentResult.identifierFromPurchaser, // Use the original purchaser identifier
    metadata: `E2E Helper test purchase - ${new Date().toISOString()}`,
  };

  console.log(
    `🔄 [Helper] Purchase data created with blockchain ID: ${paymentResult.blockchainIdentifier.substring(0, 50)}...`,
  );

  const purchaseResponse: PurchaseResponse = await (
    global as any
  ).testApiClient.createPurchase(purchaseData);

  expect(purchaseResponse).toBeDefined();
  expect(purchaseResponse.id).toBeDefined();
  expect(purchaseResponse.blockchainIdentifier).toBe(
    paymentResult.blockchainIdentifier,
  );
  expect(purchaseResponse.inputHash).toBe(paymentResult.inputHash);
  expect(purchaseResponse.NextAction).toBeDefined();

  console.log(`✅ [Helper] Purchase created:
    - Purchase ID: ${purchaseResponse.id}
    - Blockchain ID: ${purchaseResponse.blockchainIdentifier.substring(0, 50)}...
    - State: ${purchaseResponse.NextAction.requestedAction}
    - Matches payment: ${purchaseResponse.blockchainIdentifier === paymentResult.blockchainIdentifier}
  `);

  return {
    id: purchaseResponse.id,
    blockchainIdentifier: purchaseResponse.blockchainIdentifier,
    response: purchaseResponse,
  };
}

// ============================================================================
// BLOCKCHAIN STATE WAITING FUNCTIONS
// ============================================================================

/**
 * Wait for payment and purchase to reach FundsLocked state
 * @param blockchainIdentifier - The blockchain identifier to monitor
 * @param network - The blockchain network
 */
export async function waitForFundsLocked(
  blockchainIdentifier: string,
  network: Network,
): Promise<void> {
  console.log(
    '⏳ [Helper] Waiting for payment and purchase to reach FundsLocked state...',
  );
  console.log(
    '💡 [Helper] Blockchain state transitions can be unpredictable on Preprod network',
  );
  console.log(
    '⏳ [Helper] INFINITE WAIT MODE: Will wait indefinitely until blockchain confirmation',
  );

  const fundsLockedStartTime = Date.now();

  // Configure infinite timeout for blockchain state transition
  const originalTimeout = waitForExpect.defaults.timeout;
  const originalInterval = waitForExpect.defaults.interval;
  waitForExpect.defaults.timeout = Number.MAX_SAFE_INTEGER;
  waitForExpect.defaults.interval = 15000; // Check every 15 seconds

  await waitForExpect(async () => {
    const elapsedMinutes = Math.floor(
      (Date.now() - fundsLockedStartTime) / 60000,
    );
    console.log(
      `⏱️ [Helper] Checking payment and purchase states... (${elapsedMinutes}m elapsed)`,
    );

    // Query both payment and purchase states in parallel
    const [paymentResponse, purchaseResponse] = await Promise.all([
      (global as any).testApiClient.queryPayments({
        network: network,
      }),
      (global as any).testApiClient.queryPurchases({
        network: network,
      }),
    ]);

    const currentPayment = paymentResponse.Payments.find(
      (p: any) => p.blockchainIdentifier === blockchainIdentifier,
    );

    const currentPurchase = purchaseResponse.Purchases.find(
      (p: any) => p.blockchainIdentifier === blockchainIdentifier,
    );

    expect(currentPayment).toBeDefined();
    expect(currentPurchase).toBeDefined();

    // Verify payment state
    expect(currentPayment.onChainState).toBe('FundsLocked');
    expect(currentPayment.NextAction.requestedAction).toBe(
      'WaitingForExternalAction',
    );

    // Verify purchase state matches payment state
    expect(currentPurchase.onChainState).toBe('FundsLocked');
    expect(currentPurchase.NextAction.requestedAction).toBe(
      'WaitingForExternalAction',
    );

    console.log(
      `📊 [Helper] Payment state: ${currentPayment.onChainState}, Action: ${currentPayment.NextAction.requestedAction}`,
    );
    console.log(
      `📊 [Helper] Purchase state: ${currentPurchase.onChainState}, Action: ${currentPurchase.NextAction.requestedAction}`,
    );
  });

  // Restore original timeout and interval
  waitForExpect.defaults.timeout = originalTimeout;
  waitForExpect.defaults.interval = originalInterval;

  const fundsLockedMinutes = Math.floor(
    (Date.now() - fundsLockedStartTime) / 60000,
  );
  console.log(
    `✅ [Helper] Payment and purchase reached FundsLocked state after ${fundsLockedMinutes}m`,
  );
}

/**
 * Wait for payment and purchase to reach ResultSubmitted state
 * @param blockchainIdentifier - The blockchain identifier to monitor
 * @param network - The blockchain network
 */
export async function waitForResultSubmitted(
  blockchainIdentifier: string,
  network: Network,
): Promise<void> {
  console.log(
    '⏳ [Helper] Waiting for payment and purchase to reach ResultSubmitted state...',
  );
  console.log(
    '💡 [Helper] Blockchain state transitions can be unpredictable on Preprod network',
  );
  console.log(
    '⏳ [Helper] INFINITE WAIT MODE: Will wait indefinitely until blockchain confirmation',
  );

  const resultSubmittedStartTime = Date.now();

  // Configure infinite timeout for blockchain state transition
  const originalTimeout = waitForExpect.defaults.timeout;
  const originalInterval = waitForExpect.defaults.interval;
  waitForExpect.defaults.timeout = Number.MAX_SAFE_INTEGER;
  waitForExpect.defaults.interval = 15000; // Check every 15 seconds

  await waitForExpect(async () => {
    const elapsedMinutes = Math.floor(
      (Date.now() - resultSubmittedStartTime) / 60000,
    );
    console.log(
      `⏱️ [Helper] Checking payment and purchase for ResultSubmitted state... (${elapsedMinutes}m elapsed)`,
    );

    // Query both payment and purchase states in parallel
    const [paymentResponse, purchaseResponse] = await Promise.all([
      (global as any).testApiClient.queryPayments({
        network: network,
      }),
      (global as any).testApiClient.queryPurchases({
        network: network,
      }),
    ]);

    const currentPayment = paymentResponse.Payments.find(
      (p: any) => p.blockchainIdentifier === blockchainIdentifier,
    );

    const currentPurchase = purchaseResponse.Purchases.find(
      (p: any) => p.blockchainIdentifier === blockchainIdentifier,
    );

    expect(currentPayment).toBeDefined();
    expect(currentPurchase).toBeDefined();

    console.log(
      `📊 [Helper] Payment state check: ${currentPayment.onChainState}, Action: ${currentPayment.NextAction.requestedAction}`,
    );
    console.log(
      `📊 [Helper] Purchase state check: ${currentPurchase.onChainState}, Action: ${currentPurchase.NextAction.requestedAction}`,
    );

    // Wait specifically for ResultSubmitted state after result submission
    expect(currentPayment.onChainState).toBe('ResultSubmitted');
    expect(currentPurchase.onChainState).toBe('ResultSubmitted');

    console.log(
      `✅ [Helper] Payment reached ResultSubmitted state: ${currentPayment.onChainState}`,
    );
    console.log(
      `✅ [Helper] Purchase reached ResultSubmitted state: ${currentPurchase.onChainState}`,
    );
  });

  // Restore original timeout and interval
  waitForExpect.defaults.timeout = originalTimeout;
  waitForExpect.defaults.interval = originalInterval;

  const resultSubmittedMinutes = Math.floor(
    (Date.now() - resultSubmittedStartTime) / 60000,
  );
  console.log(
    `✅ [Helper] Payment and purchase processed to ResultSubmitted state after ${resultSubmittedMinutes}m`,
  );
}

/**
 * Wait for payment and purchase to reach Disputed state
 * @param blockchainIdentifier - The blockchain identifier to monitor
 * @param network - The blockchain network
 */
export async function waitForDisputed(
  blockchainIdentifier: string,
  network: Network,
): Promise<void> {
  console.log(
    '⏳ [Helper] Waiting for payment and purchase to reach Disputed state...',
  );
  console.log(
    '💡 [Helper] Blockchain state transitions can be unpredictable on Preprod network',
  );
  console.log(
    '⏳ [Helper] INFINITE WAIT MODE: Will wait indefinitely until blockchain confirmation',
  );

  const disputedWaitStartTime = Date.now();

  // Configure infinite timeout for blockchain state transition
  const originalTimeout = waitForExpect.defaults.timeout;
  const originalInterval = waitForExpect.defaults.interval;
  waitForExpect.defaults.timeout = Number.MAX_SAFE_INTEGER;
  waitForExpect.defaults.interval = 15000; // Check every 15 seconds

  await waitForExpect(async () => {
    const elapsedMinutes = Math.floor(
      (Date.now() - disputedWaitStartTime) / 60000,
    );
    console.log(
      `⏱️ [Helper] Checking payment and purchase states... (${elapsedMinutes}m elapsed)`,
    );

    // Query both payment and purchase states in parallel
    const [paymentResponse, purchaseResponse] = await Promise.all([
      (global as any).testApiClient.queryPayments({
        network: network,
      }),
      (global as any).testApiClient.queryPurchases({
        network: network,
      }),
    ]);

    const currentPayment = paymentResponse.Payments.find(
      (payment: any) => payment.blockchainIdentifier === blockchainIdentifier,
    );

    const currentPurchase = purchaseResponse.Purchases.find(
      (purchase: any) => purchase.blockchainIdentifier === blockchainIdentifier,
    );

    expect(currentPayment).toBeDefined();
    expect(currentPurchase).toBeDefined();

    console.log(
      `📊 [Helper] Payment state check: ${currentPayment.onChainState}, Action: ${currentPayment.NextAction.requestedAction}`,
    );
    console.log(
      `📊 [Helper] Purchase state check: ${currentPurchase.onChainState}, Action: ${currentPurchase.NextAction.requestedAction}`,
    );

    // Wait until both payment and purchase reach Disputed state after refund request
    expect(currentPayment.onChainState).toBe('Disputed');
    expect(currentPayment.NextAction.requestedAction).toBe(
      'WaitingForExternalAction',
    );

    expect(currentPurchase.onChainState).toBe('Disputed');
    expect(currentPurchase.NextAction.requestedAction).toBe(
      'WaitingForExternalAction',
    );

    console.log(
      `✅ [Helper] Payment now in Disputed state and ready for admin authorization`,
    );
    console.log(
      `✅ [Helper] Purchase now in Disputed state and ready for admin authorization`,
    );
  });

  // Restore original timeout and interval
  waitForExpect.defaults.timeout = originalTimeout;
  waitForExpect.defaults.interval = originalInterval;

  const refundStateMinutes = Math.floor(
    (Date.now() - disputedWaitStartTime) / 60000,
  );
  console.log(
    `✅ [Helper] Payment and purchase reached Disputed state after ${refundStateMinutes}m`,
  );
}

/**
 * Wait for payment and purchase to reach RefundRequested state
 * @param blockchainIdentifier - The blockchain identifier to monitor
 * @param network - The blockchain network
 */
export async function waitForRefundRequested(
  blockchainIdentifier: string,
  network: Network,
): Promise<void> {
  console.log(
    '⏳ [Helper] Waiting for payment and purchase to reach RefundRequested state...',
  );
  console.log(
    '💡 [Helper] Blockchain state transitions can be unpredictable on Preprod network',
  );
  console.log(
    '⏳ [Helper] INFINITE WAIT MODE: Will wait indefinitely until blockchain confirmation',
  );

  const refundRequestedStartTime = Date.now();

  // Configure infinite timeout for blockchain state transition
  const originalTimeout = waitForExpect.defaults.timeout;
  const originalInterval = waitForExpect.defaults.interval;
  waitForExpect.defaults.timeout = Number.MAX_SAFE_INTEGER;
  waitForExpect.defaults.interval = 15000; // Check every 15 seconds

  await waitForExpect(async () => {
    const elapsedMinutes = Math.floor(
      (Date.now() - refundRequestedStartTime) / 60000,
    );
    console.log(
      `⏱️ [Helper] Checking payment and purchase states... (${elapsedMinutes}m elapsed)`,
    );

    // Query both payment and purchase states in parallel
    const [paymentResponse, purchaseResponse] = await Promise.all([
      (global as any).testApiClient.queryPayments({
        network: network,
      }),
      (global as any).testApiClient.queryPurchases({
        network: network,
      }),
    ]);

    const currentPayment = paymentResponse.Payments.find(
      (payment: any) => payment.blockchainIdentifier === blockchainIdentifier,
    );

    const currentPurchase = purchaseResponse.Purchases.find(
      (purchase: any) => purchase.blockchainIdentifier === blockchainIdentifier,
    );

    expect(currentPayment).toBeDefined();
    expect(currentPurchase).toBeDefined();

    console.log(
      `📊 [Helper] Payment state check: ${currentPayment.onChainState}, Action: ${currentPayment.NextAction.requestedAction}`,
    );
    console.log(
      `📊 [Helper] Purchase state check: ${currentPurchase.onChainState}, Action: ${currentPurchase.NextAction.requestedAction}`,
    );

    // Wait until both payment and purchase reach RefundRequested state
    expect(currentPayment.onChainState).toBe('RefundRequested');
    expect(currentPurchase.onChainState).toBe('RefundRequested');

    console.log(
      `✅ [Helper] Payment now in RefundRequested state and ready for result submission`,
    );
    console.log(
      `✅ [Helper] Purchase now in RefundRequested state and ready for result submission`,
    );
  });

  // Restore original timeout and interval
  waitForExpect.defaults.timeout = originalTimeout;
  waitForExpect.defaults.interval = originalInterval;

  const refundRequestedMinutes = Math.floor(
    (Date.now() - refundRequestedStartTime) / 60000,
  );
  console.log(
    `✅ [Helper] Payment and purchase reached RefundRequested state after ${refundRequestedMinutes}m`,
  );
}

// ============================================================================
// RESULT SUBMISSION FUNCTIONS
// ============================================================================

/**
 * Submit a random result for the payment
 * @param blockchainIdentifier - The blockchain identifier to submit result for
 * @param network - The blockchain network
 * @returns Object containing the generated result hash
 */
export async function submitResult(
  blockchainIdentifier: string,
  network: Network,
): Promise<{ resultHash: string }> {
  console.log('🔍 [Helper] Generating and submitting random SHA256 result...');

  const randomSHA256Hash = generateRandomSubmitResultHash();

  console.log(`🎯 [Helper] Submit Result Data:
    - Blockchain ID: ${blockchainIdentifier.substring(0, 50)}...
    - SHA256 Hash: ${randomSHA256Hash}
  `);

  const submitResultResponse = await (global as any).testApiClient.makeRequest(
    '/api/v1/payment/submit-result',
    {
      method: 'POST',
      body: JSON.stringify({
        network: network,
        submitResultHash: randomSHA256Hash,
        blockchainIdentifier: blockchainIdentifier,
      }),
    },
  );

  expect(submitResultResponse).toBeDefined();
  expect(submitResultResponse.blockchainIdentifier).toBe(blockchainIdentifier);

  // Verify the state transition
  expect(submitResultResponse.NextAction).toBeDefined();
  expect(submitResultResponse.NextAction.requestedAction).toBe(
    'SubmitResultRequested',
  );
  expect(submitResultResponse.NextAction.resultHash).toBe(randomSHA256Hash);

  console.log(`✅ [Helper] Result submitted successfully:
    - Previous State: WaitingForExternalAction
    - New State: ${submitResultResponse.NextAction.requestedAction}
    - Result Hash: ${submitResultResponse.NextAction.resultHash}
  `);

  return { resultHash: randomSHA256Hash };
}

// ============================================================================
// REFUND FUNCTIONS
// ============================================================================

/**
 * Request a refund for the payment
 * @param blockchainIdentifier - The blockchain identifier to request refund for
 * @param network - The blockchain network
 * @returns Refund request response
 */
export async function requestRefund(
  blockchainIdentifier: string,
  network: Network,
): Promise<any> {
  console.log('💸 [Helper] Requesting refund...');

  const refundRequestResponse = await (global as any).testApiClient.makeRequest(
    '/api/v1/purchase/request-refund',
    {
      method: 'POST',
      body: JSON.stringify({
        network: network,
        blockchainIdentifier: blockchainIdentifier,
      }),
    },
  );

  expect(refundRequestResponse).toBeDefined();
  expect(refundRequestResponse.id).toBeDefined();
  expect(refundRequestResponse.NextAction).toBeDefined();
  expect(refundRequestResponse.NextAction.requestedAction).toBe(
    'SetRefundRequestedRequested',
  );

  console.log(`✅ [Helper] Refund request submitted successfully`);

  return refundRequestResponse;
}

/**
 * Authorize a refund as admin
 * @param blockchainIdentifier - The blockchain identifier to authorize refund for
 * @param network - The blockchain network
 * @returns Authorization response
 */
export async function authorizeRefund(
  blockchainIdentifier: string,
  network: Network,
): Promise<any> {
  console.log('👨‍💼 [Helper] Admin authorization (Disputed → Complete)...');

  const authorizeRefundResponse = await (
    global as any
  ).testApiClient.makeRequest('/api/v1/payment/authorize-refund', {
    method: 'POST',
    body: JSON.stringify({
      network: network,
      blockchainIdentifier: blockchainIdentifier,
    }),
  });

  expect(authorizeRefundResponse).toBeDefined();
  expect(authorizeRefundResponse.id).toBeDefined();
  expect(authorizeRefundResponse.onChainState).toBeDefined();
  expect(authorizeRefundResponse.NextAction).toBeDefined();
  expect(authorizeRefundResponse.NextAction.requestedAction).toBe(
    'AuthorizeRefundRequested',
  );

  console.log(`✅ [Helper] Admin authorization successful:
    - Payment ID: ${authorizeRefundResponse.id}
    - OnChain State: ${authorizeRefundResponse.onChainState}
    - Next Action: ${authorizeRefundResponse.NextAction.requestedAction}
  `);

  return authorizeRefundResponse;
}

/**
 * Cancel a refund request
 * @param blockchainIdentifier - The blockchain identifier to cancel refund for
 * @param network - The blockchain network
 * @returns Cancel refund response
 */
export async function cancelRefundRequest(
  blockchainIdentifier: string,
  network: Network,
): Promise<any> {
  console.log('❌ [Helper] Cancelling refund request...');

  const cancelRefundResponse = await (global as any).testApiClient.makeRequest(
    '/api/v1/purchase/cancel-refund-request',
    {
      method: 'POST',
      body: JSON.stringify({
        network: network,
        blockchainIdentifier: blockchainIdentifier,
      }),
    },
  );

  expect(cancelRefundResponse).toBeDefined();
  expect(cancelRefundResponse.id).toBeDefined();
  expect(cancelRefundResponse.NextAction).toBeDefined();

  console.log(`✅ [Helper] Refund request cancelled successfully:
    - Payment ID: ${cancelRefundResponse.id}
    - Next Action: ${cancelRefundResponse.NextAction.requestedAction}
  `);

  return cancelRefundResponse;
}
