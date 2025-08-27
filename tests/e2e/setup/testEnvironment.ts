import { ApiClient } from '../utils/apiClient';
import { getTestEnvironment } from '../fixtures/testData';
import { waitForServer } from '../utils/waitFor';
import dotenv from 'dotenv';
import path from 'path';

/**
 * Global test environment setup for e2e tests
 * This file is automatically loaded by Jest before running tests
 */

declare global {
  // eslint-disable-next-line no-var
  var testApiClient: ApiClient;
  // eslint-disable-next-line no-var
  var testConfig: ReturnType<typeof getTestEnvironment>;
}

beforeAll(async () => {
  console.log('🚀 Setting up E2E test environment...');

  // Load environment variables from .env.e2e file
  const envPath = path.resolve(process.cwd(), '.env.e2e');
  dotenv.config({ path: envPath });

  console.log('📁 Loading environment from:', envPath);

  // Load test configuration
  const config = getTestEnvironment();
  global.testConfig = config;

  console.log(`📊 Test Configuration:
    - Network: ${config.network}
    - API URL: ${config.apiUrl}
    - API Key: ${config.apiKey ? '***' + config.apiKey.slice(-4) : 'NOT SET'}
    - Registration Timeout: ${config.timeout.registration}ms
  `);

  // Validate required environment variables
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

  // Create global API client
  global.testApiClient = new ApiClient({
    baseUrl: config.apiUrl,
    apiKey: config.apiKey,
    timeout: config.timeout.api,
  });

  // Wait for server to be ready
  console.log('⏳ Waiting for server to be ready...');
  const serverResult = await waitForServer(global.testApiClient, {
    timeout: 60000, // 1 minute
    interval: 2000, // Check every 2 seconds
  });

  if (!serverResult.success) {
    console.error('❌ Server is not ready:', serverResult.error?.message);
    console.error(`
🔧 Make sure the server is running:
   npm run dev

And accessible at: ${config.apiUrl}
`);
    process.exit(1);
  }

  console.log('✅ Server is ready!');

  // Verify API key works
  try {
    const healthResponse = await global.testApiClient.healthCheck();
    console.log('🏥 Health check passed:', healthResponse);
  } catch (error) {
    console.error('❌ API key validation failed:', error);
    console.error(`
🔧 Verify your API key is correct:
   export TEST_API_KEY="your-valid-api-key"
`);
    process.exit(1);
  }

  console.log('✅ E2E test environment setup complete!');
}, 60000); // 1 minute timeout for setup

afterAll(() => {
  console.log('🧹 Cleaning up E2E test environment...');

  // Add any global cleanup here
  // For example, clean up test registrations, transactions, etc.

  console.log('✅ E2E test environment cleanup complete!');
});

// Global error handlers
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

export {};
