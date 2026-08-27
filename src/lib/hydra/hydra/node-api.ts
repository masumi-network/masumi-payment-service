/**
 * The public shape of a Hydra node client: the interface consumers program
 * against, the configuration one is built from, and the validation that
 * configuration must pass. Split from node.ts so the contract can be read
 * without the implementation.
 */

import { Protocol, UTxO } from '@meshsdk/core';
import { HydraHeadStatus } from '@/generated/prisma/client';
import { type VerifiedHydraFanoutReference } from './snapshot-verification';
import { HydraConfirmedTransaction, HydraTransaction } from './types';

/**
 * The head's Plutus cost models, as returned by hydra-node's
 * `/protocol-parameters` endpoint under `costModels`. Same `{ PlutusVN: number[] }`
 * shape Blockfrost returns under `cost_models_raw`, so the V2 cost-model sync
 * helper consumes either source identically. Used to patch the V2 mesh line's
 * bundled `DEFAULT_V*_COST_MODEL_LIST` arrays so an in-head (isHydra) Plutus tx
 * computes a script-data-hash the head's ledger accepts (otherwise:
 * `PPViewHashesDontMatch`). See docs/adr/0005.
 */
export type HydraRawCostModels = {
	PlutusV1?: number[];
	PlutusV2?: number[];
	PlutusV3?: number[];
};

/**
 * The head's last observed L1 chain time, from the API websocket's
 * `Tick`/`SyncedStatusReport` broadcasts. This is the clock the head's ledger
 * checks tx validity intervals against — it can lag wall-clock time by many
 * minutes (Blockfrost-backed chain followers drift), so L2 validity windows
 * must anchor to it, not to `Date.now()`. `receivedAtMs` lets consumers judge
 * staleness.
 */
export interface HydraHeadClock {
	chainTimeMs: number;
	chainSlot?: number;
	receivedAtMs: number;
}

export interface IHydraNode {
	connect(): void | Promise<void>;
	disconnect(): Promise<void>;
	init(): Promise<unknown>;
	commit(utxos: UTxO[], blueprintTx?: string): Promise<HydraTransaction>;
	cardanoTransaction(transaction: HydraTransaction): Promise<unknown>;
	decommit(transaction: HydraTransaction): Promise<unknown>;
	snapshotUTxO(): Promise<UTxO[]>;
	fetchProtocolParameters(): Promise<Protocol>;
	fetchRawCostModels(): Promise<HydraRawCostModels>;
	newTx(transaction: HydraTransaction): Promise<string>;
	isTxConfirmed(txHash: string): boolean;
	getConfirmedTransaction?(txHash: string): HydraConfirmedTransaction | null;
	getConfirmedTransactions?(): HydraConfirmedTransaction[];
	getConfirmedTransactionsForReconciliation?(): HydraConfirmedTransaction[];
	markConfirmedTransactionReconciled?(txHash: string): void;
	awaitTx(txHash: string, checkInterval?: number): Promise<boolean>;
	close(): Promise<unknown>;
	fanout(): Promise<unknown>;

	// Raw hydra-node HTTP responses are untyped JSON; callers pass the expected
	// shape via the type parameter (defaults to `unknown`, forcing narrowing).
	get<T = unknown>(url: string): Promise<T>;
	post<T = unknown>(url: string, payload: unknown): Promise<T>;

	get status(): HydraHeadStatus;
	get httpUrl(): string;
	get wsUrl(): string;
	get headClock(): HydraHeadClock | undefined;
	readonly hasPendingIncrement?: boolean;
	readonly pendingIncrementUtxoRefs?: ReadonlySet<string>;
	readonly hasVerifiedPinnedSessions?: boolean;
	readonly expectedHeadId?: string;
	pinExpectedHeadId?(headId: string): void;
	getVerifiedFanoutReference?(
		hydraReference: string,
		expectedSnapshotNumber: number,
	): VerifiedHydraFanoutReference | null;
	getVerifiedFanoutReferences?(expectedSnapshotNumber: number): VerifiedHydraFanoutReference[] | null;
}

export interface HydraNodeClientConfig {
	httpUrl: string;
	wsUrl?: string;
	expectedHeadId?: string;
	/** Durable high-water mark; replay entries at/before it are parsed but not retained. */
	reconciledHistoryCursor?: { snapshotSequence: number; snapshotTransactionIndex: number };
	/** Configured participant verification keys; on-chain events bind their signature order. */
	snapshotVerificationKeys?: string[];
	/** Verification key derived from this node's configured local signing key. */
	expectedNodeVerificationKey?: string;
	/**
	 * Explicit trust in this configured local endpoint's TxIn/reference map and
	 * `snapshot.confirmed` metadata. Hydra signatures commit only TxOut values.
	 */
	trustLocalNodeSnapshotMetadata?: boolean;
	/** Bearer token when the node sits behind a Hydra Host; omitted on loopback. */
	authToken?: string;
	/** Bounds websocket-open and pinned Greetings authentication. */
	connectTimeoutMs?: number;
	/** Bounds every Hydra HTTP request. */
	httpTimeoutMs?: number;
	/** Primarily useful for bounded integration tests; defaults to 30 seconds. */
	commandTimeoutMs?: number;
	/** Explicit fail-closed replay cap; unresolved causal evidence is never evicted. */
	maxUnreconciledTransactions?: number;
	/** Explicit aggregate budget for retained confirmation CBOR. */
	maxRetainedTransactionCborBytes?: number;
}

export interface ResolvedHydraNodeLimits {
	connectTimeoutMs: number;
	httpTimeoutMs: number;
	commandTimeoutMs: number;
	maxUnreconciledTransactions: number;
	maxRetainedTransactionCborBytes: number;
}

export function validateHydraNodeLimits(
	limits: ResolvedHydraNodeLimits,
	reconciledHistoryCursor?: { snapshotSequence: number; snapshotTransactionIndex: number },
): void {
	if (
		reconciledHistoryCursor &&
		(!Number.isSafeInteger(reconciledHistoryCursor.snapshotSequence) ||
			reconciledHistoryCursor.snapshotSequence < 0 ||
			!Number.isSafeInteger(reconciledHistoryCursor.snapshotTransactionIndex) ||
			reconciledHistoryCursor.snapshotTransactionIndex < 0)
	) {
		throw new Error('reconciledHistoryCursor must contain non-negative safe integers');
	}
	if (!Number.isSafeInteger(limits.connectTimeoutMs) || limits.connectTimeoutMs <= 0) {
		throw new Error('connectTimeoutMs must be a positive safe integer');
	}
	if (!Number.isSafeInteger(limits.httpTimeoutMs) || limits.httpTimeoutMs <= 0) {
		throw new Error('httpTimeoutMs must be a positive safe integer');
	}
	if (!Number.isSafeInteger(limits.commandTimeoutMs) || limits.commandTimeoutMs <= 0) {
		throw new Error('commandTimeoutMs must be a positive safe integer');
	}
	if (!Number.isSafeInteger(limits.maxUnreconciledTransactions) || limits.maxUnreconciledTransactions <= 0) {
		throw new Error('maxUnreconciledTransactions must be a positive safe integer');
	}
	if (!Number.isSafeInteger(limits.maxRetainedTransactionCborBytes) || limits.maxRetainedTransactionCborBytes <= 0) {
		throw new Error('maxRetainedTransactionCborBytes must be a positive safe integer');
	}
}
