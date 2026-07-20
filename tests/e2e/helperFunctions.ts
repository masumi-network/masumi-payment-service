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

import { Network, PaymentSourceType } from '@/generated/prisma/enums';
import { PaymentResponse, PurchaseResponse, RegistrationResponse } from './utils/apiClient';
import './setup/globals';
import { getTestWalletFromDatabase, getActiveSmartContractAddress } from './utils/paymentSourceHelper';
import {
	generateTestRegistrationData,
	getTestScenarios,
	generateTestPaymentData,
	generateRandomSubmitResultHash,
} from './fixtures/testData';

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

class FatalE2EError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'FatalE2EError';
	}
}

interface BlockchainStateWaitOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	intervalMs?: number;
}

function normalizeBlockchainStateWaitOptions(
	optionsOrSignal?: AbortSignal | BlockchainStateWaitOptions,
): BlockchainStateWaitOptions {
	if (optionsOrSignal == null) {
		return {};
	}
	if ('aborted' in optionsOrSignal && 'addEventListener' in optionsOrSignal) {
		return { signal: optionsOrSignal };
	}
	return optionsOrSignal;
}

function logBlockchainWaitMode(label: string, timeoutMs: number): void {
	if (timeoutMs === 0) {
		console.log(`⏳ E2E: infinite wait enabled (${label})`);
		return;
	}
	console.log(`⏳ E2E: timeout enabled — waiting up to ${Math.floor(timeoutMs / 60000)} min (${label})`);
}

async function fetchPaymentAndPurchaseByBlockchainIdentifier(
	blockchainIdentifier: string,
	network: Network,
): Promise<{ currentPayment?: PaymentResponse; currentPurchase?: PurchaseResponse }> {
	const [currentPayment, currentPurchase] = await Promise.all([
		global.testApiClient.resolvePaymentByBlockchainIdentifier({
			blockchainIdentifier,
			network,
		}),
		global.testApiClient.resolvePurchaseByBlockchainIdentifier({
			blockchainIdentifier,
			network,
		}),
	]);

	return { currentPayment, currentPurchase };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error(`Aborted: ${signal.reason ?? 'signal aborted'}`));
			return;
		}
		// Remove the abort listener on normal resolution. `pollUntil` reuses one
		// signal across every iteration; `{ once: true }` only auto-removes on
		// abort, so without this a long poll leaks a listener per sleep and trips
		// Node's MaxListenersExceededWarning.
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error(`Aborted: ${signal?.reason ?? 'signal aborted'}`));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

/**
 * Runs all tasks concurrently and, on the FIRST rejection, aborts the rest via a
 * shared AbortSignal. Without this, a sibling infinite `pollUntil` keeps looping
 * (and logging) after Jest has torn the test down → "Cannot log after tests are done".
 * Each task receives the signal and is expected to thread it into `pollUntil`.
 */
export async function allWithAbortOnFailure<T>(tasks: Array<(signal: AbortSignal) => Promise<T>>): Promise<T[]> {
	const controller = new AbortController();
	const promises = tasks.map(async (task) => {
		try {
			return await task(controller.signal);
		} catch (err) {
			if (!controller.signal.aborted) {
				controller.abort(err);
			}
			throw err;
		}
	});

	const results = await Promise.allSettled(promises);
	let hasRejection = false;
	let firstRejection: unknown;
	const values: T[] = [];

	for (const result of results) {
		if (result.status === 'rejected') {
			if (!hasRejection) {
				firstRejection = result.reason;
				hasRejection = true;
			}
		} else {
			values.push(result.value);
		}
	}

	if (hasRejection) {
		throw firstRejection;
	}

	if (!controller.signal.aborted) {
		controller.abort('batch settled');
	}

	return values;
}

async function pollUntil(
	check: () => Promise<void>,
	options?: {
		timeoutMs?: number; // 0 or undefined => infinite
		intervalMs?: number;
		label?: string;
		signal?: AbortSignal;
	},
): Promise<void> {
	const intervalMs = options?.intervalMs ?? 5000;
	const timeoutMs = options?.timeoutMs ?? 0;
	const label = options?.label ? ` (${options.label})` : '';
	const signal = options?.signal;

	const startedAt = Date.now();
	const isInfinite = timeoutMs === 0;
	const deadline = isInfinite ? 0 : startedAt + timeoutMs;

	let lastErr: unknown;
	let pollCount = 0;

	while (isInfinite || Date.now() < deadline) {
		if (signal?.aborted) {
			throw new Error(`Aborted${label} (polls=${pollCount}): ${signal.reason ?? 'signal aborted'}`);
		}
		pollCount++;
		try {
			await check();
			return;
		} catch (err) {
			if (err instanceof FatalE2EError) {
				throw err; // fail-fast
			}
			lastErr = err;
			await sleep(intervalMs, signal);
		}
	}

	const elapsedMs = Date.now() - startedAt;
	const timeoutMsg = `Timed out after ${Math.floor(elapsedMs / 1000)}s${label} (polls=${pollCount})`;
	if (lastErr instanceof Error) {
		lastErr.message = `${timeoutMsg}\nLast error: ${lastErr.message}`;
		throw lastErr;
	}
	throw new Error(timeoutMsg);
}

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
	supportedPaymentSourceIndex?: number;
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
 * @param paymentSourceType - Optional override for the payment source type (defaults to `global.testConfig.paymentSourceType`)
 * @returns Confirmed agent data with identifier
 */
export async function registerAndConfirmAgent(
	network: Network,
	paymentSourceType?: PaymentSourceType,
	signal?: AbortSignal,
): Promise<ConfirmedAgent> {
	const resolvedPaymentSourceType = paymentSourceType ?? global.testConfig.paymentSourceType;
	console.log('📝 E2E: starting agent registration and confirmation...');

	// Get test wallet dynamically from database
	console.log('🔍 E2E: loading test wallet from database...');
	const testWallet = await getTestWalletFromDatabase(network, 'seller', undefined, resolvedPaymentSourceType);
	const testScenario = getTestScenarios().basicAgent;
	const smartContractAddress =
		resolvedPaymentSourceType === PaymentSourceType.Web3CardanoV2
			? await getActiveSmartContractAddress(network, resolvedPaymentSourceType, global.testApiClient)
			: undefined;

	const registrationData = generateTestRegistrationData(
		network,
		testWallet.vkey,
		resolvedPaymentSourceType,
		smartContractAddress,
		testScenario,
	);
	const registrationPrices =
		registrationData.AgentPricing?.Pricing ??
		registrationData.supportedPaymentSources?.flatMap((source) =>
			source.pricing.fixed.map(({ asset, amount }) => ({
				unit: asset,
				amount,
			})),
		) ??
		[];

	console.log(`🎯 E2E: registration payload:
    - Agent Name: ${registrationData.name}
    - Network: ${registrationData.network}
    - Payment Source Type: ${resolvedPaymentSourceType}
    - Wallet: ${testWallet.name}
    - Pricing: ${registrationPrices.map((price) => `${price.amount} ${price.unit}`).join(', ')}
  `);

	// Submit registration
	const registrationResponse = await global.testApiClient.registerAgent(registrationData);

	console.log(`✅ E2E: registration submitted:
    - ID: ${registrationResponse.id}
    - State: ${registrationResponse.state}
    - Wallet: ${registrationResponse.SmartContractWallet.walletAddress}
  `);

	// Wait for registration confirmation
	console.log('⏳ E2E: waiting for registration confirmation...');
	console.log('💡 E2E: note — blockchain confirmations can be slow/unpredictable on Preprod');

	const startTime = Date.now();
	let confirmedRegistration: RegistrationResponse | undefined;
	let checkCount = 0;

	// Configure polling for blockchain confirmation (fail-fast on terminal errors)
	const registrationTimeout = global.testConfig.timeout.registration;

	if (registrationTimeout === 0) {
		console.log('⏳ E2E: infinite wait enabled (registration confirmation)');
	} else {
		console.log(
			`⏳ E2E: timeout enabled — waiting up to ${Math.floor(registrationTimeout / 60000)} min for registration confirmation`,
		);
	}

	await pollUntil(
		async () => {
			checkCount++;
			const elapsedMinutes = Math.floor((Date.now() - startTime) / (1000 * 60));
			console.log(
				`🔄 E2E: poll #${checkCount} (${elapsedMinutes} min elapsed) — registration ${registrationResponse.id}`,
			);

			const registration = await global.testApiClient.getRegistrationById(
				registrationResponse.id,
				network,
				resolvedPaymentSourceType,
			);

			if (!registration) {
				throw new Error(`Registration ${registrationResponse.id} not found`);
			}

			console.log(`📊 E2E: registration ${registrationResponse.id} state=${registration.state}`);

			// Fail fast on terminal error states (wait-for-expect would otherwise retry)
			if (registration.state === 'RegistrationFailed') {
				throw new FatalE2EError(`Registration failed for ${registrationResponse.id} (state=${registration.state})`);
			}

			if (registration.state !== 'RegistrationConfirmed') {
				throw new Error(`Registration not yet confirmed (state=${registration.state})`);
			}

			confirmedRegistration = registration;
		},
		{
			timeoutMs: registrationTimeout,
			intervalMs: 5000,
			label: 'registration confirmation',
			signal,
		},
	);

	console.log('✅ E2E: registration confirmed');

	// Wait for agent identifier
	console.log('🎯 E2E: waiting for agent identifier...');

	await pollUntil(
		async () => {
			const registration = await global.testApiClient.getRegistrationById(
				registrationResponse.id,
				network,
				resolvedPaymentSourceType,
			);

			if (!registration) {
				throw new Error(`Registration ${registrationResponse.id} not found`);
			}

			// Fail fast if registration flips into a terminal failure state while waiting
			if (registration.state === 'RegistrationFailed') {
				throw new FatalE2EError(
					`Registration failed for ${registrationResponse.id} while waiting for agent identifier (state=${registration.state})`,
				);
			}

			if (registration.state === 'RegistrationConfirmed' && registration.agentIdentifier) {
				console.log(`🎯 E2E: agent identifier assigned: ${registration.agentIdentifier}`);
				confirmedRegistration = registration;
				const match = registration.agentIdentifier.match(/^[a-f0-9]{56}[a-f0-9]+$/);
				if (!match) {
					throw new FatalE2EError(`Agent identifier ${registration.agentIdentifier} does not match expected pattern`);
				}
				console.log(`🎯 E2E: agent identifier registered: ${registration.agentIdentifier}`);
				return;
			}

			console.log(`⚠️ E2E: agent identifier not yet available for registration ${registrationResponse.id}`);
			throw new Error(`Agent identifier not yet available`);
		},
		{ timeoutMs: 60000, intervalMs: 5000, label: 'agent identifier', signal },
	);

	const registrationMinutes = Math.floor((Date.now() - startTime) / 60000);
	console.log(`✅ E2E: registration completed after ${registrationMinutes} min`);
	if (!confirmedRegistration?.agentIdentifier) {
		throw new Error(`Registration ${registrationResponse.id} confirmed but agentIdentifier missing`);
	}

	console.log(`🎯 E2E: agent identifier: ${confirmedRegistration.agentIdentifier}`);

	return {
		id: confirmedRegistration.id,
		agentIdentifier: confirmedRegistration.agentIdentifier,
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
): Promise<{ id: string; state: string }> {
	// Query the active smart contract address dynamically from database
	const activeSmartContractAddress = await getActiveSmartContractAddress(network, global.testConfig.paymentSourceType);

	const deregisterResponse = await global.testApiClient.request<{
		id: string;
		state: string;
	}>('/api/v1/registry/deregister', {
		method: 'POST',
		body: JSON.stringify({
			network: network,
			agentIdentifier: agentIdentifier,
			smartContractAddress: activeSmartContractAddress,
		}),
	});

	if (!deregisterResponse.id) {
		throw new Error('Deregistration response ID is undefined');
	}
	if (!deregisterResponse.state) {
		throw new Error('Deregistration response state is undefined');
	}

	return deregisterResponse;
}

/**
 * Deregister an agent and wait for DeregistrationConfirmed.
 * This will fail fast if the request transitions into DeregistrationFailed.
 *
 * @param paymentSourceType - Optional override for the payment source type (defaults to `global.testConfig.paymentSourceType`).
 *   When V1 and V2 teardown run concurrently (e.g. `Promise.allSettled`), each call must
 *   carry its own type instead of racing on the shared global.
 */
export async function deregisterAndConfirmAgent(
	network: Network,
	agentIdentifier: string,
	options?: { timeoutMs?: number; intervalMs?: number },
	paymentSourceType?: PaymentSourceType,
): Promise<{ id: string; state: string }> {
	const resolvedPaymentSourceType = paymentSourceType ?? global.testConfig.paymentSourceType;
	console.log('🔄 E2E: deregistering agent and waiting for confirmation...');

	// Inline the deregister request so we can thread `resolvedPaymentSourceType` through without
	// mutating the shared `global.testConfig` (V1 + V2 teardown can run concurrently).
	const activeSmartContractAddress = await getActiveSmartContractAddress(network, resolvedPaymentSourceType);

	const deregisterResponse = await global.testApiClient.request<{
		id: string;
		state: string;
	}>('/api/v1/registry/deregister', {
		method: 'POST',
		body: JSON.stringify({
			network: network,
			agentIdentifier: agentIdentifier,
			smartContractAddress: activeSmartContractAddress,
		}),
	});

	if (!deregisterResponse.id) {
		throw new Error('Deregistration response ID is undefined');
	}
	if (!deregisterResponse.state) {
		throw new Error('Deregistration response state is undefined');
	}

	await pollUntil(
		async () => {
			const registration = await global.testApiClient.getRegistrationById(
				deregisterResponse.id,
				network,
				resolvedPaymentSourceType,
			);

			if (!registration) {
				throw new Error(`Deregistration ${deregisterResponse.id} not found`);
			}

			const state = registration.state;
			console.log(`📊 E2E: deregistration ${deregisterResponse.id} state=${state}`);

			if (state === 'DeregistrationFailed') {
				throw new FatalE2EError(
					`Deregistration failed for ${deregisterResponse.id} (agentIdentifier=${agentIdentifier})`,
				);
			}

			if (state !== 'DeregistrationConfirmed') {
				throw new Error(`Deregistration not yet confirmed (state=${state})`);
			}
		},
		{
			timeoutMs: options?.timeoutMs ?? global.testConfig.timeout.blockchain ?? 10 * 60 * 1000,
			intervalMs: options?.intervalMs ?? 5000,
			label: 'deregistration confirmation',
		},
	);

	console.log('✅ E2E: deregistration confirmed');
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
export async function createPayment(agentIdentifier: string, network: Network): Promise<PaymentResult> {
	console.log('💰 E2E: creating payment (default timing)...');

	const paymentData = generateTestPaymentData(network, agentIdentifier, {
		paymentSourceType: global.testConfig.paymentSourceType,
	});

	console.log(`🎯 E2E: payment payload:
    - Network: ${paymentData.network}
    - Payment Source Type: ${paymentData.paymentSourceType}
    - Agent ID: ${agentIdentifier}
    - Purchaser ID: ${paymentData.identifierFromPurchaser}
  `);

	const paymentResponse: PaymentResponse = await global.testApiClient.createPayment(paymentData);

	expect(paymentResponse).toBeDefined();
	expect(paymentResponse.id).toBeDefined();
	expect(paymentResponse.blockchainIdentifier).toBeDefined();
	expect(paymentResponse.NextAction).toBeDefined();

	console.log(`✅ E2E: payment created:
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
		supportedPaymentSourceIndex: paymentData.supportedPaymentSourceIndex,
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
	console.log('🔍 E2E: creating payment (custom timing)...');

	console.log(`⏰ E2E: custom deadlines:
    - Pay By Time: ${customTiming.payByTime.toISOString()} ← Payment deadline
    - Submit Result Time: ${customTiming.submitResultTime.toISOString()} ← Work submission deadline  
    - Unlock Time: ${customTiming.unlockTime?.toISOString()} ← Funds unlock
    - External Dispute Time: ${customTiming.externalDisputeUnlockTime?.toISOString()} ← Dispute resolution
  `);

	const paymentData = generateTestPaymentData(network, agentIdentifier, {
		paymentSourceType: global.testConfig.paymentSourceType,
		customTiming,
	});

	console.log(`🎯 E2E: payment payload:
    - Network: ${paymentData.network}
    - Payment Source Type: ${paymentData.paymentSourceType}
    - Agent ID: ${agentIdentifier}
    - Purchaser ID: ${paymentData.identifierFromPurchaser}
  `);

	const paymentResponse: PaymentResponse = await global.testApiClient.createPayment(paymentData);

	expect(paymentResponse).toBeDefined();
	expect(paymentResponse.id).toBeDefined();
	expect(paymentResponse.blockchainIdentifier).toBeDefined();
	expect(paymentResponse.NextAction).toBeDefined();

	console.log(`✅ E2E: payment created (custom timing):
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
		supportedPaymentSourceIndex: paymentData.supportedPaymentSourceIndex,
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
export async function createPurchase(paymentResult: PaymentResult, agentData: ConfirmedAgent): Promise<PurchaseResult> {
	console.log('🛒 E2E: creating purchase (matching payment identifiers)...');

	// Use the blockchain identifier for purchase creation

	// Create purchase data manually using the payment data.
	// V2 purchases require `smartContractAddress` because the V2 signed
	// blockchainIdentifier payload binds to a specific contract, and the
	// purchase route verifies the body's address matches what the V2 source
	// is configured against. The payment response always carries the
	// PaymentSource it was scoped to, so reuse that.
	const purchaseData = {
		blockchainIdentifier: paymentResult.blockchainIdentifier,
		network: paymentResult.response.PaymentSource.network,
		smartContractAddress: paymentResult.response.PaymentSource.smartContractAddress,
		inputHash: paymentResult.inputHash,
		sellerVkey: agentData.SmartContractWallet.walletVkey,
		agentIdentifier: agentData.agentIdentifier,
		paymentSourceType: paymentResult.response.PaymentSource.paymentSourceType,
		supportedPaymentSourceIndex: paymentResult.supportedPaymentSourceIndex,
		unlockTime: paymentResult.unlockTime,
		externalDisputeUnlockTime: paymentResult.externalDisputeUnlockTime,
		submitResultTime: paymentResult.submitResultTime,
		payByTime: paymentResult.payByTime,
		identifierFromPurchaser: paymentResult.identifierFromPurchaser, // Use the original purchaser identifier
		metadata: `E2E Helper test purchase - ${new Date().toISOString()}`,
	};

	console.log(
		`🔄 E2E: purchase payload prepared — blockchainId=${paymentResult.blockchainIdentifier.substring(0, 50)}...`,
	);

	const purchaseResponse: PurchaseResponse = await global.testApiClient.createPurchase(purchaseData);

	expect(purchaseResponse).toBeDefined();
	expect(purchaseResponse.id).toBeDefined();
	expect(purchaseResponse.blockchainIdentifier).toBe(paymentResult.blockchainIdentifier);
	expect(purchaseResponse.inputHash).toBe(paymentResult.inputHash);
	expect(purchaseResponse.NextAction).toBeDefined();

	console.log(`✅ E2E: purchase created:
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
	optionsOrSignal?: AbortSignal | BlockchainStateWaitOptions,
): Promise<void> {
	console.log('⏳ E2E: waiting for FundsLocked (payment + purchase)...');
	const options = normalizeBlockchainStateWaitOptions(optionsOrSignal);
	const timeoutMs = options.timeoutMs ?? 0;
	const intervalMs = options.intervalMs ?? 5000;
	logBlockchainWaitMode('FundsLocked', timeoutMs);

	const fundsLockedStartTime = Date.now();
	await pollUntil(
		async () => {
			const elapsedMinutes = Math.floor((Date.now() - fundsLockedStartTime) / 60000);
			console.log(`⏱️ E2E: polling states for FundsLocked (${elapsedMinutes} min elapsed)`);

			const { currentPayment, currentPurchase } = await fetchPaymentAndPurchaseByBlockchainIdentifier(
				blockchainIdentifier,
				network,
			);
			if (currentPayment == undefined) {
				console.warn(`⚠️ E2E: payment not found yet (blockchainId=${blockchainIdentifier.substring(0, 50)}...)`);
			}
			if (currentPurchase == undefined) {
				console.warn(`⚠️ E2E: purchase not found yet (blockchainId=${blockchainIdentifier.substring(0, 50)}...)`);
			}

			if (!currentPayment || !currentPurchase) {
				throw new Error(`Payment/Purchase not found yet for blockchainId=${blockchainIdentifier}`);
			}

			if (currentPayment.NextAction.requestedAction === 'WaitingForManualAction') {
				throw new FatalE2EError(
					`Payment entered WaitingForManualAction (blockchainId=${blockchainIdentifier}) with error: ${currentPayment.NextAction.errorNote}`,
				);
			}
			if (currentPurchase.NextAction.requestedAction === 'WaitingForManualAction') {
				throw new FatalE2EError(
					`Purchase entered WaitingForManualAction (blockchainId=${blockchainIdentifier}) with error: ${currentPurchase.NextAction.errorNote}`,
				);
			}

			if (currentPayment.onChainState !== 'FundsLocked') {
				console.info(`ℹ️ E2E: waiting for FundsLocked — payment state=${currentPayment.onChainState}`);
			}
			if (currentPurchase.onChainState !== 'FundsLocked') {
				console.info(`ℹ️ E2E: waiting for FundsLocked — purchase state=${currentPurchase.onChainState}`);
			}

			if (currentPayment.NextAction.requestedAction !== 'WaitingForExternalAction') {
				console.info(
					`ℹ️ E2E: waiting for WaitingForExternalAction — payment action=${currentPayment.NextAction.requestedAction}`,
				);
			}
			if (currentPurchase.NextAction.requestedAction !== 'WaitingForExternalAction') {
				console.info(
					`ℹ️ E2E: waiting for WaitingForExternalAction — purchase action=${currentPurchase.NextAction.requestedAction}`,
				);
			}

			// Verify payment state
			expect(currentPayment.onChainState).toBe('FundsLocked');
			expect(currentPayment.NextAction.requestedAction).toBe('WaitingForExternalAction');

			// Verify purchase state matches payment state
			expect(currentPurchase.onChainState).toBe('FundsLocked');
			expect(currentPurchase.NextAction.requestedAction).toBe('WaitingForExternalAction');

			console.log(
				`📊 E2E: payment state=${currentPayment.onChainState}, action=${currentPayment.NextAction.requestedAction}`,
			);
			console.log(
				`📊 E2E: purchase state=${currentPurchase.onChainState}, action=${currentPurchase.NextAction.requestedAction}`,
			);
		},
		{ timeoutMs, intervalMs, label: 'FundsLocked', signal: options.signal },
	);

	const fundsLockedMinutes = Math.floor((Date.now() - fundsLockedStartTime) / 60000);
	console.log(`✅ E2E: FundsLocked reached after ${fundsLockedMinutes} min`);
}

/**
 * Wait for payment and purchase to reach ResultSubmitted state
 * @param blockchainIdentifier - The blockchain identifier to monitor
 * @param network - The blockchain network
 */
export async function waitForResultSubmitted(
	blockchainIdentifier: string,
	network: Network,
	optionsOrSignal?: AbortSignal | BlockchainStateWaitOptions,
): Promise<void> {
	console.log('⏳ E2E: waiting for ResultSubmitted (payment + purchase)...');
	const options = normalizeBlockchainStateWaitOptions(optionsOrSignal);
	const timeoutMs = options.timeoutMs ?? 0;
	const intervalMs = options.intervalMs ?? 5000;
	logBlockchainWaitMode('ResultSubmitted', timeoutMs);

	const resultSubmittedStartTime = Date.now();
	await pollUntil(
		async () => {
			const elapsedMinutes = Math.floor((Date.now() - resultSubmittedStartTime) / 60000);
			console.log(`⏱️ E2E: polling states for ResultSubmitted (${elapsedMinutes} min elapsed)`);

			const { currentPayment, currentPurchase } = await fetchPaymentAndPurchaseByBlockchainIdentifier(
				blockchainIdentifier,
				network,
			);

			if (currentPayment == undefined) {
				console.warn(`⚠️ E2E: payment not found yet (blockchainId=${blockchainIdentifier.substring(0, 50)}...)`);
			}
			if (currentPurchase == undefined) {
				console.warn(`⚠️ E2E: purchase not found yet (blockchainId=${blockchainIdentifier.substring(0, 50)}...)`);
			}

			expect(currentPayment).toBeDefined();
			expect(currentPurchase).toBeDefined();

			if (currentPayment!.NextAction.requestedAction === 'WaitingForManualAction') {
				throw new FatalE2EError(
					`Payment entered WaitingForManualAction (blockchainId=${blockchainIdentifier}) with error: ${currentPayment!.NextAction.errorNote}`,
				);
			}
			if (currentPurchase!.NextAction.requestedAction === 'WaitingForManualAction') {
				throw new FatalE2EError(
					`Purchase entered WaitingForManualAction (blockchainId=${blockchainIdentifier}) with error: ${currentPurchase!.NextAction.errorNote}`,
				);
			}

			if (currentPayment!.onChainState !== 'ResultSubmitted') {
				console.info(`ℹ️ E2E: waiting for ResultSubmitted — payment state=${currentPayment!.onChainState}`);
			}
			if (currentPurchase!.onChainState !== 'ResultSubmitted') {
				console.info(`ℹ️ E2E: waiting for ResultSubmitted — purchase state=${currentPurchase!.onChainState}`);
			}

			// Wait specifically for ResultSubmitted state after result submission
			expect(currentPayment!.onChainState).toBe('ResultSubmitted');
			expect(currentPurchase!.onChainState).toBe('ResultSubmitted');

			console.log(`✅ E2E: payment reached ResultSubmitted (state=${currentPayment!.onChainState})`);
			console.log(`✅ E2E: purchase reached ResultSubmitted (state=${currentPurchase!.onChainState})`);
		},
		{ timeoutMs, intervalMs, label: 'ResultSubmitted', signal: options.signal },
	);

	const resultSubmittedMinutes = Math.floor((Date.now() - resultSubmittedStartTime) / 60000);
	console.log(`✅ E2E: ResultSubmitted reached after ${resultSubmittedMinutes} min`);
}

/**
 * Wait for payment and purchase to reach Disputed state
 * @param blockchainIdentifier - The blockchain identifier to monitor
 * @param network - The blockchain network
 */
export async function waitForDisputed(
	blockchainIdentifier: string,
	network: Network,
	optionsOrSignal?: AbortSignal | BlockchainStateWaitOptions,
): Promise<void> {
	console.log('⏳ E2E: waiting for Disputed (payment + purchase)...');
	const options = normalizeBlockchainStateWaitOptions(optionsOrSignal);
	const timeoutMs = options.timeoutMs ?? 0;
	const intervalMs = options.intervalMs ?? 5000;
	logBlockchainWaitMode('Disputed', timeoutMs);

	const disputedWaitStartTime = Date.now();
	await pollUntil(
		async () => {
			const elapsedMinutes = Math.floor((Date.now() - disputedWaitStartTime) / 60000);
			console.log(`⏱️ E2E: polling states for Disputed (${elapsedMinutes} min elapsed)`);

			const { currentPayment, currentPurchase } = await fetchPaymentAndPurchaseByBlockchainIdentifier(
				blockchainIdentifier,
				network,
			);
			if (currentPayment == undefined) {
				console.warn(`⚠️ E2E: payment not found yet (blockchainId=${blockchainIdentifier.substring(0, 50)}...)`);
			}
			if (currentPurchase == undefined) {
				console.warn(`⚠️ E2E: purchase not found yet (blockchainId=${blockchainIdentifier.substring(0, 50)}...)`);
			}

			if (!currentPayment || !currentPurchase) {
				throw new Error(`Payment/Purchase not found yet for blockchainId=${blockchainIdentifier}`);
			}

			if (currentPayment.NextAction.requestedAction === 'WaitingForManualAction') {
				throw new FatalE2EError(
					`Payment entered WaitingForManualAction (blockchainId=${blockchainIdentifier}) with error: ${currentPayment.NextAction.errorNote}`,
				);
			}
			if (currentPurchase.NextAction.requestedAction === 'WaitingForManualAction') {
				throw new FatalE2EError(
					`Purchase entered WaitingForManualAction (blockchainId=${blockchainIdentifier}) with error: ${currentPurchase.NextAction.errorNote}`,
				);
			}

			if (currentPayment.onChainState !== 'Disputed') {
				console.info(`ℹ️ E2E: waiting for Disputed — payment state=${currentPayment.onChainState}`);
			}
			if (currentPurchase.onChainState !== 'Disputed') {
				console.info(`ℹ️ E2E: waiting for Disputed — purchase state=${currentPurchase.onChainState}`);
			}
			if (currentPayment.NextAction.requestedAction !== 'WaitingForExternalAction') {
				console.info(
					`ℹ️ E2E: waiting for WaitingForExternalAction — payment action=${currentPayment.NextAction.requestedAction}`,
				);
			}
			if (currentPurchase.NextAction.requestedAction !== 'WaitingForExternalAction') {
				console.info(
					`ℹ️ E2E: waiting for WaitingForExternalAction — purchase action=${currentPurchase.NextAction.requestedAction}`,
				);
			}

			// Wait until both payment and purchase reach Disputed state after refund request
			expect(currentPayment.onChainState).toBe('Disputed');
			expect(currentPayment.NextAction.requestedAction).toBe('WaitingForExternalAction');

			expect(currentPurchase.onChainState).toBe('Disputed');
			expect(currentPurchase.NextAction.requestedAction).toBe('WaitingForExternalAction');

			console.log('✅ E2E: payment is Disputed and ready for admin authorization');
			console.log('✅ E2E: purchase is Disputed and ready for admin authorization');
		},
		{ timeoutMs, intervalMs, label: 'Disputed', signal: options.signal },
	);

	const refundStateMinutes = Math.floor((Date.now() - disputedWaitStartTime) / 60000);
	console.log(`✅ E2E: Disputed reached after ${refundStateMinutes} min`);
}

/**
 * Wait for payment and purchase to reach RefundRequested state
 * @param blockchainIdentifier - The blockchain identifier to monitor
 * @param network - The blockchain network
 */
export async function waitForRefundRequested(
	blockchainIdentifier: string,
	network: Network,
	optionsOrSignal?: AbortSignal | BlockchainStateWaitOptions,
): Promise<void> {
	console.log('⏳ E2E: waiting for RefundRequested (payment + purchase)...');
	const options = normalizeBlockchainStateWaitOptions(optionsOrSignal);
	const timeoutMs = options.timeoutMs ?? 0;
	const intervalMs = options.intervalMs ?? 5000;
	logBlockchainWaitMode('RefundRequested', timeoutMs);

	const refundRequestedStartTime = Date.now();
	await pollUntil(
		async () => {
			const elapsedMinutes = Math.floor((Date.now() - refundRequestedStartTime) / 60000);
			console.log(`⏱️ E2E: polling states for RefundRequested (${elapsedMinutes} min elapsed)`);

			const { currentPayment, currentPurchase } = await fetchPaymentAndPurchaseByBlockchainIdentifier(
				blockchainIdentifier,
				network,
			);

			if (currentPayment == undefined) {
				console.warn(`⚠️ E2E: payment not found yet (blockchainId=${blockchainIdentifier.substring(0, 50)}...)`);
			}
			if (currentPurchase == undefined) {
				console.warn(`⚠️ E2E: purchase not found yet (blockchainId=${blockchainIdentifier.substring(0, 50)}...)`);
			}

			if (!currentPayment || !currentPurchase) {
				throw new Error(`Payment/Purchase not found yet for blockchainId=${blockchainIdentifier}`);
			}

			if (currentPayment.NextAction.requestedAction === 'WaitingForManualAction') {
				throw new FatalE2EError(
					`Payment entered WaitingForManualAction (blockchainId=${blockchainIdentifier}) with error: ${currentPayment.NextAction.errorNote}`,
				);
			}
			if (currentPurchase.NextAction.requestedAction === 'WaitingForManualAction') {
				throw new FatalE2EError(
					`Purchase entered WaitingForManualAction (blockchainId=${blockchainIdentifier}) with error: ${currentPurchase.NextAction.errorNote}`,
				);
			}

			if (currentPayment.onChainState !== 'RefundRequested') {
				console.info(`ℹ️ E2E: waiting for RefundRequested — payment state=${currentPayment.onChainState}`);
			}
			if (currentPurchase.onChainState !== 'RefundRequested') {
				console.info(`ℹ️ E2E: waiting for RefundRequested — purchase state=${currentPurchase.onChainState}`);
			}
			if (currentPayment.NextAction.requestedAction !== 'WaitingForExternalAction') {
				console.info(
					`ℹ️ E2E: waiting for WaitingForExternalAction — payment action=${currentPayment.NextAction.requestedAction}`,
				);
			}

			// Wait until both payment and purchase reach RefundRequested state
			expect(currentPayment.onChainState).toBe('RefundRequested');
			expect(currentPurchase.onChainState).toBe('RefundRequested');

			console.log('✅ E2E: payment is RefundRequested and ready for result submission');
			console.log('✅ E2E: purchase is RefundRequested and ready for result submission');
		},
		{ timeoutMs, intervalMs, label: 'RefundRequested', signal: options.signal },
	);

	const refundRequestedMinutes = Math.floor((Date.now() - refundRequestedStartTime) / 60000);
	console.log(`✅ E2E: RefundRequested reached after ${refundRequestedMinutes} min`);
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
export async function submitResult(blockchainIdentifier: string, network: Network): Promise<{ resultHash: string }> {
	console.log('🔍 E2E: generating and submitting a random SHA256 result...');

	const randomSHA256Hash = generateRandomSubmitResultHash();

	console.log(`🎯 E2E: submit-result payload:
    - Blockchain ID: ${blockchainIdentifier.substring(0, 50)}...
    - SHA256 Hash: ${randomSHA256Hash}
  `);

	const submitResultResponse = await global.testApiClient.request<PaymentResponse>('/api/v1/payment/submit-result', {
		method: 'POST',
		body: JSON.stringify({
			network: network,
			submitResultHash: randomSHA256Hash,
			blockchainIdentifier: blockchainIdentifier,
		}),
	});

	expect(submitResultResponse).toBeDefined();
	expect(submitResultResponse.blockchainIdentifier).toBe(blockchainIdentifier);

	// Verify the state transition
	expect(submitResultResponse.NextAction).toBeDefined();
	expect(submitResultResponse.NextAction.requestedAction).toBe('SubmitResultRequested');
	expect(submitResultResponse.NextAction.resultHash).toBe(randomSHA256Hash);

	console.log(`✅ E2E: result submitted:
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
export async function requestRefund(blockchainIdentifier: string, network: Network): Promise<PurchaseResponse> {
	console.log('💸 E2E: requesting refund...');

	const refundRequestResponse = await global.testApiClient.request<PurchaseResponse>(
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
	expect(refundRequestResponse.NextAction.requestedAction).toBe('SetRefundRequestedRequested');

	console.log('✅ E2E: refund request submitted');

	return refundRequestResponse;
}

/**
 * Authorize a refund as admin
 * @param blockchainIdentifier - The blockchain identifier to authorize refund for
 * @param network - The blockchain network
 * @returns Authorization response
 */
export async function authorizeRefund(blockchainIdentifier: string, network: Network): Promise<PaymentResponse> {
	console.log('👨‍💼 E2E: admin refund authorization (Disputed → Complete)...');

	const authorizeRefundResponse = await global.testApiClient.request<PaymentResponse>(
		'/api/v1/payment/authorize-refund',
		{
			method: 'POST',
			body: JSON.stringify({
				network: network,
				blockchainIdentifier: blockchainIdentifier,
			}),
		},
	);

	expect(authorizeRefundResponse).toBeDefined();
	expect(authorizeRefundResponse.id).toBeDefined();
	expect(authorizeRefundResponse.onChainState).toBeDefined();
	expect(authorizeRefundResponse.NextAction).toBeDefined();
	expect(authorizeRefundResponse.NextAction.requestedAction).toBe('AuthorizeRefundRequested');

	console.log(`✅ E2E: admin authorization requested:
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
export async function cancelRefundRequest(blockchainIdentifier: string, network: Network): Promise<PurchaseResponse> {
	console.log('ℹ️ E2E: cancelling refund request...');

	const cancelRefundResponse = await global.testApiClient.request<PurchaseResponse>(
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

	console.log(`✅ E2E: refund request cancelled:
    - Payment ID: ${cancelRefundResponse.id}
    - Next Action: ${cancelRefundResponse.NextAction.requestedAction}
  `);

	return cancelRefundResponse;
}
