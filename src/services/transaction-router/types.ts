import { UTxO, Network } from '@meshsdk/core';
import { ActiveHydraHeadInfo } from '@/services/hydra/types';

export type { ActiveHydraHeadInfo };

/**
 * Layer type for transaction submission
 */
export type TransactionLayer = 'L1' | 'L2';

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

	// Participant identifiers for Hydra head lookup (symmetric; no buyer/seller distinction).
	// Can be agent IDs or external buyer IDs (marketplace frontend users).
	participantIdA?: string;
	participantIdB?: string;

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
