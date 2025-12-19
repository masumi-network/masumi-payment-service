import dotenv from 'dotenv';
import { ApiClient } from '../utils/apiClient';
import { getTestEnvironment } from '../fixtures/testData';
import { waitForServer } from '../utils/waitFor';
import { registerAndConfirmAgent } from '../helperFunctions';
import './globals';
import {
  E2E_GLOBAL_STATE_ENV_KEY,
  encodeE2EGlobalState,
  type E2EGlobalState,
} from './e2eGlobalState';

/**
 * Jest global setup for E2E tests.
 * Runs ONCE per Jest invocation (not per test file).
 */
export default async function globalSetup() {
  const GLOBAL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
  const setupPromise = (async () => {
    console.log('🚀 [globalSetup] Setting up E2E test environment (once)...');

    dotenv.config();

    const config = getTestEnvironment();

    const requiredEnvVars = ['TEST_API_KEY'];
    const missingVars = requiredEnvVars.filter(
      (varName) => !process.env[varName],
    );
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

    console.log('🧑‍💻 [globalSetup] Registering shared E2E agent...');
    const agent = await registerAndConfirmAgent(config.network);

    const state: E2EGlobalState = {
      network: config.network,
      agent,
      createdAt: new Date().toISOString(),
    };

    process.env[E2E_GLOBAL_STATE_ENV_KEY] = encodeE2EGlobalState(state);

    console.log(`✅ [globalSetup] Shared agent ready:
    - Agent Name: ${agent.name}
    - Agent ID: ${agent.id}
    - Agent Identifier: ${agent.agentIdentifier}
  `);
  })();

  const timeoutPromise = new Promise<never>((_, reject) => {
    const t = setTimeout(() => {
      clearTimeout(t);
      reject(
        new Error(
          `[globalSetup] Timed out after ${GLOBAL_TIMEOUT_MS}ms (10 minutes)`,
        ),
      );
    }, GLOBAL_TIMEOUT_MS);
  });

  await Promise.race([setupPromise, timeoutPromise]);
}
