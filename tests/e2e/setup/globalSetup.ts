// Register tsconfig paths FIRST to enable @/ aliases in globalSetup
import 'tsconfig-paths/register';
import dotenv from 'dotenv';
import { ApiClient } from '../utils/apiClient';
import { getTestEnvironment } from '../fixtures/testData';
import { waitForServer } from '../utils/waitFor';
import { registerAndConfirmAgent, type ConfirmedAgent } from '../helperFunctions';
import { getSellingWalletVkeys, validateE2EPaymentSourceWallets } from '../utils/paymentSourceHelper';
import { assertPurchasingWalletFunded } from '../utils/walletFunding';
import './globals';
import { E2E_GLOBAL_STATE_ENV_KEY, encodeE2EGlobalState, type E2EGlobalState } from './e2eGlobalState';
import { PaymentSourceType } from '@/generated/prisma/enums';
import type { Config } from '@jest/types';

/**
 * How many agents (and therefore selling hot wallets) each payment source uses.
 *
 * Defaults to 1: one agent per source, shared by every flow file, which is what
 * the suite did when its flows ran one at a time. Raise it only when the source
 * has that many funded selling wallets seeded.
 */
function parseAgentsPerSource(): number {
	const raw = process.env.E2E_AGENTS_PER_SOURCE;
	if (raw == null || raw.trim() === '') return 1;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`E2E_AGENTS_PER_SOURCE must be a positive integer, got "${raw}"`);
	}
	return parsed;
}

/**
 * Jest global setup for E2E tests.
 * Runs ONCE per Jest invocation (not per test file).
 *
 * Discovers every PaymentSource the API exposes for the test network and
 * registers one agent per selling hot wallet, all in parallel. The resulting
 * agents are stored under their PaymentSourceType so the flow files can pick
 * one (see `pickAgentForSlot`) without re-registering.
 */
export default async function globalSetup(globalConfig: Config.GlobalConfig) {
	const GLOBAL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
	// AbortController cancels in-flight registrations when the global timeout
	// fires. Without this, the timeout rejection wins the Promise.race but
	// per-agent on-chain registrations keep running to completion in the
	// background — and never get persisted to state.agents because the parent
	// process has already failed. Teardown then leaks those orphans on chain.
	const abortController = new AbortController();
	const setupPromise = (async () => {
		console.log('🚀 [globalSetup] Setting up E2E test environment (once)...');

		dotenv.config();

		const config = getTestEnvironment();

		const requiredEnvVars = ['TEST_API_KEY'];
		const missingVars = requiredEnvVars.filter((varName) => !process.env[varName]);
		if (missingVars.length > 0) {
			console.error('❌ Missing required environment variables:', missingVars);
			console.error(`
🔧 Please set the following environment variables:
${missingVars.map((v) => `   export ${v}="your-value-here"`).join('\n')}

Example setup:
   export TEST_API_KEY="your-test-api-key"
   export TEST_NETWORK="Preprod"
   export TEST_API_URL="http://localhost:3000"
`);
			process.exit(1);
		}

		const apiClient = new ApiClient({
			baseUrl: config.apiUrl,
			apiKey: config.apiKey,
			timeout: config.timeout.api,
		});

		// Helpers in tests/e2e/helperFunctions.ts expect these globals to exist.
		global.testConfig = config;
		global.testApiClient = apiClient;

		console.log('⏳ [globalSetup] Waiting for server to be ready...');
		const serverResult = await waitForServer(apiClient, {
			timeout: 60000,
			interval: 2000,
		});

		if (!serverResult.success) {
			console.error('❌ Server is not ready:', serverResult.error?.message);
			console.error(`
🔧 Make sure the server is running:
And accessible at: ${config.apiUrl}
`);
			process.exit(1);
		}

		console.log('✅ [globalSetup] Server is ready!');

		try {
			const healthResponse = await apiClient.healthCheck();
			console.log('🏥 [globalSetup] Health check passed:', healthResponse);
		} catch (error) {
			console.error('❌ API key validation failed:', error);
			console.error(`
🔧 Verify your API key is correct:
   export TEST_API_KEY="your-valid-api-key"
`);
			process.exit(1);
		}

		// Discover which PaymentSources exist for this network. We only register
		// agents for the ones the API actually exposes — environments without
		// V2 seeded should still run the V1 flows without skipping.
		console.log('🔎 [globalSetup] Discovering PaymentSources for test network...');
		const paymentSources = await apiClient.queryPaymentSources({ take: 100 });
		const sourceTypesForNetwork = paymentSources.ExtendedPaymentSources.filter((ps) => ps.network === config.network)
			.map((ps) => ps.paymentSourceType)
			// Preserve a stable order so logs are predictable: V1 first when present.
			.sort((a, b) => a.localeCompare(b));

		let uniqueSourceTypes = Array.from(new Set(sourceTypesForNetwork)) as PaymentSourceType[];

		// When the workflow spawns one jest invocation per source type (V1 and V2
		// running in parallel against the shared API + DB), each invocation sets
		// TEST_PAYMENT_SOURCE_TYPE to pin itself to a single source. We then
		// register ONLY that source's agent here; the sibling invocation
		// registers the other. Without the filter, both invocations would try
		// to register both agents and fight over each other's wallets/locks.
		const envSourceType = process.env.TEST_PAYMENT_SOURCE_TYPE as PaymentSourceType | undefined;
		if (envSourceType) {
			const wanted = uniqueSourceTypes.filter((s) => s === envSourceType);
			if (wanted.length === 0) {
				console.error(
					`❌ TEST_PAYMENT_SOURCE_TYPE=${envSourceType} but no matching PaymentSource exists for network ${config.network}.`,
				);
				process.exit(1);
			}
			uniqueSourceTypes = wanted;
			console.log(`🎯 [globalSetup] TEST_PAYMENT_SOURCE_TYPE pins this invocation to ${envSourceType}.`);
		}

		if (uniqueSourceTypes.length === 0) {
			console.error(
				`❌ No PaymentSources found for network ${config.network}. Seed the database before running E2E tests.`,
			);
			process.exit(1);
		}

		console.log(`🔎 [globalSetup] Found PaymentSource types: ${uniqueSourceTypes.join(', ')}`);

		console.log('🔎 [globalSetup] Validating E2E payment source wallets...');
		for (const sourceType of uniqueSourceTypes) {
			const walletValidation = await validateE2EPaymentSourceWallets(config.network, sourceType, apiClient);
			if (!walletValidation.valid) {
				console.error(`❌ E2E payment source wallet validation failed for ${sourceType}:`);
				for (const err of walletValidation.errors) console.error(`   - ${err}`);
				process.exit(1);
			}
		}

		// Flow files run concurrently, so their funds-locks are packed into one
		// transaction from one purchasing wallet instead of arriving one at a
		// time. `maxWorkers` bounds how many can land in a single batch. Checked
		// here, before any on-chain work: the batch builder parks requests it
		// cannot fund in WaitingForManualAction/InsufficientFunds, which never
		// retries, so an underfunded wallet has to surface as a clear message
		// rather than as a stuck flow ten minutes in.
		console.log(
			`🔎 [globalSetup] Checking purchasing wallet funds for ${globalConfig.maxWorkers} concurrent lock(s)...`,
		);
		for (const sourceType of uniqueSourceTypes) {
			await assertPurchasingWalletFunded({
				network: config.network,
				paymentSourceType: sourceType,
				concurrentLocks: globalConfig.maxWorkers,
				apiClient,
			});
		}

		// One agent per selling hot wallet, up to E2E_AGENTS_PER_SOURCE. Flow files
		// run concurrently and V1 takes one request per hot wallet per scheduler
		// tick, so giving each flow its own selling wallet lets them overlap
		// instead of queueing. Opt-in: the default of 1 registers exactly one
		// agent per source, which is what every flow shared before, and leaves
		// environments that happen to have several selling wallets untouched.
		const agentsPerSource = parseAgentsPerSource();
		const registrationTargets: { sourceType: PaymentSourceType; sellingWalletVkey: string }[] = [];
		for (const sourceType of uniqueSourceTypes) {
			const availableVkeys = await getSellingWalletVkeys(config.network, sourceType, apiClient);
			const sellingWalletVkeys = availableVkeys.slice(0, agentsPerSource);
			if (availableVkeys.length < agentsPerSource) {
				console.warn(
					`⚠️ [globalSetup] ${sourceType}: E2E_AGENTS_PER_SOURCE=${agentsPerSource} but only ` +
						`${availableVkeys.length} selling wallet(s) are seeded. Flows will share wallets and pipeline. ` +
						`Seed more with SELLING_WALLET_<NETWORK>_MNEMONIC_2, _3, ... (each must be funded).`,
				);
			}
			console.log(`🔑 [globalSetup] ${sourceType}: registering ${sellingWalletVkeys.length} agent(s)`);
			for (const sellingWalletVkey of sellingWalletVkeys) {
				registrationTargets.push({ sourceType, sellingWalletVkey });
			}
		}

		console.log(`🧑‍💻 [globalSetup] Registering ${registrationTargets.length} shared E2E agent(s) in parallel...`);
		// Promise.allSettled (not Promise.all) so a single agent's failure
		// doesn't strand a sibling's on-chain registration as an orphan. We
		// persist whatever succeeded BEFORE throwing so teardown can deregister
		// succeeded agents. Pass the signal so per-agent pollUntil loops bail out
		// when the global timeout fires instead of continuing on-chain work whose
		// result will be discarded.
		const registrationResults = await Promise.allSettled(
			registrationTargets.map(async ({ sourceType, sellingWalletVkey }) => {
				const agent = await registerAndConfirmAgent(
					config.network,
					sourceType,
					abortController.signal,
					sellingWalletVkey,
				);
				return [sourceType, agent] as const;
			}),
		);

		const agents: Partial<Record<PaymentSourceType, ConfirmedAgent[]>> = {};
		const failures: { sourceType: PaymentSourceType; sellingWalletVkey: string; error: string }[] = [];
		for (let i = 0; i < registrationResults.length; i++) {
			const result = registrationResults[i];
			if (result.status === 'fulfilled') {
				const [sourceType, agent] = result.value;
				(agents[sourceType] ??= []).push(agent);
			} else {
				failures.push({
					sourceType: registrationTargets[i].sourceType,
					sellingWalletVkey: registrationTargets[i].sellingWalletVkey,
					error: result.reason instanceof Error ? result.reason.message : String(result.reason),
				});
			}
		}

		const state: E2EGlobalState = {
			network: config.network,
			agents,
			createdAt: new Date().toISOString(),
		};

		// Persist BEFORE potentially throwing so teardown can read the partial
		// state and deregister the agents that did succeed.
		process.env[E2E_GLOBAL_STATE_ENV_KEY] = encodeE2EGlobalState(state);

		const registeredCount = Object.values(agents).reduce((total, list) => total + list.length, 0);

		if (failures.length > 0) {
			console.error('❌ [globalSetup] One or more agent registrations failed:');
			for (const { sourceType, sellingWalletVkey, error } of failures) {
				console.error(`   - ${sourceType} (selling wallet ${sellingWalletVkey}): ${error}`);
			}
			console.error(`✅ [globalSetup] ${registeredCount} succeeded — teardown will deregister those if reached.`);
			throw new Error(`Agent registration failed for ${failures.length} of ${registrationTargets.length} agents`);
		}

		console.log('✅ [globalSetup] Shared agents ready:');
		for (const sourceType of uniqueSourceTypes) {
			for (const agent of agents[sourceType] ?? []) {
				console.log(`    - ${sourceType}: ${agent.name} (${agent.agentIdentifier})`);
			}
		}
	})();

	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutHandle = setTimeout(() => {
			// Signal in-flight pollUntil loops to abort so they don't keep
			// the event loop alive after the parent has failed.
			abortController.abort(new Error('globalSetup timeout'));
			reject(new Error(`[globalSetup] Timed out after ${GLOBAL_TIMEOUT_MS}ms (10 minutes)`));
		}, GLOBAL_TIMEOUT_MS);
	});

	try {
		await Promise.race([setupPromise, timeoutPromise]);
	} finally {
		if (timeoutHandle != null) clearTimeout(timeoutHandle);
	}
}
