import { Network, PaymentSourceType } from '@/generated/prisma/enums';
import { CreatePaymentData, RegistrationData } from '../utils/apiClient';
import { createHash, randomBytes } from 'crypto';
import crypto from 'crypto';

export const E2E_CARDANO_SOURCE_INDEX = 0;

// In-test unique-id helper. We avoid `@paralleldrive/cuid2` here because it
// is an ESM-only package and jest 30 in this repo's ESM mode struggles to
// load it from .ts test files (`SyntaxError: Cannot use import statement
// outside a module` in node_modules). `randomBytes(12).toString('hex')`
// yields 24 chars of url-safe entropy — collision risk is negligible for
// per-test fixtures and the value isn't observed by anything but humans
// looking at logs.
function createId(): string {
	return randomBytes(12).toString('hex');
}

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
	paymentSourceType: PaymentSourceType,
	smartContractAddress: string | undefined,
	config: TestAgentConfig = {},
): RegistrationData {
	const uniqueId = createId();
	const timestamp = Date.now();
	const fixedPricing = config.pricing || [
		{
			unit: 'lovelace',
			amount: '1000000', // 1 ADA
		},
	];

	const commonData = {
		network,
		sellingWalletVkey,
		name: config.name || `Test Agent ${uniqueId}`,
		description: config.description || `Test AI agent created for e2e testing - ${timestamp}`,
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
		Author: {
			name: config.author?.name || 'E2E Test Suite',
			contactEmail: config.author?.contactEmail || `test-${uniqueId}@example.com`,
			organization: config.author?.organization || 'Masumi E2E Tests',
		},
		Legal: {
			privacyPolicy: `https://example.com/privacy/${uniqueId}`,
			terms: `https://example.com/terms/${uniqueId}`,
			other: 'Generated for automated testing purposes only',
		},
	};

	if (paymentSourceType === PaymentSourceType.Web3CardanoV2) {
		if (smartContractAddress == null || smartContractAddress.length === 0) {
			throw new Error('V2 E2E registration requires the configured smart contract address');
		}
		return {
			...commonData,
			supportedPaymentSources: [
				{
					chain: 'Cardano',
					network,
					paymentSourceType: PaymentSourceType.Web3CardanoV2,
					address: smartContractAddress,
					pricing: {
						pricingType: 'Fixed',
						fixed: fixedPricing.map(({ unit, amount }) => ({
							asset: unit,
							amount,
						})),
					},
				},
			],
		};
	}

	return {
		...commonData,
		AgentPricing: {
			pricingType: 'Fixed',
			Pricing: fixedPricing,
		},
	};
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
/**
 * Parse a millisecond timeout from an env var. Empty / unset / non-numeric
 * values fall back to `fallback`. A literal `0` is honored (means "wait
 * forever" in our poll helpers — see `pollUntil` in helperFunctions.ts).
 */
function parseTimeoutEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw == null || raw === '') return fallback;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) {
		console.warn(
			`[testData] Ignoring invalid ${name}="${raw}" — expected a non-negative integer (ms); falling back to ${fallback}.`,
		);
		return fallback;
	}
	return parsed;
}

export function getTestEnvironment() {
	return {
		network: (process.env.TEST_NETWORK as Network) || Network.Preprod,
		paymentSourceType: (process.env.TEST_PAYMENT_SOURCE_TYPE as PaymentSourceType) || PaymentSourceType.Web3CardanoV1,
		apiUrl: process.env.TEST_API_URL || 'http://localhost:3001',
		apiKey: process.env.TEST_API_KEY || 'DefaultTestApiKey12345',
		timeout: {
			// `TEST_TIMEOUT_API`: per-HTTP-request timeout. Defaults to 30s.
			api: parseTimeoutEnv('TEST_TIMEOUT_API', 30_000),
			// `TEST_TIMEOUT_REGISTRATION`: how long the registration-confirmation
			// poll waits before giving up. `0` = infinite (default for local
			// dev so a slow Preprod confirmation does not fail a test by
			// itself). CI explicitly overrides this — e.g. `1800000` (30 min) —
			// so a stuck registration tx surfaces as a test timeout rather
			// than consuming the whole job timeout.
			registration: parseTimeoutEnv('TEST_TIMEOUT_REGISTRATION', 0),
			// `TEST_TIMEOUT_BLOCKCHAIN`: generic blockchain wait. Defaults to
			// 10 min; mostly used by deregister-confirmation polls in
			// teardown.
			blockchain: parseTimeoutEnv('TEST_TIMEOUT_BLOCKCHAIN', 600_000),
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
function generatePaymentTiming(): PaymentTimingConfig {
	const now = new Date();

	// payByTime: 11 hours from now (leave buffer before submitResultTime)
	const payByTime = new Date(now.getTime() + 11 * 60 * 60 * 1000);

	// submitResultTime: 12 hours from now (1 hour after payByTime)
	const submitResultTime = new Date(now.getTime() + 12 * 60 * 60 * 1000);

	// unlockTime: 6 hours after submitResultTime
	const unlockTime = new Date(submitResultTime.getTime() + 6 * 60 * 60 * 1000);

	// externalDisputeUnlockTime: 12 hours after submitResultTime
	const externalDisputeUnlockTime = new Date(submitResultTime.getTime() + 12 * 60 * 60 * 1000);

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
function generateHexIdentifier(length: number): string {
	const bytes = Math.ceil(length / 2);
	const randomBytes: number[] = [];

	for (let i = 0; i < bytes; i++) {
		randomBytes.push(crypto.randomInt(0, 255));
	}

	return randomBytes
		.map((byte: number) => byte.toString(16).padStart(2, '0'))
		.join('')
		.substring(0, length);
}

/**
 * Generate SHA256 hash of input string
 */
function generateSHA256Hash(input: string): string {
	return createHash('sha256').update(input).digest('hex');
}

/**
 * Generate a random SHA256 hash for testing submitResultHash
 */
export function generateRandomSubmitResultHash(): string {
	const randomData = {
		status: 'success',
		output: `AI processing completed at ${new Date().toISOString()}`,
		result: `Generated result: ${Math.random().toString(36).substring(2, 15)}`,
		confidence: Math.random(),
		processing_time: `${(Math.random() * 5 + 1).toFixed(2)}s`,
		model: 'test-ai-model-v1.0',
		timestamp: Date.now(),
		requestId: createId(),
	};

	const resultString = JSON.stringify(randomData);
	return createHash('sha256').update(resultString).digest('hex');
}

/**
 * Generate test payment data for creating a payment request
 */
export function generateTestPaymentData(
	network: Network,
	agentIdentifier: string,
	options: {
		paymentSourceType?: PaymentSourceType;
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
	const inputData = options.inputData || `test-payment-input-${Date.now()}-${Math.random()}`;
	const inputHash = generateSHA256Hash(inputData);

	// Generate unique purchaser identifier (14-26 chars hex)
	const identifierFromPurchaser = generateHexIdentifier(20);
	const paymentSourceType = options.paymentSourceType ?? getTestEnvironment().paymentSourceType;

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
		paymentSourceType,
		...(paymentSourceType === PaymentSourceType.Web3CardanoV2
			? { supportedPaymentSourceIndex: E2E_CARDANO_SOURCE_INDEX }
			: {}),
		payByTime: timing.payByTime.toISOString(),
		submitResultTime: timing.submitResultTime.toISOString(),
		unlockTime: timing.unlockTime?.toISOString(),
		externalDisputeUnlockTime: timing.externalDisputeUnlockTime?.toISOString(),
		identifierFromPurchaser,
		metadata: options.metadata || `E2E test payment - ${new Date().toISOString()}`,
	};
}

export default {
	generateTestRegistrationData,
	getTestScenarios,
	getTestEnvironment,
	generateTestPaymentData,
	generateRandomSubmitResultHash,
};
