/**
 * Agent Register and Deregister Flow E2E Test
 *
 * This test demonstrates the complete agent lifecycle:
 * 1. Register Agent → 2. Deregister Agent
 *
 * Key Features:
 * - Complete agent lifecycle testing
 * - Self-contained (creates own agent)
 * - Uses helper functions for clean orchestration
 */

import { Network } from '@prisma/client';
import { validateTestWallets } from '../fixtures/testWallets';
import { registerAndConfirmAgent, deregisterAgent } from '../helperFunctions';

const testNetwork = (process.env.TEST_NETWORK as Network) || Network.Preprod;

describe(`Agent Register and Deregister Flow E2E Tests (${testNetwork})`, () => {
  const testCleanupData: Array<{
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
      // STEP 1: REGISTER AND CONFIRM AGENT (Using Helper Function)
      // ============================
      console.log('📝 Step 1: Agent registration and confirmation...');
      const agent = await registerAndConfirmAgent(testNetwork);

      console.log(`✅ Agent registered and confirmed:
        - Agent Name: ${agent.name}
        - Agent ID: ${agent.id}
        - Agent Identifier: ${agent.agentIdentifier}
      `);

      // Track for cleanup
      testCleanupData[0].agentId = agent.id;
      testCleanupData[0].agentIdentifier = agent.agentIdentifier;
      testCleanupData[0].agentName = agent.name;
      testCleanupData[0].registered = true;
      testCleanupData[0].confirmed = true;

      // ============================
      // STEP 2: DEREGISTER AGENT (Using Helper Function)
      // ============================
      console.log('🔄 Step 2: Agent deregistration...');
      const deregisterResponse = await deregisterAgent(
        testNetwork,
        agent.agentIdentifier,
      );

      console.log(`✅ Deregistration completed:
        - Agent ID: ${deregisterResponse.id}  
        - State: ${deregisterResponse.state}
        - Agent Identifier: ${agent.agentIdentifier}
      `);

      // Track deregistration
      testCleanupData[0].deregistered = true;

      // ============================
      // FINAL SUCCESS
      // ============================
      const totalFlowMinutes = Math.floor((Date.now() - flowStartTime) / 60000);
      console.log(`

    🎊 AGENT REGISTER AND DEREGISTER FLOW SUCCESSFUL! (${totalFlowMinutes}m total)
    
    ✅ Step 1: Agent registration → RegistrationRequested → RegistrationConfirmed → Agent Identifier Generated
    ✅ Step 2: Deregistration initiated → DeregistrationRequested
    
    📊 Summary:
      - Agent Name: ${agent.name}
      - Agent ID: ${agent.id}
      - Agent Identifier: ${agent.agentIdentifier}
      
    🔄 Complete agent lifecycle accomplished using helper functions:
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
