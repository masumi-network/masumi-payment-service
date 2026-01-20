import { Network } from '@/generated/prisma/enums';

/**
 * Test wallet configurations for e2e tests
 *
 * ⚠️  IMPORTANT: These are example wallet keys for testing purposes only!
 * Replace with actual test wallet verification keys that exist in your test environment.
 */

export interface TestWallet {
  name: string;
  vkey: string;
  address?: string;
  description: string;
}

export interface TestWalletConfig {
  [Network.Mainnet]: {
    sellers: TestWallet[];
    buyers: TestWallet[];
  };
  [Network.Preprod]: {
    sellers: TestWallet[];
    buyers: TestWallet[];
  };
}

export const TEST_WALLETS: TestWalletConfig = {
  [Network.Mainnet]: {
    sellers: [
      {
        name: 'Test Seller 1 (Mainnet)',
        vkey: 'REPLACE_WITH_ACTUAL_MAINNET_SELLER_VKEY_1',
        description: 'Primary test seller wallet for mainnet e2e tests',
      },
      {
        name: 'Test Seller 2 (Mainnet)',
        vkey: 'REPLACE_WITH_ACTUAL_MAINNET_SELLER_VKEY_2',
        description: 'Secondary test seller wallet for mainnet e2e tests',
      },
    ],
    buyers: [
      {
        name: 'Test Buyer 1 (Mainnet)',
        vkey: 'REPLACE_WITH_ACTUAL_MAINNET_BUYER_VKEY_1',
        description: 'Primary test buyer wallet for mainnet e2e tests',
      },
    ],
  },
  [Network.Preprod]: {
    sellers: [
      {
        name: 'Test Seller 1 (Preprod)',
        vkey: '1f9d349ec66fb28920e0f093edce415792ce0281a8825015ce3e16bf',
        address:
          'addr_test1qq0e6dy7cehm9zfqurcf8mwwg9te9nszsx5gy5q4eclpd0czhmdlpagxe5n8ppnrf6424tt8gwweumrtg2q7234x2p2qzjenfx',
        description:
          'Primary test seller wallet for preprod e2e tests (updated wallet)',
      },
    ],
    buyers: [
      {
        name: 'Test Buyer 1 (Preprod)',
        vkey: '2d1386da18f97d7a5ed42998c2528f319d58678a8b640505e6ee13da',
        address:
          'addr_test1qqk38pk6rruh67j76s5e3sjj3uce6kr8329kgpg9umhp8k50t3yt4hw3u4fg4f4xtfh630g5fvg6fkr4p2svzyug4nsq40tdna',
        description:
          'Primary test buyer wallet for preprod e2e tests (updated wallet)',
      },
    ],
  },
};

/**
 * Validate that test wallets are properly configured
 */
export function validateTestWallets(network: Network): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const wallets = TEST_WALLETS[network];

  // Check sellers
  if (wallets.sellers.length === 0) {
    errors.push(`No seller wallets configured for ${network}`);
  } else {
    wallets.sellers.forEach((wallet, index) => {
      if (wallet.vkey.startsWith('REPLACE_WITH_ACTUAL')) {
        errors.push(`Seller wallet ${index} for ${network} needs actual vkey`);
      }
    });
  }

  // Check buyers
  if (wallets.buyers.length === 0) {
    errors.push(`No buyer wallets configured for ${network}`);
  } else {
    wallets.buyers.forEach((wallet, index) => {
      if (wallet.vkey.startsWith('REPLACE_WITH_ACTUAL')) {
        errors.push(`Buyer wallet ${index} for ${network} needs actual vkey`);
      }
    });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export default {
  TEST_WALLETS,
  validateTestWallets,
};
