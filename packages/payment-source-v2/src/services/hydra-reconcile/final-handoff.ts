/**
 * Handing a finalized head's escrows back to L1.
 *
 * Once a head is fanned out, every request it carried has to stop being an
 * in-head row and become an on-chain one, atomically and only if nothing about
 * it moved while the evidence was being gathered. That check-and-swap is the
 * whole of this module, and it is why it is separate from the reconciler that
 * calls it: reconciliation reads a live head and can be retried at will, while
 * this writes the one transition that must not half-happen.
 *
 * Split from `./index` when that file passed the 750-line limit — the same cut
 * the route modules took, along the seam that was already there.
 */

import { prisma } from '@masumi/payment-core/db';
import { HydraHeadStatus, OnChainState, Prisma, TransactionLayer, TransactionStatus } from '@/generated/prisma/client';
import type { VerifiedHydraFanoutTransaction } from '@/lib/hydra/hydra/fanout-validation';
import type { VerifiedHydraFanoutReference } from '@/lib/hydra/hydra/snapshot-verification';
import type { HydraNode } from '@/lib/hydra/hydra/node';

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

export async function prepareFinalHandoff(
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

export async function markFinalHeadReconciliationComplete(options: {
	hydraHeadId: string;
	hydraRelationId: string;
	expectedSnapshotNumber: number;
	headIdentifier: string;
	node: HydraNode;
	preparedHandoff: PreparedFinalHandoff;
	/**
	 * The fanout's L1 transactions in chain order, terminal last.
	 *
	 * More than one when the head was too large to empty in a single transaction.
	 * Each request adopts the step that actually paid out its own output, so the
	 * chain is carried through rather than collapsed to a single hash here.
	 */
	verifiedFanoutChain: VerifiedHydraFanoutTransaction[];
}): Promise<boolean> {
	const {
		hydraHeadId,
		hydraRelationId,
		expectedSnapshotNumber,
		headIdentifier,
		node,
		preparedHandoff,
		verifiedFanoutChain,
	} = options;
	// The step that burned the head tokens, which is what ends the head on chain.
	// This is the hash the head record carries, and for a head that fanned out in
	// one transaction it is that transaction, exactly as before.
	const terminalFanout = verifiedFanoutChain[verifiedFanoutChain.length - 1];
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
					(head.fanoutTxHash != null && head.fanoutTxHash !== terminalFanout.txHash)
				) {
					return false;
				}
				if (head.reconciliationCompletedAt != null) {
					return head.fanoutTxHash === terminalFanout.txHash;
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

				// One L1 Transaction row per step of the chain. A request must end up
				// pointing at the transaction that actually paid out its own output:
				// connecting every request to the terminal step would name a
				// transaction that never produced their UTxO, and every later lookup
				// against that hash would be looking in the wrong place.
				const l1TransactionIdByTxHash = new Map<string, string>();
				for (const step of verifiedFanoutChain) {
					const transactionData = {
						status: TransactionStatus.Confirmed,
						confirmations: step.confirmations,
						lastCheckedAt: new Date(),
						fees: step.fees,
						blockHeight: step.blockHeight,
						blockTime: step.blockTime,
						outputAmount: step.outputAmount,
						utxoCount: step.utxoCount,
						withdrawalCount: step.withdrawalCount,
						assetMintOrBurnCount: step.assetMintOrBurnCount,
						redeemerCount: step.redeemerCount,
						validContract: step.validContract,
						layer: TransactionLayer.L1,
						hydraHeadId,
					} as const;
					const existingL1Transaction = await tx.transaction.findFirst({
						where: {
							txHash: step.txHash,
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
								data: { txHash: step.txHash, ...transactionData },
								select: { id: true },
							});
					l1TransactionIdByTxHash.set(step.txHash, l1Transaction.id);
				}

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

					const l1TransactionId = l1TransactionIdByTxHash.get(candidate.fanoutReference.txHash);
					if (l1TransactionId === undefined) throw new FinalHandoffCasAbort();
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
						CurrentTransaction: { connect: { id: l1TransactionId } },
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
						OR: [{ fanoutTxHash: null }, { fanoutTxHash: terminalFanout.txHash }],
					},
					data: {
						fanoutTxHash: terminalFanout.txHash,
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
