// Cache BlockFrostAPI instances to prevent memory leaks from repeated instantiation

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { $Enums } from '@prisma/client';
import { logger } from '@/utils/logger';

// Key format: `${network}-${apiKey}`
const blockfrostInstanceCache = new Map<string, BlockFrostAPI>();

export function getBlockfrostInstance(
  network: $Enums.Network,
  apiKey: string,
): BlockFrostAPI {
  const cacheKey = `${network}-${apiKey}`;
  let instance = blockfrostInstanceCache.get(cacheKey);

  if (!instance) {
    instance = new BlockFrostAPI({
      projectId: apiKey,
      network: network === $Enums.Network.Mainnet ? 'mainnet' : 'preprod',
    });
    blockfrostInstanceCache.set(cacheKey, instance);
    logger.info('Created new BlockFrostAPI instance', { network, cacheKey });
  }

  return instance;
}
