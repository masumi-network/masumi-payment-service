import { UTxO, Network } from '@meshsdk/core';

/**
 * Layer type for transaction submission
 */
export type TransactionLayer = 'L1' | 'L2';

/**
 * Resolved Hydra head info returned by FindActiveHydraHead.
 * Contains the connection details needed to route to L2.
 */
export interface ActiveHydraHeadInfo {
	/** HydraHead DB record ID (used as the Hydra manager cache key) */
	id: string;
	/** WebSocket URL for our participant's Hydra node */
	nodeUrl: string;
	/** HTTP URL for our participant's Hydra node */
	nodeHttpUrl: string;
}

/**
 * Transaction type for routing decisions
 */
export type TransactionType =
	| 'LockFunds' // Initial payment lock (hire)
	| 'SubmitResult' // Seller submits result hash
	| 'RequestRefund' // Buyer requests refund
	| 'CancelRefund' // Cancel refund request
	| 'AuthorizeRefund' // Authorize refund (admin/seller)
	| 'CollectPayment' // Collect completed payment
	| 'CollectRefund'; // Collect authorized refund

/**
 * Context for transaction routing decisions
 */
export interface TransactionRoutingContext {
	// Payment system identifiers
	paymentSourceId: string;
	purchaseRequestId?: string;
	paymentRequestId?: string;

	// Agent identifiers for Hydra head lookup (symmetric; no buyer/seller distinction)
	// In a payment transaction these are the buyer and seller, but for Hydra routing
	// they are treated as symmetric participants.
	agentIdA?: string;
	agentIdB?: string;

	// Transaction type
	transactionType: TransactionType;

	// Network
	network: Network;

	// Force specific layer (for testing or override)
	forceLayer?: TransactionLayer;
}

/**
 * Internal routing decision with resolved Hydra head info
 */
export interface RoutingDecision {
	layer: TransactionLayer;
	/** Resolved Hydra head info when layer is L2 */
	hydraHead?: ActiveHydraHeadInfo;
}

/**
 * Result of transaction submission
 */
export interface TransactionSubmitResult {
	txHash: string;
	layer: TransactionLayer;
	snapshotNumber?: number; // Only for L2
	timestamp: Date;
}

/**
 * Result of UTXO query
 */
export interface UtxoQueryResult {
	utxos: UTxO[];
	layer: TransactionLayer;
	snapshotNumber?: number; // Only for L2
}

/**
 * Configuration for transaction router
 */
export interface TransactionRouterConfig {
	/** Enable/disable Hydra L2 routing globally */
	hydraEnabled: boolean;

	/** Log routing decisions (L1 vs L2) */
	debugLogging: boolean;
}
