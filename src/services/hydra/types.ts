/**
 * Hydra Head status enum.
 * Matches the @masumi-hydra package HydraHeadStatus.
 */
export enum HydraHeadStatus {
	IDLE = 'Idle',
	INITIALIZING = 'Initializing',
	OPEN = 'Open',
	CLOSED = 'Closed',
	FANOUT_POSSIBLE = 'FanoutPossible',
	FINAL = 'Final',
}

/**
 * Resolved info for an active Hydra head.
 * Returned by the channel lookup, used by the transaction router
 * to submit transactions via the Hydra manager.
 */
export interface ActiveHydraHeadInfo {
	/** HydraHead DB record ID (used as the cache key for HydraHead instances) */
	id: string;
	/** WebSocket URL for our participant's Hydra node */
	nodeUrl: string;
	/** HTTP URL for our participant's Hydra node */
	nodeHttpUrl: string;
}

/**
 * Result of submitting a transaction to L2 (Hydra)
 */
export interface HydraSubmitResult {
	txHash: string;
	accepted: boolean;
	reason?: string;
}

/**
 * Node configuration for a single participant in a Hydra head.
 * Mirrors the NodeConfig from @masumi-hydra/configs.
 */
export interface HydraNodeConfig {
	name: string;
	url: string;
	fundWalletSK?: { type: string; description: string; cborHex: string } | null;
	nodeWalletSK?: { type: string; description: string; cborHex: string } | null;
	nodeWalletVK?: { type: string; description: string; cborHex: string } | null;
	hydraSK?: { type: string; description: string; cborHex: string } | null;
	hydraVK?: { type: string; description: string; cborHex: string } | null;
}

/**
 * Configuration for a managed Hydra head instance.
 * Mirrors HydraManagerConfig from @masumi-hydra/configs.
 */
export interface HydraHeadConfig {
	nodes: HydraNodeConfig[];
	blockfrostProjectId: string;
	contractsReferenceTxIds: string;
	mainNodeName: string;
}
