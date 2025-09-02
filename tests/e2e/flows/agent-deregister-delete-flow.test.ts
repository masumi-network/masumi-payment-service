/**
 * Agent Deregister Flow E2E Test
 *
 * This test demonstrates the agent deregistration process:
 * 1. GET /registry - Find existing RegistrationConfirmed agent
 * 2. POST /registry/deregister - Call deregister endpoint
 *
 * Key Features:
 * - Uses existing confirmed agents
 * - Simple deregistration call
 * - No blockchain waiting required
 */

import { Network } from '@prisma/client';
import { validateTestWallets } from '../fixtures/testWallets';
import waitForExpect from 'wait-for-expect';

const testNetwork = (process.env.TEST_NETWORK as Network) || Network.Preprod;

describe(`Agent Deregister Flow E2E Tests (${testNetwork})`, () => {
  const testCleanupData: Array<{
    agentId?: string;
    agentIdentifier?: string;
    agentName?: string;
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
      `✅ Agent Deregister Flow environment validated for ${testNetwork}`,
    );
  });

  afterAll(async () => {
    if (testCleanupData.length > 0) {
      console.log('🧹 Agent Deregister Flow cleanup data:');
      testCleanupData.forEach((item) => {
        console.log(`   Agent: ${item.agentName} (${item.agentId})`);
        console.log(`   Identifier: ${item.agentIdentifier}`);
        console.log(`   Deregistered: ${item.deregistered}`);
      });
    }
  });

  test(
    'Complete agent deregister flow: list agents → deregister',
    async () => {
      console.log('🚀 Starting Agent Deregister Flow...');
      const flowStartTime = Date.now();

      // ============================
      // STEP 1: GET EXISTING CONFIRMED AGENT
      // ============================
      console.log(
        '📝 Step 1: Getting existing RegistrationConfirmed agents...',
      );

      const registryResponse = await (global as any).testApiClient.makeRequest(
        `/api/v1/registry?network=${testNetwork}`,
        {
          method: 'GET',
        },
      );

      expect(registryResponse).toBeDefined();
      expect(registryResponse.Assets).toBeDefined();
      expect(Array.isArray(registryResponse.Assets)).toBe(true);

      console.log(
        `📊 Found ${registryResponse.Assets.length} agents in registry`,
      );

      // Find first agent with RegistrationConfirmed state
      const confirmedAgent = registryResponse.Assets.find(
        (agent: any) => agent.state === 'RegistrationConfirmed',
      );

      if (!confirmedAgent) {
        throw new Error(
          'No RegistrationConfirmed agents found in registry. Please ensure at least one agent is registered and confirmed before running this test.',
        );
      }

      expect(confirmedAgent.agentIdentifier).toBeDefined();
      expect(confirmedAgent.id).toBeDefined();
      expect(confirmedAgent.state).toBe('RegistrationConfirmed');

      console.log(`✅ Found confirmed agent to deregister:
        - Name: ${confirmedAgent.name}
        - ID: ${confirmedAgent.id}
        - Agent Identifier: ${confirmedAgent.agentIdentifier}
        - State: ${confirmedAgent.state}
        - Wallet VKey: ${confirmedAgent.SmartContractWallet.walletVkey}
        - Wallet Address: ${confirmedAgent.SmartContractWallet.walletAddress}
      `);

      // Track for cleanup
      testCleanupData[0].agentId = confirmedAgent.id;
      testCleanupData[0].agentIdentifier = confirmedAgent.agentIdentifier;
      testCleanupData[0].agentName = confirmedAgent.name;

      // ============================
      // STEP 2: DEREGISTER AGENT
      // ============================
      console.log('🔄 Step 2: Starting agent deregistration...');

      // Use the correct active smart contract address from database
      // The DEFAULTS address was deleted, so we use the currently active PaymentSource address
      const correctSmartContractAddress =
        'addr_test1wr9wzw5e59lsf7uuzsdfyvh2n0vgkwst0zmpjnjjxkwgu6q3wlx5v';

      const deregisterResponse = await (
        global as any
      ).testApiClient.makeRequest('/api/v1/registry/deregister', {
        method: 'POST',
        body: JSON.stringify({
          network: testNetwork,
          agentIdentifier: confirmedAgent.agentIdentifier,
          smartContractAddress: correctSmartContractAddress,
        }),
      });

      expect(deregisterResponse.id).toBeDefined();
      expect(deregisterResponse.state).toBe('DeregistrationRequested');

      console.log(`✅ Deregistration initiated successfully:
        - Agent ID: ${deregisterResponse.id}  
        - State: ${deregisterResponse.state}
        - Agent Identifier: ${confirmedAgent.agentIdentifier}
      `);

      testCleanupData[0].deregistered = true;

      // ============================
      // FINAL SUCCESS
      // ============================
      const totalFlowMinutes = Math.floor((Date.now() - flowStartTime) / 60000);
      console.log(`
    🎊 AGENT DEREGISTER FLOW SUCCESSFUL! (${totalFlowMinutes}m total)
    
    ✅ Step 1: Found confirmed agent in registry
    ✅ Step 2: Deregistration initiated → DeregistrationRequested
    
    📊 Summary:
      - Agent Name: ${confirmedAgent.name}
      - Agent ID: ${confirmedAgent.id}
      - Agent Identifier: ${confirmedAgent.agentIdentifier}
      
    🔄 Agent deregistration accomplished:
       1. Found existing confirmed agent
       2. Successfully called deregister endpoint
       
    ✅ Agent deregister flow completed successfully!
    `);
    },
    24 * 60 * 60 * 1000, // 24 hours timeout
  );
});
