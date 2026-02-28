export interface AdminWallet {
  walletAddress: string;
  note?: string;
}

export type Network = 'Preprod' | 'Mainnet';

export const DEFAULT_ADMIN_WALLETS: Record<Network, [AdminWallet, AdminWallet, AdminWallet]> = {
  Preprod: [
    {
      walletAddress:
        'addr_test1qr7pdg0u7vy6a5p7cx9my9m0t63f4n48pwmez30t4laguawge7xugp6m5qgr6nnp6wazurtagjva8l9fc3a5a4scx0rq2ymhl3',
      note: 'Default Preprod Admin Wallet 1',
    },
    {
      walletAddress:
        'addr_test1qplhs9snd92fmr3tzw87uujvn7nqd4ss0fn8yz7mf3y2mf3a3806uqngr7hvksqvtkmetcjcluu6xeguagwyaxevdhmsuycl5a',
      note: 'Default Preprod Admin Wallet 2',
    },
    {
      walletAddress:
        'addr_test1qzy7a702snswullyjg06j04jsulldc6yw0m4r4w49jm44f30pgqg0ez34lrdj7dy7ndp2lgv8e35e6jzazun8gekdlsq99mm6w',
      note: 'Default Preprod Admin Wallet 3',
    },
  ],
  Mainnet: [
    {
      walletAddress:
        'addr1q87pdg0u7vy6a5p7cx9my9m0t63f4n48pwmez30t4laguawge7xugp6m5qgr6nnp6wazurtagjva8l9fc3a5a4scx0rqfjxhnw',
      note: 'Default Mainnet Admin Wallet 1',
    },
    {
      walletAddress:
        'addr1q9lhs9snd92fmr3tzw87uujvn7nqd4ss0fn8yz7mf3y2mf3a3806uqngr7hvksqvtkmetcjcluu6xeguagwyaxevdhmslj9lcz',
      note: 'Default Mainnet Admin Wallet 2',
    },
    {
      walletAddress:
        'addr1qxy7a702snswullyjg06j04jsulldc6yw0m4r4w49jm44f30pgqg0ez34lrdj7dy7ndp2lgv8e35e6jzazun8gekdlsqxnxmk3',
      note: 'Default Mainnet Admin Wallet 3',
    },
  ],
};

// Also export fee wallet addresses and fee permille for each network
export const DEFAULT_FEE_CONFIG = {
  Preprod: {
    feeWalletAddress:
      'addr_test1qqfuahzn3rpnlah2ctcdjxdfl4230ygdar00qxc32guetexyg7nun6hggw9g2gpnayzf22sksr0aqdgkdcvqpc2stwtqt4u496',
    feePermille: 50, // 5% fee
  },
  Mainnet: {
    feeWalletAddress:
      'addr1qyfuahzn3rpnlah2ctcdjxdfl4230ygdar00qxc32guetexyg7nun6hggw9g2gpnayzf22sksr0aqdgkdcvqpc2stwtqgrp4f9',
    feePermille: 50, // 5% fee
  },
};

// Token configurations
export const USDM_CONFIG = {
  // Mainnet USDM
  policyId: 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad',
  assetName: '0014df105553444d', // hex encoded "USDM"
  assetFingerprint: 'asset12ffdj8kk2w485sr7a5ekmjjdyecz8ps2cm5zed',
  // Full asset ID (policy ID + asset name) used for transactions
  fullAssetId: 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d',
};

// Preprod USDM (tUSDM) token configuration
export const PREPROD_USDM_CONFIG = {
  policyId: '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde',
  assetName: '0014df10745553444d', // hex encoded "tUSDM"
  fullAssetId: '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d',
};

// TESTUSDM (tUSDM) token configuration - keeping for backward compatibility
export const TESTUSDM_CONFIG = {
  unit: '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d',
  symbol: 'tUSDM',
  name: 'TestUSDM',
};

// NMKR token configuration
export const NMKR_CONFIG = {
  policyId: '5dac8536653edc12f6f5e1045d8164b9f59998d3bdc300fc92843489',
  assetName: '4e4d4b52', // hex encoded "NMKR"
  fullAssetId: '5dac8536653edc12f6f5e1045d8164b9f59998d3bdc300fc928434894e4d4b52',
};

// Helper function to get the correct USDM config based on network
export const getUsdmConfig = (network: string) => {
  return network?.toLowerCase() === 'preprod' ? PREPROD_USDM_CONFIG : USDM_CONFIG;
};
