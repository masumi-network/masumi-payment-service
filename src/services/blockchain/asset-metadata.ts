import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { z } from 'zod';
import { metadataSchema } from '@/routes/api/registry/wallet';

export type FetchAssetInWalletAndMetadataSuccess = {
  data: {
    assetInWallet: Array<{ address: string }>;
    parsedMetadata: z.infer<typeof metadataSchema>;
  };
};

export type FetchAssetInWalletAndMetadataError = {
  error: { code: number; description: string };
};

export type FetchAssetInWalletAndMetadataResult =
  | FetchAssetInWalletAndMetadataSuccess
  | FetchAssetInWalletAndMetadataError;

export const fetchAssetInWalletAndMetadata = async (
  provider: BlockFrostAPI,
  agentIdentifier: string,
): Promise<FetchAssetInWalletAndMetadataResult> => {
  let assetInWallet: Array<{ address: string }> = [];
  try {
    assetInWallet = await provider.assetsAddresses(agentIdentifier, {
      order: 'desc',
      count: 1,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('404')) {
      return {
        error: { code: 404, description: 'Agent identifier not found' },
      };
    }
    return {
      error: { code: 500, description: 'Error fetching asset in wallet' },
    };
  }

  if (assetInWallet.length == 0) {
    return {
      error: { code: 404, description: 'Agent identifier not found' },
    };
  }

  const assetMetadata = await provider.assetsById(agentIdentifier);
  if (!assetMetadata || !assetMetadata.onchain_metadata) {
    return {
      error: { code: 404, description: 'Agent registry metadata not found' },
    };
  }
  const parsed = metadataSchema.safeParse(assetMetadata.onchain_metadata);
  if (!parsed.success) {
    return {
      error: { code: 404, description: 'Agent registry metadata not valid' },
    };
  }

  return { data: { assetInWallet, parsedMetadata: parsed.data } };
};
