import type { IFetcher, ISubmitter } from '@meshsdk/core';

import type { HydraProvider } from '@/lib/hydra';
import type { HydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';

export interface HydraContext {
	hydraProvider: HydraProvider & IFetcher & ISubmitter;
	hydraHeadId: string;
}

/**
 * Creates L2 provider context from the connection manager.
 * Returns a HydraContext with the HydraProvider for L2 tx building and submission.
 */
export function createL2Providers(hydraHeadId: string, connectionManager: HydraConnectionManager): HydraContext {
	const provider = connectionManager.getProvider(hydraHeadId);
	if (!provider) {
		throw new Error(`No active HydraProvider for head ${hydraHeadId}. ` + 'Is the head connected and open?');
	}

	return {
		hydraProvider: provider,
		hydraHeadId,
	};
}
