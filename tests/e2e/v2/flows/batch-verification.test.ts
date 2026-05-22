/**
 * Web3CardanoV2 batch-action verification e2e.
 *
 * Spins up N = 3 concurrent V2 payment threads against the same agent, then
 * submits each batch-capable action (submit-result → request-refund →
 * authorize-refund) and asserts that the V2 scheduler picked them up in a
 * single multi-redeemer transaction. The proof point is
 * `PaymentRequest.CurrentTransaction.txHash` (or `PurchaseRequest.…` for the
 * purchase-initiated action): when the V2 batch builder fires, every item in
 * the batch shares the same on-chain tx hash. If any pair disagrees, batching
 * regressed and the test fails.
 *
 * Why N = 3: it is the smallest value that distinguishes "batched 3" from
 * "happened to land in the same tick twice." The V2 services cap a single
 * batch at 7 (see `*_BATCH_SIZE` constants in
 * `packages/payment-source-v2/src/services/`), so 3 is well below the cap and
 * also leaves room for a future variant that pushes closer to the cap.
 *
 * V2-only by design. When the workflow pins this jest invocation to V1 via
 * TEST_PAYMENT_SOURCE_TYPE, the whole suite is `describe.skip`-ed.
 */

import { Network, PaymentSourceType } from '@/generated/prisma/enums';
import { validateTestWallets } from '../../fixtures/testWallets';
import {
	authorizeRefund,
	createPaymentWithCustomTiming,
	createPurchase,
	requestRefund,
	submitResult,
	TimingConfig,
	waitForDisputed,
	waitForFundsLocked,
	waitForResultSubmitted,
} from '../../helperFunctions';
import { PaymentResponse, PurchaseResponse } from '../../utils/apiClient';

const testNetwork = (process.env.TEST_NETWORK as Network) || Network.Preprod;
const envFilter = process.env.TEST_PAYMENT_SOURCE_TYPE as PaymentSourceType | undefined;
// V2-only suite. Skip when the workflow pinned this jest invocation to V1.
const describeFn = envFilter && envFilter !== PaymentSourceType.Web3CardanoV2 ? describe.skip : describe;

const BATCH_SIZE = 3;

/** Sleep helper. We use this to space out scheduler polls. */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll an async query and resolve when `predicate(value)` is true. Throws on
 * timeout. We don't reuse `pollUntil` from helperFunctions because it's
 * private to that module and we want a value-returning shape here.
 */
/**
 * Best-effort summary of an arbitrary value for the timeout error message.
 * Captures the fields the predicate actually cares about (`NextAction`,
 * `CurrentTransaction`, `onChainState`) without dumping the entire object —
 * those are the only fields the V2 batch tests check, and they are exactly
 * what we need to diagnose a stuck request post-hoc.
 */
function describeLastValue(value: unknown): string {
	if (value == null) return '<none>';
	if (typeof value !== 'object') return String(value);
	const v = value as Record<string, unknown>;
	const next = v.NextAction as Record<string, unknown> | undefined;
	const curr = v.CurrentTransaction as Record<string, unknown> | null | undefined;
	const summary = {
		blockchainIdentifier: typeof v.blockchainIdentifier === 'string' ? v.blockchainIdentifier.slice(0, 20) + '…' : undefined,
		onChainState: v.onChainState,
		requestedAction: next?.requestedAction,
		errorType: next?.errorType,
		errorNote: next?.errorNote,
		currentTxHash: curr?.txHash,
		currentTxStatus: curr?.status,
	};
	try {
		return JSON.stringify(summary);
	} catch {
		return 'present-but-failed-predicate (serialization failed)';
	}
}

async function pollForValue<T>(
	fetch: () => Promise<T>,
	predicate: (value: T) => boolean,
	options: { timeoutMs: number; intervalMs: number; label: string },
): Promise<T> {
	const startedAt = Date.now();
	const deadline = startedAt + options.timeoutMs;
	let lastValue: T | undefined;

	while (Date.now() < deadline) {
		try {
			lastValue = await fetch();
			if (predicate(lastValue)) {
				return lastValue;
			}
		} catch {
			// transient — swallow and retry
		}
		await sleep(options.intervalMs);
	}

	// Include a structured summary of the last observed value so a timeout
	// failure in CI is self-diagnostic: we see whether the request was stuck
	// in `WaitingForManualAction` (validation failed), still in its initial
	// `*Requested` state (scheduler never got to it), or transitioned to
	// `*Initiated` but `CurrentTransaction.txHash` was still null.
	throw new Error(
		`pollForValue timed out after ${Math.floor((Date.now() - startedAt) / 1000)}s (${options.label}); lastValue=${describeLastValue(lastValue)}`,
	);
}

async function fetchPaymentByBlockchainIdentifier(
	blockchainIdentifier: string,
	network: Network,
): Promise<PaymentResponse | undefined> {
	const response = await global.testApiClient.queryPayments({
		network,
		filterPaymentSourceType: PaymentSourceType.Web3CardanoV2,
	});
	return response.Payments.find((p) => p.blockchainIdentifier === blockchainIdentifier);
}

async function fetchPurchaseByBlockchainIdentifier(
	blockchainIdentifier: string,
	network: Network,
): Promise<PurchaseResponse | undefined> {
	const response = await global.testApiClient.queryPurchases({
		network,
		filterPaymentSourceType: PaymentSourceType.Web3CardanoV2,
	});
	return response.Purchases.find((p) => p.blockchainIdentifier === blockchainIdentifier);
}

/**
 * Assert every item in `values` is identical and non-null. Throws with a
 * useful diagnostic when batching regressed.
 */
function assertAllEqual<T>(values: Array<T | null | undefined>, label: string): T {
	if (values.length === 0) {
		throw new Error(`assertAllEqual(${label}): empty array`);
	}
	const first = values[0];
	if (first == null) {
		throw new Error(`assertAllEqual(${label}): first value is null/undefined`);
	}
	for (let i = 1; i < values.length; i++) {
		if (values[i] !== first) {
			throw new Error(
				`assertAllEqual(${label}): batching regressed — values[0]=${String(first)} but values[${i}]=${String(values[i])}`,
			);
		}
	}
	return first;
}

describeFn(`Web3CardanoV2 batch action verification (${testNetwork})`, () => {
	const blockchainIdentifiers: string[] = [];

	beforeAll(async () => {
		if (!global.testConfig) {
			throw new Error('Global test configuration not available. Check testEnvironment.ts setup.');
		}
		if (!global.testApiClient) {
			throw new Error('Test API client not initialized. Make sure test setup ran correctly.');
		}

		// Pin the global so any helper that reads `global.testConfig.paymentSourceType`
		// (without an explicit override) resolves to V2 inside this suite.
		global.testConfig.paymentSourceType = PaymentSourceType.Web3CardanoV2;

		const agent = global.testAgents?.[PaymentSourceType.Web3CardanoV2];
		if (!agent) {
			throw new Error(
				`No registered V2 agent — globalSetup probably skipped V2 (no V2 PaymentSource for ${testNetwork}?).`,
			);
		}
		global.testAgent = agent;

		const walletValidation = await validateTestWallets(testNetwork, PaymentSourceType.Web3CardanoV2);
		if (!walletValidation.valid) {
			walletValidation.errors.forEach((error) => console.error(`  - ${error}`));
			throw new Error('V2 test wallets are not properly configured.');
		}
	});

	test(
		`batches ${BATCH_SIZE} concurrent submit-result / request-refund / authorize-refund actions into single multi-redeemer txs`,
		async () => {
			const agent = global.testAgent;
			if (!agent) throw new Error('Test agent missing.');

			console.log(`🚀 V2 batch verification (${testNetwork}): creating ${BATCH_SIZE} concurrent payments…`);

			// ============================================================
			// Phase 0: create N payments + N purchases against the same agent.
			// ============================================================
			//
			// All N payments route to the agent's single SmartContractWallet on
			// the seller side; all N purchases land in the single V2 purchasing
			// wallet. Both wallets handle every batch action below, so the V2
			// scheduler should pack all N into one tx.
			const now = Date.now();
			const customTiming: TimingConfig = {
				payByTime: new Date(now + 30 * 60 * 1000),
				submitResultTime: new Date(now + 40 * 60 * 1000),
				unlockTime: new Date(now + 60 * 60 * 1000),
				externalDisputeUnlockTime: new Date(now + 90 * 60 * 1000),
			};

			// Sequential payment creation — the API is rate-limited and
			// parallel POSTs against the same agent's selling wallet have
			// historically tripped the rate limiter.
			const payments = [];
			for (let i = 0; i < BATCH_SIZE; i++) {
				const payment = await createPaymentWithCustomTiming(agent.agentIdentifier, testNetwork, customTiming);
				expect(payment.response.PaymentSource.paymentSourceType).toBe(PaymentSourceType.Web3CardanoV2);
				payments.push(payment);
				blockchainIdentifiers.push(payment.blockchainIdentifier);
				console.log(`✅ Created payment ${i + 1}/${BATCH_SIZE}: ${payment.blockchainIdentifier.substring(0, 50)}…`);
			}

			// Same for purchases — sequential.
			const purchases = [];
			for (let i = 0; i < BATCH_SIZE; i++) {
				const purchase = await createPurchase(payments[i], agent);
				purchases.push(purchase);
				console.log(`✅ Created purchase ${i + 1}/${BATCH_SIZE}`);
			}

			// ============================================================
			// Phase 1: wait for all N to reach FundsLocked.
			// ============================================================
			console.log('⏳ Waiting for FundsLocked on all batch members…');
			await Promise.all(payments.map((p) => waitForFundsLocked(p.blockchainIdentifier, testNetwork)));

			// ============================================================
			// Phase 2: submit-result × N → expect single batched tx.
			// ============================================================
			console.log(`📋 Submitting ${BATCH_SIZE} results within scheduler window…`);
			// Fire API calls in parallel so they all land in the same scheduler
			// tick window (CHECK_SUBMIT_RESULT_INTERVAL=15s by default).
			await Promise.all(payments.map((p) => submitResult(p.blockchainIdentifier, testNetwork)));

			console.log('⏳ Waiting for SubmitResultInitiated on every payment (proves the scheduler picked them up)…');
			const submitResultTxHashes = await Promise.all(
				payments.map(async (p) => {
					const payment = await pollForValue(
						() => fetchPaymentByBlockchainIdentifier(p.blockchainIdentifier, testNetwork),
						(value) =>
							value != null &&
							value.NextAction.requestedAction === 'SubmitResultInitiated' &&
							value.CurrentTransaction?.txHash != null,
						{ timeoutMs: 600_000, intervalMs: 3000, label: `SubmitResultInitiated ${p.blockchainIdentifier.slice(0, 16)}` },
					);
					return payment?.CurrentTransaction?.txHash ?? null;
				}),
			);
			console.log(`📊 Submit-result tx hashes per item: ${submitResultTxHashes.map((h) => h?.slice(0, 12) + '…').join(', ')}`);
			const batchedSubmitResultTxHash = assertAllEqual(submitResultTxHashes, 'submit-result txHash');
			console.log(`✅ Submit-result batched into single tx: ${batchedSubmitResultTxHash.slice(0, 20)}…`);

			console.log('⏳ Waiting for ResultSubmitted on every payment (on-chain confirmation of the batched tx)…');
			await Promise.all(payments.map((p) => waitForResultSubmitted(p.blockchainIdentifier, testNetwork)));

			// ============================================================
			// Phase 3: request-refund × N → expect single batched tx.
			// ============================================================
			console.log(`💸 Requesting ${BATCH_SIZE} refunds within scheduler window…`);
			await Promise.all(payments.map((p) => requestRefund(p.blockchainIdentifier, testNetwork)));

			console.log('⏳ Waiting for SetRefundRequestedInitiated on every purchase…');
			const requestRefundTxHashes = await Promise.all(
				purchases.map(async (p) => {
					const purchase = await pollForValue(
						() => fetchPurchaseByBlockchainIdentifier(p.blockchainIdentifier, testNetwork),
						(value) =>
							value != null &&
							value.NextAction.requestedAction === 'SetRefundRequestedInitiated' &&
							value.CurrentTransaction?.txHash != null,
						{
							timeoutMs: 600_000,
							intervalMs: 3000,
							label: `SetRefundRequestedInitiated ${p.blockchainIdentifier.slice(0, 16)}`,
						},
					);
					return purchase?.CurrentTransaction?.txHash ?? null;
				}),
			);
			console.log(`📊 Request-refund tx hashes per item: ${requestRefundTxHashes.map((h) => h?.slice(0, 12) + '…').join(', ')}`);
			const batchedRequestRefundTxHash = assertAllEqual(requestRefundTxHashes, 'request-refund txHash');
			console.log(`✅ Request-refund batched into single tx: ${batchedRequestRefundTxHash.slice(0, 20)}…`);

			console.log('⏳ Waiting for Disputed on every payment…');
			await Promise.all(payments.map((p) => waitForDisputed(p.blockchainIdentifier, testNetwork)));

			// ============================================================
			// Phase 4: authorize-refund × N → expect single batched tx.
			// ============================================================
			console.log(`👨‍💼 Authorizing ${BATCH_SIZE} refunds within scheduler window…`);
			await Promise.all(payments.map((p) => authorizeRefund(p.blockchainIdentifier, testNetwork)));

			console.log('⏳ Waiting for AuthorizeRefundInitiated on every payment…');
			const authorizeRefundTxHashes = await Promise.all(
				payments.map(async (p) => {
					const payment = await pollForValue(
						() => fetchPaymentByBlockchainIdentifier(p.blockchainIdentifier, testNetwork),
						(value) =>
							value != null &&
							value.NextAction.requestedAction === 'AuthorizeRefundInitiated' &&
							value.CurrentTransaction?.txHash != null,
						{
							timeoutMs: 600_000,
							intervalMs: 3000,
							label: `AuthorizeRefundInitiated ${p.blockchainIdentifier.slice(0, 16)}`,
						},
					);
					return payment?.CurrentTransaction?.txHash ?? null;
				}),
			);
			console.log(
				`📊 Authorize-refund tx hashes per item: ${authorizeRefundTxHashes.map((h) => h?.slice(0, 12) + '…').join(', ')}`,
			);
			const batchedAuthorizeRefundTxHash = assertAllEqual(authorizeRefundTxHashes, 'authorize-refund txHash');
			console.log(`✅ Authorize-refund batched into single tx: ${batchedAuthorizeRefundTxHash.slice(0, 20)}…`);

			console.log(`🎉 V2 batch verification PASSED (${BATCH_SIZE} items × 3 actions = 3 single batched txs).`);
		},
		30 * 60 * 1000, // 30 minutes total — three batched on-chain actions + waits.
	);
});
