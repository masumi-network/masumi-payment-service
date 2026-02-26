import { MeshWallet, BlockfrostProvider, Network } from '@meshsdk/core';
import { logger } from '@/utils/logger';
import { HYDRA_CONFIG } from '@/utils/config';
import { submitTransactionToHydra, HydraHeadConfig } from '@/services/hydra';
import {
	ActiveHydraHeadInfo,
	TransactionRoutingContext,
	TransactionSubmitResult,
	TransactionLayer,
	RoutingDecision,
	UtxoQueryResult,
	TransactionRouterConfig,
} from './types';

/**
 * Default router configuration
 */
const DEFAULT_CONFIG: TransactionRouterConfig = {
	hydraEnabled: HYDRA_CONFIG.ENABLED,
	debugLogging: HYDRA_CONFIG.DEBUG_LOGGING,
};

/**
 * Function type for finding an active Hydra head between two HotWallets.
 *
 * Takes two wallet IDs (lexicographically ordered, no buyer/seller distinction)
 * and returns the resolved Hydra head info if an active (Open) head exists, or null.
 *
 * Typically backed by a DB query: HydraRelation → Heads (Open) → Participants.
 *
 * @example
 * ```typescript
 * router.setHydraHeadFinder(async (walletIdA, walletIdB, network) => {
 *   const [sortedA, sortedB] = walletIdA < walletIdB
 *     ? [walletIdA, walletIdB] : [walletIdB, walletIdA];
 *
 *   const relation = await prisma.hydraRelation.findUnique({
 *     where: { network_walletIdA_walletIdB:
 *       { network, walletIdA: sortedA, walletIdB: sortedB } },
 *     include: {
 *       Heads: {
 *         where: { status: 'Open' },
 *         include: { Participants: true },
 *         take: 1,
 *         orderBy: { createdAt: 'desc' },
 *       },
 *     },
 *   });
 *
 *   const openHead = relation?.Heads[0];
 *   if (!openHead) return null;
 *
 *   const ourParticipant = openHead.Participants.find(
 *     p => p.walletId === ourWalletId,
 *   );
 *   if (!ourParticipant) return null;
 *
 *   return {
 *     id: openHead.id,
 *     headId: openHead.headId!,
 *     nodeUrl: ourParticipant.nodeUrl,
 *     nodeHttpUrl: ourParticipant.nodeHttpUrl,
 *   };
 * });
 * ```
 */
export type FindActiveHydraHead = (
	walletIdA: string,
	walletIdB: string,
	network: Network,
) => ActiveHydraHeadInfo | null | Promise<ActiveHydraHeadInfo | null>;

/**
 * Transaction Router Service
 *
 * Routes transactions to Layer 1 (Cardano) or Layer 2 (Hydra) based on whether
 * an open Hydra head exists between the two HotWallets.
 *
 * Decision flow:
 * 1. If forceLayer is set → use it
 * 2. If HYDRA_ENABLED=false → L1
 * 3. If findActiveHydraHead returns a head → L2 (submit via @masumi-hydra)
 * 4. Otherwise → L1 (submit to Cardano via Blockfrost)
 *
 * L2 submission delegates to the hydra-manager which wraps @masumi-hydra HydraHead.
 *
 * @see https://hydra.family/head-protocol/
 */
export class TransactionRouter {
	private config: TransactionRouterConfig;
	private findActiveHydraHead: FindActiveHydraHead | null = null;

	/**
	 * Hydra head config builder.
	 * When set, provides the HydraHeadConfig needed to create a @masumi-hydra
	 * HydraHead instance for a given head ID. Typically reads from DB.
	 *
	 * TODO: Wire this up when integrating with the DB-backed HydraHead model.
	 */
	private hydraHeadConfigBuilder: ((hydraHeadId: string) => HydraHeadConfig | Promise<HydraHeadConfig>) | null = null;

	constructor(config: Partial<TransactionRouterConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Set a function to find an active Hydra head between two HotWallets.
	 * When not set, all transactions go to L1.
	 */
	setHydraHeadFinder(fn: FindActiveHydraHead | null): void {
		this.findActiveHydraHead = fn;
	}

	/**
	 * Set a function to build HydraHeadConfig from a head ID.
	 * Used to construct @masumi-hydra HydraHead instances on demand.
	 */
	setHydraHeadConfigBuilder(fn: ((hydraHeadId: string) => HydraHeadConfig | Promise<HydraHeadConfig>) | null): void {
		this.hydraHeadConfigBuilder = fn;
	}

	// ============================================================
	// TRANSACTION SUBMISSION
	// ============================================================

	/**
	 * Submit a signed transaction to L1 (Cardano) or L2 (Hydra).
	 *
	 * @param signedTx - CBOR-encoded signed transaction (hex string)
	 * @param context - Routing context (wallet IDs, payment source, etc.)
	 * @param wallet - MeshWallet for L1 submission
	 * @returns Result with txHash and layer used
	 */
	async submitTransaction(
		signedTx: string,
		context: TransactionRoutingContext,
		wallet: MeshWallet,
	): Promise<TransactionSubmitResult> {
		const routing = await this.resolveRouting(context);

		if (this.config.debugLogging) {
			logger.debug('[TransactionRouter] Routing decision', {
				transactionType: context.transactionType,
				layer: routing.layer,
				hydraHeadId: routing.hydraHead?.id,
				paymentSourceId: context.paymentSourceId,
				walletIdA: context.walletIdA,
				walletIdB: context.walletIdB,
			});
		}

		if (routing.layer === 'L2' && routing.hydraHead) {
			return this.submitToL2(signedTx, routing.hydraHead);
		}
		return this.submitToL1(signedTx, wallet);
	}

	/**
	 * Submit to Layer 1 (Cardano via Blockfrost / wallet.submitTx)
	 */
	private async submitToL1(signedTx: string, wallet: MeshWallet): Promise<TransactionSubmitResult> {
		logger.info('[TransactionRouter] Submitting to L1 (Cardano)');

		const txHash = await wallet.submitTx(signedTx);

		logger.info('[TransactionRouter] L1 submission successful', { txHash });

		return { txHash, layer: 'L1', timestamp: new Date() };
	}

	/**
	 * Submit to Layer 2 (Hydra via @masumi-hydra HydraHead.newTx)
	 */
	private async submitToL2(signedTx: string, hydraHead: ActiveHydraHeadInfo): Promise<TransactionSubmitResult> {
		logger.info('[TransactionRouter] Submitting to L2 (Hydra)', {
			hydraHeadId: hydraHead.id,
		});

		const config = await this.getHydraHeadConfig(hydraHead.id);

		const result = await submitTransactionToHydra(signedTx, hydraHead, config);

		if (!result.accepted) {
			throw new Error(`Hydra rejected transaction: ${result.reason ?? 'unknown'}`);
		}

		logger.info('[TransactionRouter] L2 submission successful', {
			txHash: result.txHash,
		});

		return { txHash: result.txHash, layer: 'L2', timestamp: new Date() };
	}

	// ============================================================
	// UTXO QUERIES
	// ============================================================

	/**
	 * Fetch UTXOs from L1 (Blockfrost) or L2 (Hydra snapshot).
	 */
	async fetchUtxos(
		address: string,
		context: TransactionRoutingContext,
		blockfrostProvider: BlockfrostProvider,
	): Promise<UtxoQueryResult> {
		const routing = await this.resolveRouting(context);

		if (routing.layer === 'L2' && routing.hydraHead) {
			return this.fetchUtxosFromL2(address, routing.hydraHead);
		}
		return this.fetchUtxosFromL1(address, blockfrostProvider);
	}

	private async fetchUtxosFromL1(address: string, blockfrostProvider: BlockfrostProvider): Promise<UtxoQueryResult> {
		logger.debug('[TransactionRouter] Fetching UTXOs from L1', { address });
		const utxos = await blockfrostProvider.fetchAddressUTxOs(address);
		return { utxos, layer: 'L1' };
	}

	private async fetchUtxosFromL2(address: string, hydraHead: ActiveHydraHeadInfo): Promise<UtxoQueryResult> {
		logger.debug('[TransactionRouter] Fetching UTXOs from L2', {
			address,
			hydraHeadId: hydraHead.id,
		});

		// TODO: Use fetchUtxosFromHydra() from hydra-manager when HydraProvider
		// integration is ready. For now, this is a placeholder.
		// const config = await this.getHydraHeadConfig(hydraHead.id);
		// const utxos = await fetchUtxosFromHydra(address, hydraHead, config);
		// return { utxos, layer: 'L2' };

		logger.warn('[TransactionRouter] L2 UTXO fetch not yet implemented; returning empty');
		return { utxos: [], layer: 'L2' };
	}

	/**
	 * Fetch UTXOs by transaction hash from L1 or L2.
	 */
	async fetchUtxosByTxHash(
		txHash: string,
		context: TransactionRoutingContext,
		blockfrostProvider: BlockfrostProvider,
	): Promise<UtxoQueryResult> {
		const routing = await this.resolveRouting(context);

		if (routing.layer === 'L2' && routing.hydraHead) {
			// TODO: Implement L2 UTXO-by-txHash query via HydraProvider
			logger.warn('[TransactionRouter] L2 UTXO-by-txHash not yet implemented; returning empty');
			return { utxos: [], layer: 'L2' };
		}
		const utxos = await blockfrostProvider.fetchUTxOs(txHash);
		return { utxos, layer: 'L1' };
	}

	// ============================================================
	// LAYER DETERMINATION
	// ============================================================

	/**
	 * Resolve the full routing decision (layer + Hydra head info if L2).
	 *
	 * Uses findActiveHydraHead to query the DB for an open HydraHead
	 * between the two HotWallets (via HydraRelation).
	 * Falls back to L1 if no finder is set or no active head is found.
	 */
	private async resolveRouting(context: TransactionRoutingContext): Promise<RoutingDecision> {
		if (context.forceLayer) {
			return { layer: context.forceLayer };
		}

		if (!this.config.hydraEnabled) {
			return { layer: 'L1' };
		}

		const walletA = context.walletIdA ?? '';
		const walletB = context.walletIdB ?? '';

		if (this.findActiveHydraHead && walletA && walletB) {
			const head = await Promise.resolve(this.findActiveHydraHead(walletA, walletB, context.network));
			if (head) {
				return { layer: 'L2', hydraHead: head };
			}
		}

		return { layer: 'L1' };
	}

	/**
	 * Determine which layer to use for this transaction.
	 * Public API that returns just the layer (L1 or L2).
	 */
	async determineLayer(context: TransactionRoutingContext): Promise<TransactionLayer> {
		const routing = await this.resolveRouting(context);
		return routing.layer;
	}

	/**
	 * Check if L2 (Hydra) is available for the given context.
	 */
	async isL2Available(context: TransactionRoutingContext): Promise<boolean> {
		return (await this.determineLayer(context)) === 'L2';
	}

	getStats(): { hydraEnabled: boolean; debugLogging: boolean } {
		return {
			hydraEnabled: this.config.hydraEnabled,
			debugLogging: this.config.debugLogging,
		};
	}

	// ============================================================
	// PRIVATE HELPERS
	// ============================================================

	/**
	 * Build HydraHeadConfig for a given head ID.
	 * Uses the configBuilder if set; otherwise returns a placeholder config.
	 */
	private async getHydraHeadConfig(hydraHeadId: string): Promise<HydraHeadConfig> {
		if (this.hydraHeadConfigBuilder) {
			return Promise.resolve(this.hydraHeadConfigBuilder(hydraHeadId));
		}

		// Fallback: minimal config using global defaults
		// TODO: This should be replaced by DB-backed config lookup
		return {
			nodes: [
				{
					name: 'default',
					url: HYDRA_CONFIG.DEFAULT_NODE_URL,
				},
			],
			blockfrostProjectId: '',
			contractsReferenceTxIds: '',
			mainNodeName: 'default',
		};
	}
}

// ============================================================
// SINGLETON INSTANCE
// ============================================================

let routerInstance: TransactionRouter | null = null;

/**
 * Get the singleton transaction router instance
 */
export function getTransactionRouter(): TransactionRouter {
	if (!routerInstance) {
		routerInstance = new TransactionRouter();
	}
	return routerInstance;
}

/**
 * Initialize transaction router with custom config
 */
export function initTransactionRouter(config: Partial<TransactionRouterConfig>): TransactionRouter {
	routerInstance = new TransactionRouter(config);
	return routerInstance;
}
