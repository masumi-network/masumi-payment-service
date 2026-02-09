import { logger } from '@/utils/logger';
import { ActiveHydraHeadInfo, HydraHeadConfig, HydraHeadStatus, HydraSubmitResult } from './types';

// TODO: Import from @masumi-hydra when integrating
// import { HydraHead } from '@masumi-hydra/head';
// import { HydraManagerConfig } from '@masumi-hydra/configs';

/**
 * Placeholder type for the @masumi-hydra HydraHead class.
 * Replace with actual import when the package is integrated.
 */
interface HydraHeadInstance {
	status: HydraHeadStatus | null;
	mainNodeConnected: boolean;
	mainNodeName: string;
	participants: string[];
	connectMainNode(): Promise<void>;
	newTx(transaction: { type: string; cborHex: string }, participant?: string | null): Promise<string>;
	awaitTx(txHash: string, participant?: string | null): Promise<boolean>;
	init(): Promise<void>;
	close(): Promise<void>;
	fanout(): Promise<void>;
	// TODO: Add more methods as needed (commit, cardanoTransaction, etc.)
}

// ============================================================
// HYDRA HEAD INSTANCE CACHE
// ============================================================

/**
 * Cache of HydraHead instances, keyed by the DB HydraHead record ID.
 * Each entry wraps a @masumi-hydra HydraHead instance.
 */
const hydraHeadInstances: Map<string, HydraHeadInstance> = new Map();

/**
 * Create a HydraHead instance from config.
 *
 * TODO: Replace with actual @masumi-hydra HydraHead construction.
 * The real implementation would be:
 *
 * ```typescript
 * import { HydraHead } from '@masumi-hydra/head';
 * const head = new HydraHead(config);
 * head.initializeNodes(config);
 * head.setupStatusChangeHandler();
 * await head.connectMainNode();
 * return head;
 * ```
 */
async function createHydraHeadInstance(_config: HydraHeadConfig): Promise<HydraHeadInstance> {
	// TODO: Replace with real @masumi-hydra HydraHead instantiation
	logger.warn('[HydraManager] Using placeholder HydraHead instance');

	const instance: HydraHeadInstance = {
		status: null,
		mainNodeConnected: false,
		mainNodeName: _config.mainNodeName,
		participants: _config.nodes.map((n) => n.name),
		connectMainNode: async () => {
			// TODO: Connect to the main Hydra node via WebSocket
			logger.info('[HydraManager] TODO: connectMainNode');
			instance.mainNodeConnected = true;
		},
		newTx: async (_transaction, _participant) => {
			// TODO: Submit transaction to Hydra head via HydraHead.newTx()
			logger.info('[HydraManager] TODO: newTx');
			return 'placeholder-tx-hash';
		},
		awaitTx: async (_txHash, _participant) => {
			// TODO: Wait for tx confirmation via HydraHead.awaitTx()
			logger.info('[HydraManager] TODO: awaitTx');
			return true;
		},
		init: async () => {
			// TODO: Initialize the Hydra head via HydraHead.init()
			logger.info('[HydraManager] TODO: init');
			instance.status = HydraHeadStatus.INITIALIZING;
		},
		close: async () => {
			// TODO: Close the Hydra head via HydraHead.close()
			logger.info('[HydraManager] TODO: close');
			instance.status = HydraHeadStatus.CLOSED;
		},
		fanout: async () => {
			// TODO: Fanout the Hydra head via HydraHead.fanout()
			logger.info('[HydraManager] TODO: fanout');
			instance.status = HydraHeadStatus.FINAL;
		},
	};

	return instance;
}

// ============================================================
// PUBLIC API
// ============================================================

/**
 * Get or create a HydraHead instance for the given DB head ID.
 *
 * When a head is resolved via FindActiveHydraHead (DB lookup), the router
 * calls this to get a live HydraHead instance to submit transactions through.
 *
 * @param hydraHeadId - The HydraHead DB record ID
 * @param config - Head configuration (nodes, blockfrost, etc.)
 * @returns The HydraHead instance (connected to main node)
 */
export async function getOrCreateHydraHead(hydraHeadId: string, config: HydraHeadConfig): Promise<HydraHeadInstance> {
	let instance = hydraHeadInstances.get(hydraHeadId);

	if (!instance) {
		logger.info('[HydraManager] Creating new HydraHead instance', { hydraHeadId });
		instance = await createHydraHeadInstance(config);
		hydraHeadInstances.set(hydraHeadId, instance);
		await instance.connectMainNode();
	}

	return instance;
}

/**
 * Get an existing HydraHead instance, or null if not created.
 */
export function getHydraHead(hydraHeadId: string): HydraHeadInstance | null {
	return hydraHeadInstances.get(hydraHeadId) ?? null;
}

/**
 * Remove a HydraHead instance from the cache.
 */
export function removeHydraHead(hydraHeadId: string): void {
	hydraHeadInstances.delete(hydraHeadId);
	logger.info('[HydraManager] Removed HydraHead instance', { hydraHeadId });
}

/**
 * Get all active HydraHead instances.
 */
export function getAllHydraHeads(): Map<string, HydraHeadInstance> {
	return hydraHeadInstances;
}

/**
 * Submit a signed transaction to a Hydra head (L2).
 *
 * Resolves the HydraHead instance and calls newTx + awaitTx.
 * This is the main entry point for the transaction router when routing to L2.
 *
 * @param signedTx - CBOR-encoded signed transaction (hex string)
 * @param hydraHead - Resolved head info from the DB lookup
 * @param config - Head configuration (for creating instance if not cached)
 * @returns Submit result with txHash and acceptance status
 */
export async function submitTransactionToHydra(
	signedTx: string,
	hydraHead: ActiveHydraHeadInfo,
	config: HydraHeadConfig,
): Promise<HydraSubmitResult> {
	const instance = await getOrCreateHydraHead(hydraHead.id, config);

	if (!instance.mainNodeConnected) {
		return { txHash: '', accepted: false, reason: 'Hydra main node not connected' };
	}

	if (instance.status !== HydraHeadStatus.OPEN) {
		return {
			txHash: '',
			accepted: false,
			reason: `Hydra head is not open (status: ${instance.status ?? 'null'})`,
		};
	}

	try {
		// TODO: The @masumi-hydra HydraHead.newTx() expects a HydraTransaction
		// which has a type and cborHex. For now, we pass the signed tx as cborHex.
		const txHash = await instance.newTx(
			{ type: 'Tx ConwayEra', cborHex: signedTx },
			null, // use main node
		);

		// TODO: Optionally await confirmation
		// const confirmed = await instance.awaitTx(txHash);

		return { txHash, accepted: true };
	} catch (err) {
		const reason = err instanceof Error ? err.message : 'Unknown error';
		logger.error('[HydraManager] Transaction submission failed', { err, hydraHeadId: hydraHead.id });
		return { txHash: '', accepted: false, reason };
	}
}

/**
 * Fetch UTXOs from a Hydra head (L2) for a given address.
 *
 * TODO: Uses the HydraProvider from @masumi-hydra to query the L2 snapshot.
 *
 * @param address - Cardano address to query
 * @param hydraHead - Resolved head info from the DB lookup
 * @param _config - Head configuration
 * @returns Array of UTXOs from the Hydra head snapshot
 */
export async function fetchUtxosFromHydra(
	address: string,
	hydraHead: ActiveHydraHeadInfo,
	_config: HydraHeadConfig,
): Promise<unknown[]> {
	// TODO: Use the HydraProvider from @masumi-hydra to fetch UTXOs
	// const instance = await getOrCreateHydraHead(hydraHead.id, config);
	// const provider = instance.getL2HydraProvider();
	// return provider.getUtxos(address);
	logger.info('[HydraManager] TODO: fetchUtxosFromHydra', { address, hydraHeadId: hydraHead.id });
	return [];
}

/**
 * Check if a Hydra head instance is connected and open.
 */
export function isHydraHeadReady(hydraHeadId: string): boolean {
	const instance = hydraHeadInstances.get(hydraHeadId);
	if (!instance) return false;
	return instance.mainNodeConnected && instance.status === HydraHeadStatus.OPEN;
}
