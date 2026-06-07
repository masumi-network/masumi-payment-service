import { ApiClient } from '../utils/apiClient';
import { getTestEnvironment } from '../fixtures/testData';
import dotenv from 'dotenv';
import './globals';
import { decodeE2EGlobalState, E2E_GLOBAL_STATE_ENV_KEY, type E2EGlobalState } from './e2eGlobalState';
import { PaymentSourceType } from '@/generated/prisma/enums';

/**
 * Global test environment setup for e2e tests
 * This file is automatically loaded by Jest before running tests
 */

function readGlobalStateFromEnv(): E2EGlobalState {
	const encoded = process.env[E2E_GLOBAL_STATE_ENV_KEY];
	if (!encoded) {
		throw new Error(
			`E2E global state not found in env var ${E2E_GLOBAL_STATE_ENV_KEY}.\n` +
				`This usually means Jest globalSetup didn't run or failed.`,
		);
	}
	return decodeE2EGlobalState(encoded);
}

beforeAll(async () => {
	// Keep per-file setup lightweight: config + api client + read global agents map
	dotenv.config();

	const config = getTestEnvironment();
	global.testConfig = config;

	global.testApiClient = new ApiClient({
		baseUrl: config.apiUrl,
		apiKey: config.apiKey,
		timeout: config.timeout.api,
	});

	const state = readGlobalStateFromEnv();
	global.testAgents = state.agents;

	// `global.testAgent` remains as a back-compat default so anything that hasn't
	// been parameterized yet still has a sensible agent to fall back on. The
	// `describe.each` blocks overwrite this per iteration with the matching type.
	const fallbackAgent =
		state.agents[PaymentSourceType.Web3CardanoV1] ?? state.agents[PaymentSourceType.Web3CardanoV2] ?? undefined;
	if (fallbackAgent) {
		global.testAgent = fallbackAgent;
	}
});

// Global error handlers
if (!global.__e2eErrorHandlersInstalled) {
	global.__e2eErrorHandlersInstalled = true;

	process.on('unhandledRejection', (reason, promise) => {
		console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
	});

	process.on('uncaughtException', (error) => {
		console.error('❌ Uncaught Exception:', error);
		process.exit(1);
	});
}

export {};
