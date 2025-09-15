/**
 * Agent Register and Deregister Flow E2E Test
 *
 * This test demonstrates the complete agent lifecycle:
 * 1. Register Agent
 * 2. Wait for Registration Confirmation
 * 3. Wait for Agent Identifier
 * 4. Deregister Agent
 *
 * Key Features:
 * - Complete agent lifecycle testing
 * - Self-contained (creates own agent)
 * - Blockchain confirmation waiting
 * - Dynamic database queries
 */

import { Network } from '@prisma/client';
import { validateTestWallets } from '../fixtures/testWallets';
import {
  getActiveSmartContractAddress,
  getTestWalletFromDatabase,
} from '../utils/paymentSourceHelper';
import {
  generateTestRegistrationData,
  getTestScenarios,
} from '../fixtures/testData';
import waitForExpect from 'wait-for-expect';

const testNetwork = (process.env.TEST_NETWORK as Network) || Network.Preprod;

describe(`Agent Register and Deregister Flow E2E Tests (${testNetwork})`, () => {
  const testCleanupData: Array<{
    registrationId?: string;
    agentId?: string;
    agentIdentifier?: string;
    agentName?: string;
    registered?: boolean;
    confirmed?: boolean;
    deregistered?: boolean;
  }> = [{}];

  beforeAll(async () => {
    if (!(global as any).testConfig) {
      throw new Error('Global test configuration not available.');
    }

    const walletValidation = validateTestWallets(testNetwork);
    if (!walletValidation.valid) {
      walletValidation.errors.forEach((error) => console.error(`  - ${error}`));
      throw new Error('Test wallets not properly configured.');
    }

    if (!(global as any).testApiClient) {
      throw new Error('Test API client not initialized.');
    }

    console.log(
      `✅ Agent Register and Deregister Flow environment validated for ${testNetwork}`,
    );
  });

  afterAll(async () => {
    if (testCleanupData.length > 0) {
      console.log('🧹 Agent Register and Deregister Flow cleanup data:');
      testCleanupData.forEach((item) => {
        console.log(`   Registration ID: ${item.registrationId}`);
        console.log(`   Agent: ${item.agentName} (${item.agentId})`);
        console.log(`   Identifier: ${item.agentIdentifier}`);
        console.log(`   Registered: ${item.registered}`);
        console.log(`   Confirmed: ${item.confirmed}`);
        console.log(`   Deregistered: ${item.deregistered}`);
      });
    }
  });

  test(
    'Complete agent lifecycle: register → confirm → deregister',
    async () => {
      console.log('🚀 Starting Agent Register and Deregister Flow...');
      const flowStartTime = Date.now();

      // ============================
      // STEP 1: REGISTER AGENT
      // ============================
      console.log('📝 Step 1: Preparing and submitting agent registration...');

      // Get test wallet dynamically from database
      console.log('🔍 Getting test wallet dynamically from database...');
      const testWallet = await getTestWalletFromDatabase(testNetwork, 'seller');
      const testScenario = getTestScenarios().basicAgent;

      const registrationData = generateTestRegistrationData(
        testNetwork,
        testWallet.vkey,
        testScenario,
      );

      console.log(`🎯 Registration Data:
        - Agent Name: ${registrationData.name}
        - Network: ${registrationData.network}
        - Wallet: ${testWallet.name}
        - Pricing: ${registrationData.AgentPricing.Pricing.map((p) => `${p.amount} ${p.unit}`).join(', ')}
      `);

      const registrationResponse = await (
        global as any
      ).testApiClient.registerAgent(registrationData);

      expect(registrationResponse).toBeDefined();
      expect(registrationResponse.id).toBeDefined();
      expect(registrationResponse.name).toBe(registrationData.name);
      expect(registrationResponse.state).toBe('RegistrationRequested');
      expect(registrationResponse.SmartContractWallet).toBeDefined();

      console.log(`✅ Registration submitted:
        - ID: ${registrationResponse.id}
        - State: ${registrationResponse.state}
        - Wallet: ${registrationResponse.SmartContractWallet.walletAddress}
      `);

      // Track for cleanup
      testCleanupData[0].registrationId = registrationResponse.id;
      testCleanupData[0].agentName = registrationResponse.name;
      testCleanupData[0].registered = true;

      // ============================
      // STEP 2: WAIT FOR REGISTRATION CONFIRMATION
      // ============================
      console.log('⏳ Step 2: Waiting for registration confirmation...');
      console.log(
        '💡 Blockchain confirmations can be unpredictable on Preprod network',
      );
      console.log('🕐 Started waiting at:', new Date().toLocaleString());

      const startTime = Date.now();
      let confirmedRegistration: any;
      let checkCount = 0;

      // Configure wait-for-expect for blockchain confirmation
      const registrationTimeout = (global as any).testConfig.timeout
        .registration;

      if (registrationTimeout === 0) {
        console.log(
          '⏳ INFINITE WAIT MODE: Will wait indefinitely until blockchain confirmation',
        );
        console.log('💡 Press Ctrl+C to stop if needed');
        waitForExpect.defaults.timeout = Number.MAX_SAFE_INTEGER;
      } else {
        console.log(
          `⏳ TIMEOUT MODE: Will wait ${Math.floor(registrationTimeout / 60000)} minutes for blockchain confirmation`,
        );
        waitForExpect.defaults.timeout = registrationTimeout;
      }

      waitForExpect.defaults.interval = 15000; // Check every 15 seconds

      await waitForExpect(async () => {
        checkCount++;
        const elapsedMinutes = Math.floor(
          (Date.now() - startTime) / (1000 * 60),
        );
        console.log(
          `🔄 Check #${checkCount} (${elapsedMinutes} min elapsed): Checking registration state for ${registrationResponse.id}...`,
        );

        const registration = await (
          global as any
        ).testApiClient.getRegistrationById(
          registrationResponse.id,
          testNetwork,
        );

        if (!registration) {
          throw new Error(`Registration ${registrationResponse.id} not found`);
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

      expect(confirmedRegistration).toBeDefined();
      expect(confirmedRegistration.state).toBe('RegistrationConfirmed');
      console.log(`✅ Registration confirmed successfully!`);

      // Track confirmation
      testCleanupData[0].confirmed = true;
      testCleanupData[0].agentId = confirmedRegistration.id;

      // ============================
      // STEP 3: WAIT FOR AGENT IDENTIFIER
      // ============================
      console.log('🎯 Step 3: Waiting for agent identifier...');

      // Configure shorter timeout for agent identifier
      const originalTimeout = waitForExpect.defaults.timeout;
      waitForExpect.defaults.timeout = 60000; // 1 minute
      waitForExpect.defaults.interval = 5000; // Check every 5 seconds

      await waitForExpect(
        async () => {
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
            confirmedRegistration = registration;
            expect(registration.agentIdentifier).toMatch(
              /^[a-f0-9]{56}[a-f0-9]+$/,
            );
            return;
          }

          console.log(
            `⚠️  Agent identifier not yet available for ${registrationResponse.id}`,
          );
          throw new Error(`Agent identifier not yet available`);
        },
        60000,
        5000,
      );

      // Restore original timeout
      waitForExpect.defaults.timeout = originalTimeout;

      expect(confirmedRegistration.agentIdentifier).toBeDefined();
      console.log(
        `🎯 Agent identifier created: ${confirmedRegistration.agentIdentifier!}`,
      );

      // Update cleanup data
      testCleanupData[0].agentIdentifier =
        confirmedRegistration.agentIdentifier;

      const registrationMinutes = Math.floor((Date.now() - startTime) / 60000);
      console.log(`✅ Registration completed after ${registrationMinutes}m`);

      // ============================
      // STEP 4: DEREGISTER AGENT
      // ============================
      console.log('🔄 Step 4: Starting agent deregistration...');

      // Query the active smart contract address dynamically from database
      console.log('🔍 Querying active smart contract address from database...');
      const activeSmartContractAddress =
        await getActiveSmartContractAddress(testNetwork);

      const deregisterResponse = await (
        global as any
      ).testApiClient.makeRequest('/api/v1/registry/deregister', {
        method: 'POST',
        body: JSON.stringify({
          network: testNetwork,
          agentIdentifier: confirmedRegistration.agentIdentifier,
          smartContractAddress: activeSmartContractAddress,
        }),
      });

      expect(deregisterResponse.id).toBeDefined();
      expect(deregisterResponse.state).toBe('DeregistrationRequested');

      console.log(`✅ Deregistration initiated successfully:
        - Agent ID: ${deregisterResponse.id}  
        - State: ${deregisterResponse.state}
        - Agent Identifier: ${confirmedRegistration.agentIdentifier}
      `);

      testCleanupData[0].deregistered = true;

      // ============================
      // FINAL SUCCESS
      // ============================
      const totalFlowMinutes = Math.floor((Date.now() - flowStartTime) / 60000);
      console.log(`
    🎊 AGENT REGISTER AND DEREGISTER FLOW SUCCESSFUL! (${totalFlowMinutes}m total)
    
    ✅ Step 1: Agent registration → RegistrationRequested
    ✅ Step 2: Registration confirmation → RegistrationConfirmed
    ✅ Step 3: Agent identifier → Generated
    ✅ Step 4: Deregistration initiated → DeregistrationRequested
    
    📊 Summary:
      - Agent Name: ${confirmedRegistration.name}
      - Agent ID: ${confirmedRegistration.id}
      - Agent Identifier: ${confirmedRegistration.agentIdentifier}
      
    🔄 Complete agent lifecycle accomplished:
       1. Registered new agent
       2. Waited for blockchain confirmation
       3. Retrieved agent identifier
       4. Successfully deregistered agent
       
    ✅ Agent complete lifecycle flow completed successfully!
    `);
    },
    // Dynamic timeout based on config: infinite if 0, otherwise timeout + buffer
    (() => {
      const { getTestEnvironment } = require('../fixtures/testData');
      const configTimeout = getTestEnvironment().timeout.registration;
      if (configTimeout === 0) {
        console.log('🔧 Jest timeout set to 24 hours (effectively infinite)');
        return 24 * 60 * 60 * 1000; // 24 hours - effectively infinite for Jest
      } else {
        const bufferTime = 10 * 60 * 1000; // 10 minute buffer
        console.log(
          `🔧 Jest timeout set to ${Math.floor((configTimeout + bufferTime) / 60000)} minutes`,
        );
        return configTimeout + bufferTime;
      }
    })(),
  );
});
