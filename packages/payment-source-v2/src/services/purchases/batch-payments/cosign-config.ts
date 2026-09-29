import { CONFIG } from '@masumi/payment-core/config';
import type { CosignConfig } from '../../../smart-wallet/cosign-client';

export type NodeCosignConfig = CosignConfig & { nodeId: string; orgId: string };

/** The node's Exchain co-sign settings, or null when any of them is missing. */
export function cosignConfigOrNull(): NodeCosignConfig | null {
	const { EXCHAIN_COSIGN_URL, EXCHAIN_NODE_TOKEN, EXCHAIN_NODE_ID, EXCHAIN_ORG_ID } = CONFIG;
	if (EXCHAIN_COSIGN_URL == null || EXCHAIN_NODE_TOKEN == null || EXCHAIN_NODE_ID == null || EXCHAIN_ORG_ID == null) {
		return null;
	}
	return { url: EXCHAIN_COSIGN_URL, apiKey: EXCHAIN_NODE_TOKEN, nodeId: EXCHAIN_NODE_ID, orgId: EXCHAIN_ORG_ID };
}
