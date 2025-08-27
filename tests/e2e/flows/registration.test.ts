import { Network } from '@prisma/client';
import {
  generateTestRegistrationData,
  getTestScenarios,
} from '../fixtures/testData';
import { getTestWallet, validateTestWallets } from '../fixtures/testWallets';
import waitForExpect from 'wait-for-expect';
import { ApiClient } from '../utils/apiClient';
import { getTestEnvironment } from '../fixtures/testData';

declare global {
  var testApiClient: ApiClient;
  var testConfig: ReturnType<typeof getTestEnvironment>;
}

describe('Agent Registration E2E Flow', () => {
  let testNetwork: Network;
  let testCleanupData: Array<{
    registrationId: string;
    agentIdentifier?: string;
  }> = [];

  beforeAll(async () => {
    console.log('🧪 Starting Registration E2E tests...');

    // Wait for global setup to complete
    if (!(global as any).testConfig) {
      throw new Error(
        'Global test configuration not available. Check testEnvironment.ts setup.',
      );
    }

    testNetwork = (global as any).testConfig.network;

    // Validate test wallet configuration
    const walletValidation = validateTestWallets(testNetwork);
    if (!walletValidation.valid) {
      console.error('❌ Test wallet validation failed:');
      walletValidation.errors.forEach((error) => console.error(`  - ${error}`));
      throw new Error(
        'Test wallets not properly configured. See fixtures/testWallets.ts',
      );
    }

    console.log(`✅ Test wallets validated for network: ${testNetwork}`);
  });

  afterAll(async () => {
    console.log('🧹 Cleaning up registration test data...');

    // Cleanup for created test registrations could be implemented here
    for (const cleanupItem of testCleanupData) {
      console.log(
        `🗑️  Should clean up registration: ${cleanupItem.registrationId}`,
      );
    }

    testCleanupData = [];
  });

  describe('Successful Registration Flow', () => {
    test(
      'should register one agent and wait for blockchain confirmation',
      async () => {
        // Arrange
        console.log('📝 Preparing basic agent registration test...');

        const testWallet = getTestWallet(testNetwork, 'seller', 0);
        const testScenario = getTestScenarios().basicAgent;

        const registrationData = generateTestRegistrationData(
          testNetwork,
          testWallet.vkey,
          testScenario,
        );

        console.log(`🎯 Test Registration Data:
        - Agent Name: ${registrationData.name}
        - Network: ${registrationData.network}
        - Wallet: ${testWallet.name}
        - Pricing: ${registrationData.AgentPricing.Pricing.map((p) => `${p.amount} ${p.unit}`).join(', ')}
      `);

        // Act - Step 1: Submit registration
        console.log('🚀 Step 1: Submitting registration request...');
        const registrationResponse = await (
          global as any
        ).testApiClient.registerAgent(registrationData);

        // Assert - Initial response
        expect(registrationResponse).toBeDefined();
        expect(registrationResponse.id).toBeDefined();
        expect(registrationResponse.name).toBe(registrationData.name);
        expect(registrationResponse.state).toBe('RegistrationRequested');
        expect(registrationResponse.SmartContractWallet).toBeDefined();

        console.log(`✅ Registration submitted successfully:
        - ID: ${registrationResponse.id}
        - State: ${registrationResponse.state}
        - Wallet Address: ${registrationResponse.SmartContractWallet.walletAddress}
      `);

        // Track for cleanup
        testCleanupData.push({ registrationId: registrationResponse.id });

        // Act - Step 2: Wait for registration to be confirmed using wait-for-expect
        console.log('⏳ Step 2: Waiting for registration confirmation...');
        let confirmedRegistration: any;

        // Configure wait-for-expect
        waitForExpect.defaults.timeout = (
          global as any
        ).testConfig.timeout.registration; // 5 minutes
        waitForExpect.defaults.interval = 10000; // Check every 10 seconds

        await waitForExpect(async () => {
          console.log(
            `🔄 Checking registration state for ${registrationResponse.id}...`,
          );
          const registration = await (
            global as any
          ).testApiClient.getRegistrationById(
            registrationResponse.id,
            testNetwork,
          );

          if (!registration) {
            throw new Error(
              `Registration ${registrationResponse.id} not found`,
            );
          }

          console.log(
            `📊 Registration ${registrationResponse.id} current state: ${registration.state}`,
          );

          // Check for error states
          if (registration.state === 'RegistrationFailed') {
            throw new Error(`Registration failed: Unknown error`);
          }

          // Assert registration is confirmed (this will keep retrying until true)
          expect(registration.state).toBe('RegistrationConfirmed');
          confirmedRegistration = registration;
        });

        // Assert - Registration confirmed
        expect(confirmedRegistration).toBeDefined();
        expect(confirmedRegistration.state).toBe('RegistrationConfirmed');

        console.log(`✅ Registration confirmed successfully!`);

        // Act - Step 3: Wait for agent identifier using wait-for-expect
        console.log('🎯 Step 3: Waiting for agent identifier...');
        let agentIdentifier: string | undefined;

        // Configure shorter timeout for agent identifier (should be quick after confirmation)
        waitForExpect.defaults.timeout = 60000; // 1 minute
        waitForExpect.defaults.interval = 5000; // Check every 5 seconds

        await waitForExpect(async () => {
          const registration = await (
            global as any
          ).testApiClient.getRegistrationById(
            registrationResponse.id,
            testNetwork,
          );

          if (!registration) {
            throw new Error(
              `Registration ${registrationResponse.id} not found`,
            );
          }

          if (registration.agentIdentifier) {
            console.log(
              `🎯 Agent identifier found: ${registration.agentIdentifier}`,
            );
            agentIdentifier = registration.agentIdentifier;
            // Assert that agent identifier exists and matches expected format
            expect(registration.agentIdentifier).toMatch(
              /^[a-f0-9]{56}[a-f0-9]+$/,
            );
            return;
          }

          console.log(
            `⚠️  Agent identifier not yet available for ${registrationResponse.id}`,
          );
          throw new Error(`Agent identifier not yet available`);
        });

        // Assert - Agent identifier populated
        expect(agentIdentifier).toBeDefined();
        console.log(`🎯 Agent identifier created: ${agentIdentifier!}`);

        // Update cleanup data
        testCleanupData[testCleanupData.length - 1].agentIdentifier =
          agentIdentifier;

        // Act - Step 4: Verify agent appears in registry query
        console.log('🔍 Step 4: Verifying agent appears in registry...');
        const registryResponse = await (
          global as any
        ).testApiClient.queryRegistry({
          network: testNetwork,
          // Can filter by smart contract address if needed
        });

        // Assert - Agent in registry
        expect(registryResponse.Assets).toBeDefined();
        const foundAgent = registryResponse.Assets.find(
          (asset: any) => asset.id === registrationResponse.id,
        );

        expect(foundAgent).toBeDefined();
        expect(foundAgent!.agentIdentifier).toBe(agentIdentifier!);
        expect(foundAgent!.name).toBe(registrationData.name);
        expect(foundAgent!.state).toBe('RegistrationConfirmed');

        console.log('✅ Agent successfully found in registry query');

        // Final verification
        console.log(`🎉 Registration E2E test completed successfully!
        - Registration ID: ${registrationResponse.id}
        - Agent Identifier: ${agentIdentifier!}
        - Total time: ${Date.now() - new Date(registrationResponse.createdAt).getTime()}ms
      `);
      },
      10 * 60 * 1000,
    ); // 10 minute test timeout
  });
});
