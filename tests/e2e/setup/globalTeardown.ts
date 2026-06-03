import dotenv from 'dotenv';
import { deregisterAndConfirmAgent } from '../helperFunctions';
import { ApiClient } from '../utils/apiClient';
import { getTestEnvironment } from '../fixtures/testData';
import './globals';
import { decodeE2EGlobalState, E2E_GLOBAL_STATE_ENV_KEY, type E2EGlobalState } from './e2eGlobalState';
import { PaymentSourceType } from '@/generated/prisma/enums';

async function safeReadState(): Promise<E2EGlobalState | null> {
	try {
		const encoded = process.env[E2E_GLOBAL_STATE_ENV_KEY];
		if (!encoded) return null;
		return decodeE2EGlobalState(encoded);
	} catch {
		return null;
	}
}

/**
 * Jest global teardown for E2E tests.
 * Runs ONCE per Jest invocation (not per test file).
 *
 * Deregisters every agent we registered during setup. Uses `Promise.allSettled`
 * so a teardown failure on one source type doesn't prevent cleanup of the others.
 */
export default async function globalTeardown() {
	const GLOBAL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
	const teardownPromise = (async () => {
		console.log('🧹 [globalTeardown] Cleaning up E2E test environment (once)...');

		dotenv.config();
		const config = getTestEnvironment();
		const apiClient = new ApiClient({
			baseUrl: config.apiUrl,
			apiKey: config.apiKey,
			timeout: config.timeout.api,
		});
		global.testConfig = config;
		global.testApiClient = apiClient;

		const state = await safeReadState();
		if (state?.agents) {
			const entries = Object.entries(state.agents) as Array<
				[PaymentSourceType, NonNullable<E2EGlobalState['agents'][PaymentSourceType]>]
			>;
			const results = await Promise.allSettled(
				entries.map(([sourceType, agent]) => {
					if (!agent?.agentIdentifier) {
						return Promise.resolve();
					}
					console.log(`🔄 [globalTeardown] Deregistering ${sourceType} agent ${agent.agentIdentifier}...`);
					return deregisterAndConfirmAgent(state.network, agent.agentIdentifier, undefined, sourceType);
				}),
			);

			for (const [index, result] of results.entries()) {
				const [sourceType] = entries[index];
				if (result.status === 'rejected') {
					console.error(`❌ [globalTeardown] Failed to deregister ${sourceType} agent:`, result.reason);
				} else {
					console.log(`✅ [globalTeardown] Deregistered ${sourceType} agent.`);
				}
			}
		}

		delete process.env[E2E_GLOBAL_STATE_ENV_KEY];

		console.log('✅ [globalTeardown] Cleanup complete!');
	})();

	const timeoutPromise = new Promise<never>((_, reject) => {
		const t = setTimeout(() => {
			clearTimeout(t);
			reject(new Error(`[globalTeardown] Timed out after ${GLOBAL_TIMEOUT_MS}ms (10 minutes)`));
		}, GLOBAL_TIMEOUT_MS);
	});

	await Promise.race([teardownPromise, timeoutPromise]);
}
