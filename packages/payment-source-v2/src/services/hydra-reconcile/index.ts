/**
 * L2 (in-head) escrow-state reconciler — the Hydra mirror of L1 tx-sync.
 *
 * PROBLEM: on L1, each node's tx-sync reads the shared on-chain contract UTxO and
 * advances BOTH sides of an escrow (payment + purchase) to whatever the datum
 * encodes, so every node observes every party's action. On L2 the escrow UTxO
 * lives INSIDE the head (Blockfrost can't see it), and the only L2 state
 * advancement is `hydra-tx-handler` confirming a node's OWN pending tx. So a
 * counterparty-driven in-head transition (seller submit-result, buyer
 * request-refund, …) is never observed by the other side — its `onChainState`
 * silently stalls (the reported payment/purchase divergence).
 *
 * FIX (correct for the multi-node model — each node reads only its OWN head
 * connection, no cross-DB syncing): replay immutable confirmed transactions in
 * Hydra sequence order first, then inspect the current contract UTxOs. Replay
 * preserves intermediate output lineage and proves terminal spends; the live
 * snapshot recovers current datum states. Both paths use the same idempotent,
 * evidence-validating writers as the event observer.
 *
 * Retryable replay or live-snapshot evidence keeps a finalized head connected
 * so a later reconciliation pass can finish before the transport is released.
 *
 * Mesh pinning (ADR 0005): lives in payment-source-v2 so `deserializeDatum` /
 * `decodeV2ContractDatum` resolve the V2 mesh line that wrote the datum.
 */
import { deserializeDatum, UTxO } from '@meshsdk/core';
import { CONFIG } from '@masumi/payment-core/config';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import {
	HydraHeadStatus,
	Network,
	OnChainState,
	PaymentSourceType,
	Prisma,
	TransactionLayer,
	TransactionStatus,
} from '@/generated/prisma/client';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import {
	applyDatumStateToLocalRequests,
	findLocallyRelevantHydraRequestIdentifiers,
	type HydraDatumApplyOutcome,
} from '@/services/hydra-connection-manager/hydra-datum-sync';
import { decodeV2ContractDatum, DecodedV1ContractDatum } from '@/utils/converter/string-datum-convert';
import { convertNetwork } from '@/utils/converter/network-convert';
import { smartContractStateToOnChainState } from '@/utils/logic/l2-datum-validation';
import {
	observedHydraOutputMatchesEvidence,
	parseHydraTransactionEvidence,
} from '@/services/hydra-connection-manager/hydra-transaction-evidence';
import {
	verifyHydraFanoutOnChain,
	type HydraFanoutChainObserver,
	type VerifiedHydraFanoutTransaction,
} from '@/lib/hydra/hydra/fanout-validation';
import type { VerifiedHydraFanoutReference } from '@/lib/hydra/hydra/snapshot-verification';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { reportExpiredL2Reservations } from './l2-reservation-recovery';
import type { HydraNode } from '@/lib/hydra/hydra/node';

const MAX_REPLAY_TRANSACTIONS_PER_HEAD_PER_RUN = 250;

/**
 * Reconcile every enabled active/final head's in-head escrow UTxOs against this node's
 * own payment/purchase requests. Safe to run on the same cadence as the pending
 * L2 tx handler; idempotent.
 */
export async function reconcileHydraHeadEscrowStates(): Promise<void> {
	const heads = await prisma.hydraHead.findMany({
		where: { isEnabled: true, initTxHash: { not: null } },
		include: {
			HydraRelation: {
				include: {
					LocalHotWallet: {
						include: { PaymentSource: { include: { PaymentSourceConfig: true } } },
					},
					RemoteWallet: true,
				},
			},
		},
	});
	if (heads.length === 0) {
		return;
	}

	const connectionManager = getHydraConnectionManager();
	for (const head of heads) {
		try {
			await reconcileHead(
				head.id,
				head.finalizedAt,
				head.reconciliationCompletedAt,
				head.latestSnapshotNumber,
				head.hydraRelationId,
				head.headIdentifier,
				head.HydraRelation.LocalHotWallet.walletVkey,
				head.HydraRelation.RemoteWallet.walletVkey,
				head.HydraRelation.LocalHotWallet.PaymentSource,
				connectionManager,
				head.reconciliationStalledTxId,
			);
		} catch (error) {
			logger.warn('[HydraReconcile] Failed to reconcile head', { hydraHeadId: head.id, error });
		}
	}
}

type ReconcileSource = {
	id: string;
	network: Network;
	smartContractAddress: string;
	paymentSourceType: PaymentSourceType;
	PaymentSourceConfig: { rpcProviderApiKey: string };
};

async function reconcileHead(
	hydraHeadId: string,
	finalizedAt: Date | null,
	reconciliationCompletedAt: Date | null,
	latestSnapshotNumber: bigint,
	hydraRelationId: string,
	headIdentifier: string | null,
	localParticipantVkey: string,
	remoteParticipantVkey: string,
	source: ReconcileSource,
	connectionManager: ReturnType<typeof getHydraConnectionManager>,
	reconciliationStalledTxId: string | null,
): Promise<void> {
	// Hydra L2 is V2-only (ADR 0005).
	if (source.paymentSourceType !== PaymentSourceType.Web3CardanoV2) {
		return;
	}
	const isDurablyEligible = await prisma.hydraHead.findFirst({
		where: { id: hydraHeadId, isEnabled: true, initTxHash: { not: null } },
		select: { id: true },
	});
	if (!isDurablyEligible) return;
	const provider = connectionManager.getProvider(hydraHeadId);
	if (!provider) {
		return;
	}
	const node = connectionManager.getNode(hydraHeadId);
	if (reconciliationCompletedAt != null) {
		// A previous pass durably proved this Final head has no remaining local
		// evidence obligations. Retrying disconnect is safe if the earlier transport
		// teardown failed after the marker was committed.
		const statusBeforeFlush = node?.status;
		await connectionManager.flushHeadStatus(hydraHeadId);
		if (statusBeforeFlush !== HydraHeadStatus.Final || node?.status !== HydraHeadStatus.Final) return;
		const durableCompletion = await prisma.hydraHead.findFirst({
			where: {
				id: hydraHeadId,
				isEnabled: true,
				status: HydraHeadStatus.Final,
				initTxHash: { not: null },
				fanoutTxHash: { not: null },
				reconciliationCompletedAt: { not: null },
			},
			select: { id: true },
		});
		if (!durableCompletion) return;
		await connectionManager.queueDisconnect(hydraHeadId);
		return;
	}

	// Replay confirmed CBOR in Hydra sequence order before inspecting the live
	// UTxO set. This preserves intermediate T1 outputs when one snapshot confirms
	// T1→T2 and recovers the same chain after a service restart.
	const reconciliationQueue = node?.getConfirmedTransactionsForReconciliation() ?? [];
	const replayBatch = reconciliationQueue.slice(0, MAX_REPLAY_TRANSACTIONS_PER_HEAD_PER_RUN);
	for (const confirmedTransaction of replayBatch) {
		const evidence = parseHydraTransactionEvidence(confirmedTransaction.cborHex);
		if (!evidence || evidence.txHash !== confirmedTransaction.txId) {
			// A consensus-valid Cardano transaction may be unsupported by the local
			// evidence parser. Never advance past it: a later transaction can depend
			// on its outputs, and dropping it would let the causal suffix bypass the
			// parser. A parser upgrade or operator intervention must resolve it.
			logger.error('[HydraReconcile] confirmed transaction evidence could not be validated; replay paused', {
				hydraHeadId,
				declaredTxId: confirmedTransaction.txId,
				parsedTxId: evidence?.txHash,
			});
			await markReconciliationStalled(hydraHeadId, confirmedTransaction.txId, 'evidence-parse-failed');
			return;
		}
		const outcome = await connectionManager.handleTxConfirmed(
			hydraHeadId,
			confirmedTransaction.txId,
			confirmedTransaction,
		);
		if (outcome === 'retry') {
			// Later confirmations may depend on this transaction's persisted UTxO
			// lineage. Keep the entire causal suffix queued and retry it in order.
			await markReconciliationStalled(hydraHeadId, confirmedTransaction.txId, 'replay-apply-retry');
			return;
		}
		if (!(await persistReconciledCursor(hydraHeadId, confirmedTransaction, node))) return;
	}
	if (reconciliationQueue.length > replayBatch.length) {
		// A large backlog is normal catch-up, not a stall: do not jump to the live
		// tip while an older causal suffix is deferred, and do not mark it stalled.
		return;
	}
	// Ordered replay fully drained → a persisted stall marker (from this or a
	// previous process) is stale. Gated on the head row's own marker so the
	// common healthy pass issues no extra write.
	if (reconciliationStalledTxId != null) {
		await clearReconciliationStall(hydraHeadId);
	}
	// The live UTxO tip can infer absence only after one authenticated, untruncated
	// history pass reached its matching Greetings marker. Expired reservations are
	// reported but retained: history absence cannot prove that a locally accepted
	// transaction is absent while it remains outside a signed snapshot.
	if (!(node?.hasVerifiedPinnedSessions && node.confirmedTransactionHistoryReady)) return;
	await reportExpiredL2Reservations({ hydraHeadId, network: source.network, node });

	const utxos = await provider.fetchAddressUTxOs(source.smartContractAddress);
	const observations: Array<{
		utxo: UTxO;
		decoded: DecodedV1ContractDatum;
		newState: OnChainState;
	}> = [];
	for (const utxo of utxos) {
		const datumCbor = utxo.output.plutusData;
		if (!datumCbor) {
			continue;
		}
		let decoded: DecodedV1ContractDatum | null;
		try {
			decoded = decodeV2ContractDatum(
				deserializeDatum(datumCbor),
				convertNetwork(source.network),
				source.smartContractAddress,
			);
		} catch {
			continue;
		}
		if (!decoded) {
			continue;
		}
		const newState = smartContractStateToOnChainState(decoded.state);
		if (!newState) {
			continue;
		}

		observations.push({ utxo, decoded, newState });
	}

	const identifierCounts = new Map<string, number>();
	let hasRetryableLiveObservation = false;
	for (const observation of observations) {
		identifierCounts.set(
			observation.decoded.blockchainIdentifier,
			(identifierCounts.get(observation.decoded.blockchainIdentifier) ?? 0) + 1,
		);
	}
	const duplicateIdentifiers = [...identifierCounts].filter(([, count]) => count > 1).map(([identifier]) => identifier);
	const locallyRelevantDuplicateIdentifiers = await findLocallyRelevantHydraRequestIdentifiers(
		source.id,
		duplicateIdentifiers,
	);
	for (const observation of observations) {
		if ((identifierCounts.get(observation.decoded.blockchainIdentifier) ?? 0) !== 1) {
			if (locallyRelevantDuplicateIdentifiers.has(observation.decoded.blockchainIdentifier)) {
				hasRetryableLiveObservation = true;
				logger.warn('[HydraReconcile] duplicate live outputs for local identifier; refusing ambiguous observation', {
					hydraHeadId,
					blockchainIdentifier: observation.decoded.blockchainIdentifier,
				});
			}
			continue;
		}
		const outcome = await reconcileEscrowUtxo(
			hydraHeadId,
			source,
			observation.utxo,
			observation.decoded,
			observation.newState,
		);
		hasRetryableLiveObservation ||= outcome === 'retry';
	}

	// A finalized head can be disconnected only after the history socket's
	// Greetings marker proves replay completion and every queued tx was resolved.
	if (
		finalizedAt != null &&
		!hasRetryableLiveObservation &&
		node?.confirmedTransactionHistoryReady &&
		node.getConfirmedTransactionsForReconciliation().length === 0
	) {
		const expectedSnapshotNumber = Number(latestSnapshotNumber);
		if (
			!Number.isSafeInteger(expectedSnapshotNumber) ||
			expectedSnapshotNumber < 0 ||
			headIdentifier == null ||
			node == null
		)
			return;
		const preparedHandoff = await prepareFinalHandoff(hydraHeadId, expectedSnapshotNumber, node);
		if (!preparedHandoff) return;
		const verifiedFanout = await verifyHydraFanoutOnChain({
			observer: getBlockfrostInstance(
				source.network,
				source.PaymentSourceConfig.rpcProviderApiKey,
			) as unknown as HydraFanoutChainObserver,
			headId: headIdentifier,
			participantVkeys: [localParticipantVkey, remoteParticipantVkey],
			references: preparedHandoff.allFanoutReferences,
			requiredConfirmations: CONFIG.BLOCK_CONFIRMATIONS_THRESHOLD,
		});
		if (
			!(await markFinalHeadReconciliationComplete({
				hydraHeadId,
				hydraRelationId,
				expectedSnapshotNumber,
				headIdentifier,
				node,
				preparedHandoff,
				verifiedFanout,
			}))
		)
			return;
		await connectionManager.queueDisconnect(hydraHeadId);
	}
}

type HandoffCandidate = {
	id: string;
	layer: TransactionLayer;
	currentTransactionId: string | null;
	onChainState: OnChainState | null;
	currentHydraUtxoTxHash: string | null;
	currentHydraUtxoOutputIndex: number | null;
	currentHydraUtxoValue: Prisma.JsonValue;
	unresolvedHydraTerminalTxHash: string | null;
	unresolvedHydraTerminalReason: string | null;
	hydraFanoutHandoffHeadId: string | null;
	hydraFanoutHandoffTxHash: string | null;
	hydraFanoutHandoffOutputIndex: number | null;
	CurrentTransaction: {
		status: TransactionStatus;
		txHash: string | null;
		layer: TransactionLayer;
		hydraHeadId: string | null;
		newOnChainState: OnChainState | null;
	} | null;
};

type PreparedHandoffCandidate = HandoffCandidate & {
	kind: 'payment' | 'purchase';
	hydraReference: string;
	fanoutReference: VerifiedHydraFanoutReference;
};

type PreparedFinalHandoff = {
	candidates: PreparedHandoffCandidate[];
	settledTerminals: Array<HandoffCandidate & { kind: 'payment' | 'purchase' }>;
	allFanoutReferences: VerifiedHydraFanoutReference[];
};

class FinalHandoffCasAbort extends Error {}

const handoffCandidateSelect = {
	id: true,
	layer: true,
	currentTransactionId: true,
	onChainState: true,
	currentHydraUtxoTxHash: true,
	currentHydraUtxoOutputIndex: true,
	currentHydraUtxoValue: true,
	unresolvedHydraTerminalTxHash: true,
	unresolvedHydraTerminalReason: true,
	hydraFanoutHandoffHeadId: true,
	hydraFanoutHandoffTxHash: true,
	hydraFanoutHandoffOutputIndex: true,
	CurrentTransaction: {
		select: { status: true, txHash: true, layer: true, hydraHeadId: true, newOnChainState: true },
	},
} as const;

function blockingRequestWhere(hydraHeadId: string) {
	return {
		OR: [
			{ CurrentTransaction: { is: { hydraHeadId, layer: TransactionLayer.L2 } } },
			{ hydraFanoutHandoffHeadId: hydraHeadId },
		],
	};
}

const SETTLED_TERMINAL_STATES = new Set<OnChainState>([OnChainState.Withdrawn, OnChainState.RefundWithdrawn]);

function isSafelySettledTerminal(candidate: HandoffCandidate, hydraHeadId: string): boolean {
	return (
		candidate.layer === TransactionLayer.L2 &&
		candidate.onChainState != null &&
		SETTLED_TERMINAL_STATES.has(candidate.onChainState) &&
		candidate.CurrentTransaction?.status === TransactionStatus.Confirmed &&
		candidate.CurrentTransaction.layer === TransactionLayer.L2 &&
		candidate.CurrentTransaction.hydraHeadId === hydraHeadId &&
		candidate.CurrentTransaction.newOnChainState === candidate.onChainState &&
		candidate.CurrentTransaction.txHash != null &&
		/^[0-9a-f]{64}$/.test(candidate.CurrentTransaction.txHash) &&
		candidate.currentHydraUtxoTxHash == null &&
		candidate.currentHydraUtxoOutputIndex == null &&
		candidate.currentHydraUtxoValue == null &&
		candidate.unresolvedHydraTerminalTxHash == null &&
		candidate.unresolvedHydraTerminalReason == null &&
		candidate.hydraFanoutHandoffHeadId == null &&
		candidate.hydraFanoutHandoffTxHash == null &&
		candidate.hydraFanoutHandoffOutputIndex == null
	);
}

function settledTerminalMatches(left: HandoffCandidate, right: HandoffCandidate, hydraHeadId: string): boolean {
	return (
		left.id === right.id &&
		left.layer === right.layer &&
		left.currentTransactionId === right.currentTransactionId &&
		left.onChainState === right.onChainState &&
		left.CurrentTransaction?.status === right.CurrentTransaction?.status &&
		left.CurrentTransaction?.txHash === right.CurrentTransaction?.txHash &&
		left.CurrentTransaction?.layer === right.CurrentTransaction?.layer &&
		left.CurrentTransaction?.hydraHeadId === right.CurrentTransaction?.hydraHeadId &&
		left.CurrentTransaction?.newOnChainState === right.CurrentTransaction?.newOnChainState &&
		isSafelySettledTerminal(left, hydraHeadId) &&
		isSafelySettledTerminal(right, hydraHeadId)
	);
}

function fanoutReferencesEqual(left: VerifiedHydraFanoutReference, right: VerifiedHydraFanoutReference): boolean {
	return (
		left.txHash === right.txHash &&
		left.outputIndex === right.outputIndex &&
		left.snapshotNumber === right.snapshotNumber &&
		left.serializedOutput === right.serializedOutput
	);
}

function fanoutReferenceListsEqual(
	left: readonly VerifiedHydraFanoutReference[],
	right: readonly VerifiedHydraFanoutReference[],
): boolean {
	if (left.length !== right.length) return false;
	const leftKeys = new Set(left.map((reference) => `${reference.txHash}#${reference.outputIndex}`));
	const rightByReference = new Map(
		right.map((reference) => [`${reference.txHash}#${reference.outputIndex}`, reference]),
	);
	return (
		leftKeys.size === left.length &&
		rightByReference.size === right.length &&
		left.every((reference) => {
			const other = rightByReference.get(`${reference.txHash}#${reference.outputIndex}`);
			return other != null && fanoutReferencesEqual(reference, other);
		})
	);
}

function existingHandoffMatches(
	hydraHeadId: string,
	candidate: HandoffCandidate,
	evidence: VerifiedHydraFanoutReference,
): boolean {
	const fields = [
		candidate.hydraFanoutHandoffHeadId,
		candidate.hydraFanoutHandoffTxHash,
		candidate.hydraFanoutHandoffOutputIndex,
	];
	if (fields.every((value) => value == null)) return true;
	return (
		candidate.hydraFanoutHandoffHeadId === hydraHeadId &&
		candidate.hydraFanoutHandoffTxHash === evidence.txHash &&
		candidate.hydraFanoutHandoffOutputIndex === evidence.outputIndex
	);
}

async function prepareFinalHandoff(
	hydraHeadId: string,
	expectedSnapshotNumber: number,
	node: HydraNode,
): Promise<PreparedFinalHandoff | null> {
	const allFanoutReferences = node.getVerifiedFanoutReferences?.(expectedSnapshotNumber);
	if (
		!allFanoutReferences ||
		allFanoutReferences.some(({ snapshotNumber }) => snapshotNumber !== expectedSnapshotNumber)
	) {
		return null;
	}
	const fullReferenceMap = new Map(
		allFanoutReferences.map((reference) => [`${reference.txHash}#${reference.outputIndex}`, reference]),
	);
	if (fullReferenceMap.size !== allFanoutReferences.length) return null;

	const where = blockingRequestWhere(hydraHeadId);
	const [paymentCandidates, purchaseCandidates] = await Promise.all([
		prisma.paymentRequest.findMany({ where, select: handoffCandidateSelect }),
		prisma.purchaseRequest.findMany({ where, select: handoffCandidateSelect }),
	]);
	const candidates: PreparedHandoffCandidate[] = [];
	const settledTerminals: PreparedFinalHandoff['settledTerminals'] = [];
	for (const [kind, requestCandidates] of [
		['payment', paymentCandidates],
		['purchase', purchaseCandidates],
	] as const) {
		for (const candidate of requestCandidates) {
			if (isSafelySettledTerminal(candidate, hydraHeadId)) {
				settledTerminals.push({ ...candidate, kind });
				continue;
			}
			if (
				candidate.layer !== TransactionLayer.L2 ||
				candidate.currentTransactionId == null ||
				candidate.CurrentTransaction?.status !== TransactionStatus.Confirmed ||
				candidate.CurrentTransaction.layer !== TransactionLayer.L2 ||
				candidate.CurrentTransaction.hydraHeadId !== hydraHeadId ||
				candidate.CurrentTransaction.newOnChainState !== candidate.onChainState ||
				candidate.CurrentTransaction.txHash == null ||
				!/^[0-9a-f]{64}$/.test(candidate.CurrentTransaction.txHash) ||
				candidate.unresolvedHydraTerminalTxHash != null ||
				candidate.currentHydraUtxoTxHash == null ||
				candidate.currentHydraUtxoTxHash !== candidate.CurrentTransaction.txHash ||
				candidate.currentHydraUtxoOutputIndex == null ||
				candidate.currentHydraUtxoValue == null
			) {
				return null;
			}
			const hydraReference = `${candidate.currentHydraUtxoTxHash.toLowerCase()}#${candidate.currentHydraUtxoOutputIndex}`;
			const fanoutReference = node.getVerifiedFanoutReference?.(hydraReference, expectedSnapshotNumber);
			if (
				!fanoutReference ||
				fanoutReference.snapshotNumber !== expectedSnapshotNumber ||
				!fanoutReferencesEqual(
					fullReferenceMap.get(`${fanoutReference.txHash}#${fanoutReference.outputIndex}`) ??
						({
							txHash: '',
							outputIndex: -1,
							snapshotNumber: -1,
							serializedOutput: '',
						} satisfies VerifiedHydraFanoutReference),
					fanoutReference,
				) ||
				!existingHandoffMatches(hydraHeadId, candidate, fanoutReference)
			) {
				return null;
			}
			candidates.push({ ...candidate, kind, hydraReference, fanoutReference });
		}
	}
	return { candidates, settledTerminals, allFanoutReferences };
}

async function markFinalHeadReconciliationComplete(options: {
	hydraHeadId: string;
	hydraRelationId: string;
	expectedSnapshotNumber: number;
	headIdentifier: string;
	node: HydraNode;
	preparedHandoff: PreparedFinalHandoff;
	verifiedFanout: VerifiedHydraFanoutTransaction;
}): Promise<boolean> {
	const {
		hydraHeadId,
		hydraRelationId,
		expectedSnapshotNumber,
		headIdentifier,
		node,
		preparedHandoff,
		verifiedFanout,
	} = options;
	try {
		return await prisma.$transaction(
			async (tx) => {
				// Head creation/deletion and rollback persistence take the relation
				// lock first. Matching that order prevents a replacement head from
				// appearing between proof validation and adoption.
				const relations = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				SELECT "id"
				FROM "HydraRelation"
				WHERE "id" = ${hydraRelationId}
				FOR UPDATE
			`);
				if (relations.length !== 1) return false;
				// Datum/redeemer application takes FOR SHARE on this same row. Waiting for
				// FOR UPDATE drains every in-flight mutation; holding it prevents a new
				// reservation or observation from slipping between blocker counts and the
				// durable completion marker.
				const rows = await tx.$queryRaw<
					Array<{
						status: HydraHeadStatus;
						isEnabled: boolean;
						initTxHash: string | null;
						finalizedAt: Date | null;
						reconciliationCompletedAt: Date | null;
						headIdentifier: string | null;
						latestSnapshotNumber: bigint;
						fanoutTxHash: string | null;
					}>
				>(Prisma.sql`
				SELECT "status", "isEnabled", "initTxHash", "finalizedAt", "reconciliationCompletedAt",
					"headIdentifier", "latestSnapshotNumber", "fanoutTxHash"
				FROM "HydraHead"
				WHERE "id" = ${hydraHeadId}
				FOR UPDATE
			`);
				const head = rows[0];
				if (
					head == null ||
					head.status !== HydraHeadStatus.Final ||
					!head.isEnabled ||
					head.initTxHash == null ||
					head.finalizedAt == null ||
					head.headIdentifier !== headIdentifier ||
					head.latestSnapshotNumber !== BigInt(expectedSnapshotNumber) ||
					(head.fanoutTxHash != null && head.fanoutTxHash !== verifiedFanout.txHash)
				) {
					return false;
				}
				if (head.reconciliationCompletedAt != null) {
					return head.fanoutTxHash === verifiedFanout.txHash;
				}
				const currentFanoutReferences = node.getVerifiedFanoutReferences?.(expectedSnapshotNumber);
				if (
					node.status !== HydraHeadStatus.Final ||
					!currentFanoutReferences ||
					!fanoutReferenceListsEqual(currentFanoutReferences, preparedHandoff.allFanoutReferences) ||
					preparedHandoff.candidates.some((candidate) => {
						const currentReference = node.getVerifiedFanoutReference?.(
							candidate.hydraReference,
							expectedSnapshotNumber,
						);
						return !currentReference || !fanoutReferencesEqual(currentReference, candidate.fanoutReference);
					})
				) {
					return false;
				}

				const pendingL2Transactions = await tx.transaction.count({
					where: {
						hydraHeadId,
						layer: TransactionLayer.L2,
						status: TransactionStatus.Pending,
					},
				});
				if (pendingL2Transactions !== 0) {
					return false;
				}

				const where = blockingRequestWhere(hydraHeadId);
				const [lockedPaymentCandidates, lockedPurchaseCandidates] = await Promise.all([
					tx.paymentRequest.findMany({ where, select: handoffCandidateSelect }),
					tx.purchaseRequest.findMany({ where, select: handoffCandidateSelect }),
				]);
				const lockedCandidates = [
					...lockedPaymentCandidates.map((candidate) => ({ ...candidate, kind: 'payment' as const })),
					...lockedPurchaseCandidates.map((candidate) => ({ ...candidate, kind: 'purchase' as const })),
				];
				const preparedCandidateMap = new Map(
					preparedHandoff.candidates.map((candidate) => [`${candidate.kind}:${candidate.id}`, candidate]),
				);
				const preparedTerminalMap = new Map(
					preparedHandoff.settledTerminals.map((candidate) => [`${candidate.kind}:${candidate.id}`, candidate]),
				);
				if (
					lockedCandidates.length !== preparedCandidateMap.size + preparedTerminalMap.size ||
					lockedCandidates.some((candidate) => {
						const key = `${candidate.kind}:${candidate.id}`;
						const prepared = preparedCandidateMap.get(`${candidate.kind}:${candidate.id}`);
						const preparedTerminal = preparedTerminalMap.get(key);
						if (preparedTerminal) return !settledTerminalMatches(candidate, preparedTerminal, hydraHeadId);
						return (
							prepared == null ||
							candidate.layer !== prepared.layer ||
							candidate.currentTransactionId !== prepared.currentTransactionId ||
							candidate.currentHydraUtxoTxHash !== prepared.currentHydraUtxoTxHash ||
							candidate.currentHydraUtxoOutputIndex !== prepared.currentHydraUtxoOutputIndex ||
							candidate.CurrentTransaction?.status !== prepared.CurrentTransaction?.status ||
							candidate.CurrentTransaction?.layer !== prepared.CurrentTransaction?.layer ||
							candidate.CurrentTransaction?.hydraHeadId !== prepared.CurrentTransaction?.hydraHeadId ||
							candidate.CurrentTransaction?.newOnChainState !== prepared.CurrentTransaction?.newOnChainState ||
							candidate.CurrentTransaction?.txHash !== prepared.CurrentTransaction?.txHash ||
							candidate.unresolvedHydraTerminalTxHash !== null ||
							!existingHandoffMatches(hydraHeadId, candidate, prepared.fanoutReference)
						);
					})
				) {
					return false;
				}

				const transactionData = {
					status: TransactionStatus.Confirmed,
					confirmations: verifiedFanout.confirmations,
					lastCheckedAt: new Date(),
					fees: verifiedFanout.fees,
					blockHeight: verifiedFanout.blockHeight,
					blockTime: verifiedFanout.blockTime,
					outputAmount: verifiedFanout.outputAmount,
					utxoCount: verifiedFanout.utxoCount,
					withdrawalCount: verifiedFanout.withdrawalCount,
					assetMintOrBurnCount: verifiedFanout.assetMintOrBurnCount,
					redeemerCount: verifiedFanout.redeemerCount,
					validContract: verifiedFanout.validContract,
					layer: TransactionLayer.L1,
					hydraHeadId,
				} as const;
				const existingL1Transaction = await tx.transaction.findFirst({
					where: {
						txHash: verifiedFanout.txHash,
						layer: TransactionLayer.L1,
						BlocksWallet: { is: null },
					},
					orderBy: { createdAt: 'asc' },
					select: { id: true },
				});
				const l1Transaction = existingL1Transaction
					? await tx.transaction.update({
							where: { id: existingL1Transaction.id },
							data: transactionData,
							select: { id: true },
						})
					: await tx.transaction.create({
							data: { txHash: verifiedFanout.txHash, ...transactionData },
							select: { id: true },
						});

				for (const candidate of preparedHandoff.candidates) {
					const handoffMutation = {
						where: {
							id: candidate.id,
							currentTransactionId: candidate.currentTransactionId,
							layer: TransactionLayer.L2,
							currentHydraUtxoTxHash: candidate.currentHydraUtxoTxHash,
							currentHydraUtxoOutputIndex: candidate.currentHydraUtxoOutputIndex,
							unresolvedHydraTerminalTxHash: null,
							CurrentTransaction: {
								is: {
									hydraHeadId,
									layer: TransactionLayer.L2,
									status: TransactionStatus.Confirmed,
									txHash: candidate.currentHydraUtxoTxHash,
									newOnChainState: candidate.onChainState,
								},
							},
							OR: [
								{
									hydraFanoutHandoffHeadId: null,
									hydraFanoutHandoffTxHash: null,
									hydraFanoutHandoffOutputIndex: null,
								},
								{
									hydraFanoutHandoffHeadId: hydraHeadId,
									hydraFanoutHandoffTxHash: candidate.fanoutReference.txHash,
									hydraFanoutHandoffOutputIndex: candidate.fanoutReference.outputIndex,
								},
							],
						},
						data: {
							hydraFanoutHandoffHeadId: hydraHeadId,
							hydraFanoutHandoffTxHash: candidate.fanoutReference.txHash,
							hydraFanoutHandoffOutputIndex: candidate.fanoutReference.outputIndex,
						},
					};
					const handoffMarked =
						candidate.kind === 'payment'
							? await tx.paymentRequest.updateMany(handoffMutation)
							: await tx.purchaseRequest.updateMany(handoffMutation);
					if (handoffMarked.count !== 1) throw new FinalHandoffCasAbort();

					const adoptionData = {
						layer: TransactionLayer.L1,
						currentHydraUtxoTxHash: null,
						currentHydraUtxoOutputIndex: null,
						currentHydraUtxoValue: Prisma.DbNull,
						unresolvedHydraTerminalTxHash: null,
						unresolvedHydraTerminalReason: null,
						hydraFanoutHandoffHeadId: null,
						hydraFanoutHandoffTxHash: null,
						hydraFanoutHandoffOutputIndex: null,
						TransactionHistory: { connect: { id: candidate.currentTransactionId! } },
						CurrentTransaction: { connect: { id: l1Transaction.id } },
					} as const;
					if (candidate.kind === 'payment') {
						await tx.paymentRequest.update({ where: { id: candidate.id }, data: adoptionData });
					} else {
						await tx.purchaseRequest.update({ where: { id: candidate.id }, data: adoptionData });
					}
				}

				for (const terminal of preparedHandoff.settledTerminals) {
					const terminalCas = {
						where: {
							id: terminal.id,
							currentTransactionId: terminal.currentTransactionId,
							layer: TransactionLayer.L2,
							onChainState: terminal.onChainState,
							currentHydraUtxoTxHash: null,
							currentHydraUtxoOutputIndex: null,
							unresolvedHydraTerminalTxHash: null,
							unresolvedHydraTerminalReason: null,
							hydraFanoutHandoffHeadId: null,
							hydraFanoutHandoffTxHash: null,
							hydraFanoutHandoffOutputIndex: null,
							CurrentTransaction: {
								is: {
									hydraHeadId,
									layer: TransactionLayer.L2,
									status: TransactionStatus.Confirmed,
									txHash: terminal.CurrentTransaction!.txHash,
									newOnChainState: terminal.onChainState,
								},
							},
						},
						// No semantic field changes here: this is the exact-shape CAS
						// before the following relational move while the head lock is held.
						data: { layer: TransactionLayer.L2 },
					};
					const terminalClaimed =
						terminal.kind === 'payment'
							? await tx.paymentRequest.updateMany(terminalCas)
							: await tx.purchaseRequest.updateMany(terminalCas);
					if (terminalClaimed.count !== 1) throw new FinalHandoffCasAbort();
					const terminalData = {
						TransactionHistory: { connect: { id: terminal.currentTransactionId! } },
						CurrentTransaction: { disconnect: true },
					} as const;
					if (terminal.kind === 'payment') {
						await tx.paymentRequest.update({ where: { id: terminal.id }, data: terminalData });
					} else {
						await tx.purchaseRequest.update({ where: { id: terminal.id }, data: terminalData });
					}
				}

				const markedComplete = await tx.hydraHead.updateMany({
					where: {
						id: hydraHeadId,
						status: HydraHeadStatus.Final,
						isEnabled: true,
						initTxHash: { not: null },
						finalizedAt: { not: null },
						reconciliationCompletedAt: null,
						headIdentifier,
						latestSnapshotNumber: BigInt(expectedSnapshotNumber),
						OR: [{ fanoutTxHash: null }, { fanoutTxHash: verifiedFanout.txHash }],
					},
					data: {
						fanoutTxHash: verifiedFanout.txHash,
						reconciliationCompletedAt: new Date(),
					},
				});
				if (markedComplete.count !== 1) throw new FinalHandoffCasAbort();
				return true;
			},
			{ timeout: 15_000, maxWait: 15_000 },
		);
	} catch (error) {
		if (error instanceof FinalHandoffCasAbort) return false;
		throw error;
	}
}

/**
 * Persist the "ordered replay is stuck on tx X" operator marker. Best-effort
 * (a marker write failure must never abort the pass) and churn-free: `since`
 * is only (re)stamped when the stalled tx or reason actually changes.
 */
async function markReconciliationStalled(hydraHeadId: string, txId: string, reason: string): Promise<void> {
	try {
		await prisma.hydraHead.updateMany({
			where: {
				id: hydraHeadId,
				OR: [{ reconciliationStalledTxId: { not: txId } }, { reconciliationStalledReason: { not: reason } }],
			},
			data: {
				reconciliationStalledTxId: txId,
				reconciliationStalledReason: reason,
				reconciliationStalledSince: new Date(),
			},
		});
	} catch (error) {
		logger.warn('[HydraReconcile] failed to persist reconciliation stall marker', { hydraHeadId, txId, error });
	}
}

/** Clear the stall marker once the ordered replay drains. Best-effort, no-op when unset. */
async function clearReconciliationStall(hydraHeadId: string): Promise<void> {
	try {
		await prisma.hydraHead.updateMany({
			where: { id: hydraHeadId, reconciliationStalledTxId: { not: null } },
			data: {
				reconciliationStalledTxId: null,
				reconciliationStalledReason: null,
				reconciliationStalledSince: null,
			},
		});
	} catch (error) {
		logger.warn('[HydraReconcile] failed to clear reconciliation stall marker', { hydraHeadId, error });
	}
}

async function persistReconciledCursor(
	hydraHeadId: string,
	confirmedTransaction: { txId: string; snapshotSequence: number | null; snapshotTransactionIndex: number },
	node: HydraNode | null,
): Promise<boolean> {
	const sequence = confirmedTransaction.snapshotSequence;
	const index = confirmedTransaction.snapshotTransactionIndex;
	if (
		sequence == null ||
		!Number.isSafeInteger(sequence) ||
		sequence < 0 ||
		!Number.isSafeInteger(index) ||
		index < 0
	) {
		logger.warn('[HydraReconcile] confirmed transaction lacks a durable ordered cursor', {
			hydraHeadId,
			txId: confirmedTransaction.txId,
		});
		return false;
	}
	const updated = await prisma.hydraHead.updateMany({
		where: {
			id: hydraHeadId,
			isEnabled: true,
			initTxHash: { not: null },
			reconciliationCompletedAt: null,
			OR: [
				{ lastReconciledSnapshotSequence: null },
				{ lastReconciledSnapshotSequence: { lt: BigInt(sequence) } },
				{
					lastReconciledSnapshotSequence: BigInt(sequence),
					OR: [
						{ lastReconciledSnapshotTransactionIndex: null },
						{ lastReconciledSnapshotTransactionIndex: { lt: index } },
					],
				},
			],
		},
		data: {
			lastReconciledSnapshotSequence: BigInt(sequence),
			lastReconciledSnapshotTransactionIndex: index,
		},
	});
	if (updated.count !== 1) {
		// A concurrent worker may already have advanced this cursor. Distinguish
		// that benign race from deletion/disablement of the head before evicting
		// the only in-memory copy of this evidence.
		const persisted = await prisma.hydraHead.findUnique({
			where: { id: hydraHeadId },
			select: {
				isEnabled: true,
				initTxHash: true,
				reconciliationCompletedAt: true,
				lastReconciledSnapshotSequence: true,
				lastReconciledSnapshotTransactionIndex: true,
			},
		});
		const persistedSequence = persisted?.lastReconciledSnapshotSequence;
		const persistedIndex = persisted?.lastReconciledSnapshotTransactionIndex;
		if (
			persisted?.isEnabled !== true ||
			persisted.initTxHash == null ||
			persisted.reconciliationCompletedAt != null ||
			persistedSequence == null ||
			persistedIndex == null ||
			persistedSequence < BigInt(sequence) ||
			(persistedSequence === BigInt(sequence) && persistedIndex < index)
		) {
			logger.warn('[HydraReconcile] durable replay cursor was not persisted; evidence retained', {
				hydraHeadId,
				txId: confirmedTransaction.txId,
			});
			return false;
		}
	}
	node?.markConfirmedTransactionReconciled(confirmedTransaction.txId);
	return true;
}

async function reconcileEscrowUtxo(
	hydraHeadId: string,
	source: ReconcileSource,
	utxo: UTxO,
	decoded: DecodedV1ContractDatum,
	newState: OnChainState,
): Promise<HydraDatumApplyOutcome> {
	const outputAmounts = utxo.output.amount.map((a) => ({ unit: a.unit, quantity: a.quantity }));
	const node = getHydraConnectionManager().getNode(hydraHeadId);
	const confirmedTransaction = node?.getConfirmedTransaction(utxo.input.txHash) ?? null;
	if (!confirmedTransaction) {
		logger.warn('[HydraReconcile] live output has no confirmed-CBOR evidence', {
			hydraHeadId,
			txHash: utxo.input.txHash,
			outputIndex: utxo.input.outputIndex,
		});
		return 'retry';
	}
	const transactionEvidence = parseHydraTransactionEvidence(confirmedTransaction.cborHex);
	if (
		!transactionEvidence ||
		transactionEvidence.txHash !== utxo.input.txHash ||
		!observedHydraOutputMatchesEvidence(transactionEvidence, utxo)
	) {
		logger.warn('[HydraReconcile] live output differs from confirmed-CBOR evidence', {
			hydraHeadId,
			txHash: utxo.input.txHash,
			outputIndex: utxo.input.outputIndex,
		});
		return 'retry';
	}
	// Hydra's top-level SnapshotConfirmed timestamp applies to every transaction
	// in that snapshot. Legacy replay frames without it stay null, so first-seen
	// locks fail closed instead of using a stale head-clock tick as deadline proof.
	const confirmationTimeMs = confirmedTransaction?.confirmedAtMs ?? null;
	logger.info('[HydraReconcile] advancing in-head escrow state', {
		hydraHeadId,
		blockchainIdentifier: decoded.blockchainIdentifier,
		newState,
	});
	return await applyDatumStateToLocalRequests({
		hydraHeadId,
		txId: utxo.input.txHash,
		paymentSourceId: source.id,
		network: source.network,
		decoded,
		newOnChainState: newState,
		outputAmounts,
		outputReference: utxo.input,
		transactionEvidence,
		confirmationTimeMs,
		skipPendingCurrentTransaction: true,
	});
}
