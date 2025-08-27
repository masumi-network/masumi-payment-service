import { Network } from '@prisma/client';
import {
  CreatePaymentData,
  CreatePurchaseData,
  PaymentResponse,
  RegistrationData,
} from '../utils/apiClient';
import { createHash } from 'crypto';
import { createId } from '@paralleldrive/cuid2';

/**
 * Test data generators for e2e tests
 */

export interface TestAgentConfig {
  name?: string;
  description?: string;
  apiBaseUrl?: string;
  tags?: string[];
  pricing?: Array<{ unit: string; amount: string }>;
  capability?: { name: string; version: string };
  author?: {
    name: string;
    contactEmail?: string;
    organization?: string;
  };
}

/**
 * Generate unique test registration data
 */
export function generateTestRegistrationData(
  network: Network,
  sellingWalletVkey: string,
  config: TestAgentConfig = {},
): RegistrationData {
  const uniqueId = createId();
  const timestamp = Date.now();

  const defaultData: RegistrationData = {
    network,
    sellingWalletVkey,
    name: config.name || `Test Agent ${uniqueId}`,
    description:
      config.description ||
      `Test AI agent created for e2e testing - ${timestamp}`,
    apiBaseUrl: config.apiBaseUrl || `https://api.testagent-${uniqueId}.com`,
    Tags: config.tags || ['test', 'ai-agent', 'e2e', 'automated'],
    ExampleOutputs: [
      {
        name: `Test Output ${uniqueId}`,
        url: `https://example.com/output/${uniqueId}.json`,
        mimeType: 'application/json',
      },
      {
        name: `Test Image ${uniqueId}`,
        url: `https://example.com/image/${uniqueId}.png`,
        mimeType: 'image/png',
      },
    ],
    Capability: config.capability || {
      name: 'GPT-4 Test Model',
      version: '1.0.0',
    },
    AgentPricing: {
      pricingType: 'Fixed',
      Pricing: config.pricing || [
        {
          unit: 'lovelace',
          amount: '1000000', // 1 ADA
        },
      ],
    },
    Author: {
      name: config.author?.name || 'E2E Test Suite',
      contactEmail:
        config.author?.contactEmail || `test-${uniqueId}@example.com`,
      organization: config.author?.organization || 'Masumi E2E Tests',
    },
    Legal: {
      privacyPolicy: `https://example.com/privacy/${uniqueId}`,
      terms: `https://example.com/terms/${uniqueId}`,
      other: 'Generated for automated testing purposes only',
    },
  };

  return defaultData;
}

/**
 * Get test configuration for different scenarios
 */
export function getTestScenarios() {
  return {
    basicAgent: {
      name: 'Basic Test Agent',
      description: 'Simple agent for basic functionality testing',
      tags: ['basic', 'test'],
      pricing: [{ unit: 'lovelace', amount: '500000' }], // 0.5 ADA
    },
  };
}

/**
 * Generate test environment configuration
 */
export function getTestEnvironment() {
  return {
    network: (process.env.TEST_NETWORK as Network) || Network.Preprod,
    apiUrl: process.env.TEST_API_URL || 'http://localhost:3000',
    apiKey: process.env.TEST_API_KEY || 'Faizan12620Shaikh@3033',
    database:
      process.env.TEST_DATABASE_URL ||
      'postgresql://test@localhost:5432/masumi_payment_service_test',
    timeout: {
      api: parseInt(process.env.TEST_API_TIMEOUT || '30000'),
      registration: parseInt(process.env.TEST_REGISTRATION_TIMEOUT || '600000'), // 10 minutes
      blockchain: parseInt(process.env.TEST_BLOCKCHAIN_TIMEOUT || '600000'),
    },
  };
}

export interface PaymentTimingConfig {
  payByTime: Date;
  submitResultTime: Date;
  unlockTime?: Date;
  externalDisputeUnlockTime?: Date;
}

/**
 * Generate valid payment timing constraints
 */
export function generatePaymentTiming(): PaymentTimingConfig {
  const now = new Date();

  // payByTime: 11 hours from now (leave buffer before submitResultTime)
  const payByTime = new Date(now.getTime() + 11 * 60 * 60 * 1000);

  // submitResultTime: 12 hours from now (1 hour after payByTime)
  const submitResultTime = new Date(now.getTime() + 12 * 60 * 60 * 1000);

  // unlockTime: 6 hours after submitResultTime
  const unlockTime = new Date(submitResultTime.getTime() + 6 * 60 * 60 * 1000);

  // externalDisputeUnlockTime: 12 hours after submitResultTime
  const externalDisputeUnlockTime = new Date(
    submitResultTime.getTime() + 12 * 60 * 60 * 1000,
  );

  return {
    payByTime,
    submitResultTime,
    unlockTime,
    externalDisputeUnlockTime,
  };
}

/**
 * Generate a random hex string for identifiers
 */
export function generateHexIdentifier(length: number): string {
  const bytes = Math.ceil(length / 2);
  const randomBytes: number[] = [];

  for (let i = 0; i < bytes; i++) {
    randomBytes[i] = Math.floor(Math.random() * 256);
  }

  return randomBytes
    .map((byte: number) => byte.toString(16).padStart(2, '0'))
    .join('')
    .substring(0, length);
}

/**
 * Generate SHA256 hash of input string
 */
export function generateSHA256Hash(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Generate test payment data for creating a payment request
 */
export function generateTestPaymentData(
  network: Network,
  agentIdentifier: string,
  options: {
    customTiming?: Partial<PaymentTimingConfig>;
    metadata?: string;
    inputData?: string;
  } = {},
): CreatePaymentData {
  const timing = {
    ...generatePaymentTiming(),
    ...options.customTiming,
  };

  // Generate unique input data if not provided
  const inputData =
    options.inputData || `test-payment-input-${Date.now()}-${Math.random()}`;
  const inputHash = generateSHA256Hash(inputData);

  // Generate unique purchaser identifier (14-26 chars hex)
  const identifierFromPurchaser = generateHexIdentifier(20);

  console.log(`Generated Payment Test Data:
    - Agent Identifier: ${agentIdentifier}
    - Input Hash: ${inputHash}
    - Purchaser ID: ${identifierFromPurchaser}
    - Pay By Time: ${timing.payByTime.toISOString()}
    - Submit Result Time: ${timing.submitResultTime.toISOString()}
    - Unlock Time: ${timing.unlockTime?.toISOString()}
    - External Dispute Time: ${timing.externalDisputeUnlockTime?.toISOString()}
  `);

  return {
    inputHash,
    network,
    agentIdentifier,
    paymentType: 'Web3CardanoV1', // Valid payment type from API
    payByTime: timing.payByTime.toISOString(),
    submitResultTime: timing.submitResultTime.toISOString(),
    unlockTime: timing.unlockTime?.toISOString(),
    externalDisputeUnlockTime: timing.externalDisputeUnlockTime?.toISOString(),
    identifierFromPurchaser,
    metadata:
      options.metadata || `E2E test payment - ${new Date().toISOString()}`,
  };
}

/**
 * Generate mock AI agent result data
 */
export function generateMockAgentResult(inputData?: string): {
  result: string;
  resultHash: string;
} {
  const result = JSON.stringify({
    status: 'success',
    input: inputData || 'test-input',
    output: {
      message: `AI processing completed at ${new Date().toISOString()}`,
      confidence: 0.95,
      processingTime: Math.floor(Math.random() * 5000) + 1000, // 1-6 seconds
    },
    metadata: {
      model: 'test-ai-model-v1.0',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    },
  });

  const resultHash = generateSHA256Hash(result);

  return { result, resultHash };
}

/**
 * Validate payment timing constraints
 */
export function validatePaymentTiming(timing: PaymentTimingConfig): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const now = new Date();

  // Check payByTime is in the future (max 5 minutes in the past allowed)
  if (timing.payByTime.getTime() < now.getTime() - 5 * 60 * 1000) {
    errors.push(
      'Pay by time must be in the future (max 5 minutes in the past allowed)',
    );
  }

  // Check submitResultTime is in the future (min 15 minutes)
  if (timing.submitResultTime.getTime() < now.getTime() + 15 * 60 * 1000) {
    errors.push('Submit result time must be in the future (min 15 minutes)');
  }

  // Check payByTime vs submitResultTime (min 5 minutes difference)
  if (
    timing.payByTime.getTime() >
    timing.submitResultTime.getTime() - 5 * 60 * 1000
  ) {
    errors.push(
      'Pay by time must be before submit result time (min 5 minutes difference)',
    );
  }

  // Check submitResultTime vs unlockTime (min 15 minutes difference)
  if (timing.unlockTime) {
    if (
      timing.submitResultTime.getTime() >
      timing.unlockTime.getTime() - 15 * 60 * 1000
    ) {
      errors.push(
        'Submit result time must be before unlock time (min 15 minutes difference)',
      );
    }
  }

  // Check unlockTime vs externalDisputeUnlockTime (min 15 minutes difference)
  if (timing.unlockTime && timing.externalDisputeUnlockTime) {
    if (
      timing.unlockTime.getTime() >
      timing.externalDisputeUnlockTime.getTime() - 15 * 60 * 1000
    ) {
      errors.push(
        'Unlock time must be before external dispute unlock time (min 15 minutes difference)',
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Generate test purchase data using payment response data
 */
export function generateTestPurchaseData(
  paymentResponse: PaymentResponse,
  confirmedAgent: {
    agentIdentifier: string;
    SmartContractWallet: { walletVkey: string };
  },
  options: {
    metadata?: string;
  } = {},
): CreatePurchaseData {
  console.log(`Generated Purchase Test Data:
    - Blockchain Identifier: ${paymentResponse.blockchainIdentifier.substring(0, 50)}...
    - Agent Identifier: ${confirmedAgent.agentIdentifier}
    - Seller VKey: ${confirmedAgent.SmartContractWallet.walletVkey}
    - Input Hash: ${paymentResponse.inputHash}
    - Network: ${paymentResponse.PaymentSource.network}
  `);

  return {
    blockchainIdentifier: paymentResponse.blockchainIdentifier,
    network: paymentResponse.PaymentSource.network,
    inputHash: paymentResponse.inputHash,
    sellerVkey: confirmedAgent.SmartContractWallet.walletVkey,
    agentIdentifier: confirmedAgent.agentIdentifier,
    paymentType: paymentResponse.PaymentSource.paymentType,
    unlockTime: paymentResponse.unlockTime,
    externalDisputeUnlockTime: paymentResponse.externalDisputeUnlockTime,
    submitResultTime: paymentResponse.submitResultTime,
    payByTime: paymentResponse.payByTime,
    identifierFromPurchaser: extractIdentifierFromBlockchain(
      paymentResponse.blockchainIdentifier,
    ),
    metadata:
      options.metadata || `E2E test purchase - ${new Date().toISOString()}`,
  };
}

function extractIdentifierFromBlockchain(blockchainIdentifier: string): string {
  const hash = generateSHA256Hash(blockchainIdentifier);
  return hash.substring(0, 20);
}

export default {
  generateTestRegistrationData,
  getTestScenarios,
  getTestEnvironment,
  generateTestPaymentData,
  generatePaymentTiming,
  generateHexIdentifier,
  generateSHA256Hash,
  generateMockAgentResult,
  validatePaymentTiming,
  generateTestPurchaseData,
};
