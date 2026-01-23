import dotenv from 'dotenv';
import { deregisterAndConfirmAgent } from '../helperFunctions';
import { ApiClient } from '../utils/apiClient';
import { getTestEnvironment } from '../fixtures/testData';
import './globals';
import {
  decodeE2EGlobalState,
  E2E_GLOBAL_STATE_ENV_KEY,
  type E2EGlobalState,
} from './e2eGlobalState';

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
    if (state?.agent?.agentIdentifier) {
      await deregisterAndConfirmAgent(state.network, state.agent.agentIdentifier);
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
