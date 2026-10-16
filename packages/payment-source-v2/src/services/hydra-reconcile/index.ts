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
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { deserializeDatum, UTxO } from '@meshsdk/core';
import { CONFIG } from '@masumi/payment-core/config';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { HydraHeadStatus, Network, OnChainState, PaymentSourceType } from '@/generated/prisma/client';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import {
	applyDatumStateToLocalRequests,
	findHydraRequestLineages,
	type HydraDatumApplyOutcome,
} from '@/services/hydra-connection-manager/hydra-datum-sync';
import { isPersistedHydraOutput } from '@/services/hydra-connection-manager/hydra-request-lineage';
import { decodeV2ContractDatum, DecodedV1ContractDatum } from '@/utils/converter/string-datum-convert';
import { convertNetwork } from '@/utils/converter/network-convert';
import { smartContractStateToOnChainState } from '@/utils/logic/l2-datum-validation';
import {
	observedHydraOutputMatchesEvidence,
	parseHydraTransactionEvidence,
} from '@/services/hydra-connection-manager/hydra-transaction-evidence';
import { verifyHydraFanoutOnChain, type HydraFanoutChainObserver } from '@/lib/hydra/hydra/fanout-validation';
import type { VerifiedHydraFanoutReference } from '@/lib/hydra/hydra/snapshot-verification';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { reportExpiredL2Reservations } from './l2-reservation-recovery';
import { markFinalHeadReconciliationComplete, prepareFinalHandoff } from './final-handoff';
import { releaseFinalHeadL2Reservations } from './final-l2-reservation-release';
import {
	findIdentifiersWithNothingToApply,
	isLivePassDue,
	memoizedLiveEscrowDecode,
	memoizedTransactionEvidence,
	pruneLiveEscrowMemo,
	recordLivePass,
	retainLiveEscrowMemoHeads,
} from './live-escrow-memo';
import type { HydraNode } from '@/lib/hydra/hydra/node';

const MAX_REPLAY_TRANSACTIONS_PER_HEAD_PER_RUN = 250;

/**
 * Reconcile every enabled active/final head's in-head escrow UTxOs against this node's
 * own payment/purchase requests. Runs on the pending L2 tx handler cadence so the
 * ordered replay drains promptly; the live-snapshot pass is throttled per head by
 * HYDRA_ESCROW_RECONCILE_INTERVAL. Idempotent.
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
	// A completed head never runs a live pass again, so its memo is dropped too.
	retainLiveEscrowMemoHeads(heads.filter((head) => head.reconciliationCompletedAt == null).map((head) => head.id));
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
	// released only on verified-snapshot input proof and reported otherwise:
	// history absence cannot prove that a locally accepted transaction is absent
	// while it remains outside a signed snapshot.
	if (!(node?.hasVerifiedPinnedSessions && node.confirmedTransactionHistoryReady)) return;
	await reportExpiredL2Reservations({ hydraHeadId, network: source.network, node });

	// The live snapshot is a safety net behind the TxConfirmed handler, so it is
	// throttled per head. A finalized head is never throttled or skipped: there a
	// 'retry' outcome gates the fan-out handoff and disconnect.
	const isFinalized = finalizedAt != null;
	if (!isFinalized && !isLivePassDue(hydraHeadId, CONFIG.HYDRA_ESCROW_RECONCILE_INTERVAL * 1000)) return;

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
		// An output reference is immutable, so its decode is reused per head while
		// the datum bytes stay the same.
		const observation = memoizedLiveEscrowDecode(hydraHeadId, utxo.input, datumCbor, () => {
			let decoded: DecodedV1ContractDatum | null;
			try {
				decoded = decodeV2ContractDatum(
					deserializeDatum(datumCbor),
					convertNetwork(source.network),
					source.smartContractAddress,
				);
			} catch {
				return null;
			}
			if (!decoded) {
				return null;
			}
			const newState = smartContractStateToOnChainState(decoded.state);
			return newState ? { decoded, newState } : null;
		});
		if (!observation) {
			continue;
		}

		observations.push({ utxo, decoded: observation.decoded, newState: observation.newState });
	}
	pruneLiveEscrowMemo(
		hydraHeadId,
		utxos.map((utxo) => utxo.input),
	);

	const identifierCounts = new Map<string, number>();
	let hasRetryableLiveObservation = false;
	for (const observation of observations) {
		identifierCounts.set(
			observation.decoded.blockchainIdentifier,
			(identifierCounts.get(observation.decoded.blockchainIdentifier) ?? 0) + 1,
		);
	}
	const duplicateIdentifiers = [...identifierCounts].filter(([, count]) => count > 1).map(([identifier]) => identifier);
	const duplicateLineages = await findHydraRequestLineages(source.id, duplicateIdentifiers);
	// Most live outputs are already applied; one batched read finds them so the
	// pass skips their per-output serializable transaction.
	const identifiersWithNothingToApply = isFinalized
		? new Set<string>()
		: await findIdentifiersWithNothingToApply(
				source.id,
				observations
					.filter((observation) => identifierCounts.get(observation.decoded.blockchainIdentifier) === 1)
					.map((observation) => ({
						blockchainIdentifier: observation.decoded.blockchainIdentifier,
						newState: observation.newState,
						outputReference: observation.utxo.input,
					})),
			);
	for (const observation of observations) {
		// Yield between outputs so API requests are not starved by a long pass.
		await yieldToEventLoop();
		const lineages = duplicateLineages.get(observation.decoded.blockchainIdentifier);
		if (
			(identifierCounts.get(observation.decoded.blockchainIdentifier) ?? 0) !== 1 &&
			!lineages?.some((lineage) => isPersistedHydraOutput(lineage, observation.utxo.input))
		) {
			// Ordered replay drained before this pass, so a local escrow's persisted
			// output is normally its current one. Any other output with a copied
			// identifier is skipped rather than held as a retry a peer could fund;
			// the final handoff still refuses an escrow whose persisted output is
			// stale. Log it for review.
			if (lineages) {
				logger.error('[HydraReconcile] ignoring live output that copies a local identifier', {
					hydraHeadId,
					blockchainIdentifier: observation.decoded.blockchainIdentifier,
					outputReference: observation.utxo.input,
					state: observation.newState,
					amount: observation.utxo.output.amount,
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
			identifiersWithNothingToApply.has(observation.decoded.blockchainIdentifier),
		);
		hasRetryableLiveObservation ||= outcome === 'retry';
	}
	// A pass with retryable outputs stays due, so it reruns on the next tick.
	recordLivePass(hydraHeadId, !hasRetryableLiveObservation);

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
		// One observer pass per reference set: the release step and the handoff
		// both check the same fanout when a release happens.
		const fanoutChecks = new Map<string, ReturnType<typeof verifyHydraFanoutOnChain>>();
		const verifyFanout = (references: readonly VerifiedHydraFanoutReference[]) => {
			const key = JSON.stringify(references);
			const check =
				fanoutChecks.get(key) ??
				verifyHydraFanoutOnChain({
					observer: getBlockfrostInstance(
						source.network,
						source.PaymentSourceConfig.rpcProviderApiKey,
					) as unknown as HydraFanoutChainObserver,
					headId: headIdentifier,
					participantVkeys: [localParticipantVkey, remoteParticipantVkey],
					references,
					requiredConfirmations: CONFIG.BLOCK_CONFIRMATIONS_THRESHOLD,
				});
			fanoutChecks.set(key, check);
			return check;
		};
		// The handoff refuses any Pending L2 row, and a Final head never makes the
		// snapshot the open head release path waits for.
		await releaseFinalHeadL2Reservations({
			hydraHeadId,
			expectedSnapshotNumber,
			node,
			verifyFanoutOnChain: verifyFanout,
		});
		const preparedHandoff = await prepareFinalHandoff(hydraHeadId, expectedSnapshotNumber, node);
		if (!preparedHandoff) return;
		const verifiedFanoutChain = await verifyFanout(preparedHandoff.allFanoutReferences);
		if (
			!(await markFinalHeadReconciliationComplete({
				hydraHeadId,
				hydraRelationId,
				expectedSnapshotNumber,
				headIdentifier,
				node,
				preparedHandoff,
				verifiedFanoutChain,
			}))
		)
			return;
		await connectionManager.queueDisconnect(hydraHeadId);
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
				OR: [
					{ reconciliationStalledTxId: null },
					{ reconciliationStalledReason: null },
					{ reconciliationStalledTxId: { not: txId } },
					{ reconciliationStalledReason: { not: reason } },
				],
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
	hasNothingToApply: boolean,
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
	const transactionEvidence = memoizedTransactionEvidence(hydraHeadId, utxo.input.txHash, confirmedTransaction.cborHex);
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
	// Evidence is still checked above so a missing or mismatched confirmation keeps
	// signalling 'retry'; only the no-op write transaction is skipped.
	if (hasNothingToApply) {
		return 'irrelevant';
	}
	// Hydra's top-level SnapshotConfirmed timestamp applies to every transaction
	// in that snapshot. Legacy replay frames without it stay null, so first-seen
	// locks fail closed instead of using a stale head-clock tick as deadline proof.
	const confirmationTimeMs = confirmedTransaction?.confirmedAtMs ?? null;
	// Debug, not info: every pass re-applies every live escrow output, almost
	// always as a no-op, so at info this repeated each row every cycle.
	logger.debug('[HydraReconcile] advancing in-head escrow state', {
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
