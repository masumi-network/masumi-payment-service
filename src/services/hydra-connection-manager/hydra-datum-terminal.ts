/**
 * Applying the spend that ends an in-head escrow.
 *
 * Split from hydra-datum-sync, which was past the 750-line limit. The seam is
 * the one the file already had: everything before it decides what an observed
 * datum means for a request that is still live, and this decides what a spend
 * of that escrow settles it to — collected, refunded, or a withdrawal the head
 * could not bind to a snapshot.
 *
 * Imports the guards and the observation bookkeeping from the module it came
 * from; nothing there depends on this, so the dependency runs one way and the
 * connection manager imports this endpoint of the flow directly.
 */

import { CONSTANTS } from '@masumi/payment-core/config';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { decodeBlockchainIdentifier } from '@masumi/payment-core/blockchain-identifier';
import { deserializeDatum } from '@meshsdk/core';
import { Constr, Data } from 'lucid-cardano';
import {
	OnChainState,
	PaymentAction,
	Prisma,
	PurchasingAction,
	TransactionLayer,
	TransactionStatus,
} from '@/generated/prisma/client';
import { decodeV2ContractDatum } from '@/utils/converter/string-datum-convert';
import { convertNewPaymentActionAndError, convertNewPurchasingActionAndError } from '@/utils/logic/state-transitions';
import {
	canonicalizeHydraAmounts,
	hydraAmountListCovers,
	hydraValidityLowerBoundTimeMs,
	hydraValidityUpperBoundTimeMs,
	type HydraAmount,
	type HydraTransactionEvidence,
} from './hydra-transaction-evidence';
import { resolveHydraL2EvidenceSlotConfig } from '@/utils/hydra/l2-slot-context';
import { convertNetwork } from '@/utils/converter/network-convert';

import {
	ensureObservedTransaction,
	hasBodyBoundActor,
	lockHydraMutationAdmission,
	parsePersistedHydraValue,
	releaseBlockedWallet,
	requestParticipantsMatch,
	unresolvedDisputedWithdrawalNote,
	UNRESOLVED_DISPUTED_WITHDRAWAL_REASON,
	type HydraDatumApplyOutcome,
	type PersistedEscrowState,
} from './hydra-datum-sync';

function outputReferenceDatum(txHash: string, outputIndex: number): string {
	return Data.to(new Constr(0, [txHash, BigInt(outputIndex)])).toLowerCase();
}

function sumTaggedOutputs(
	evidence: HydraTransactionEvidence,
	address: string,
	input: { txHash: string; outputIndex: number },
): Map<string, bigint> {
	const expectedDatum = outputReferenceDatum(input.txHash, input.outputIndex);
	const amounts = new Map<string, bigint>();
	for (const output of evidence.outputs) {
		if (output.address !== address || output.plutusData?.toLowerCase() !== expectedDatum) continue;
		for (const amount of output.amount) {
			const unit =
				amount.unit === '' || amount.unit.toLowerCase() === 'lovelace' ? 'lovelace' : amount.unit.toLowerCase();
			amounts.set(unit, (amounts.get(unit) ?? 0n) + BigInt(amount.quantity));
		}
	}
	return amounts;
}

function taggedValueCovers(actual: Map<string, bigint>, required: readonly HydraAmount[]): boolean {
	return hydraAmountListCovers(
		[...actual].map(([unit, quantity]) => ({ unit, quantity: quantity.toString() })),
		required,
	);
}

function valueAfterCollateral(inputValue: readonly HydraAmount[], collateral: bigint): HydraAmount[] | null {
	if (collateral < 0n) return null;
	const canonical = canonicalizeHydraAmounts(inputValue);
	if (!canonical) return null;
	const lovelace = canonical.find(({ unit }) => unit === 'lovelace');
	if (collateral > BigInt(lovelace?.quantity ?? '0')) return null;
	return canonical
		.map((amount) =>
			amount.unit === 'lovelace' ? { ...amount, quantity: (BigInt(amount.quantity) - collateral).toString() } : amount,
		)
		.filter(({ quantity }) => quantity !== '0');
}

function authorizedTerminalState(params: {
	request: PersistedEscrowState & {
		buyerReturnAddress: string | null;
		sellerReturnAddress: string | null;
	};
	buyer: { walletVkey: string; walletAddress: string };
	seller: { walletVkey: string; walletAddress: string };
	inputValue: readonly HydraAmount[];
	input: { txHash: string; outputIndex: number };
	evidence: HydraTransactionEvidence;
	slotConfig: ReturnType<typeof resolveHydraL2EvidenceSlotConfig>;
	resultTime: bigint;
	unlockTime: bigint;
}): OnChainState | null {
	const { request, buyer, seller, inputValue, input, evidence, slotConfig, resultTime, unlockTime } = params;
	const collateral = request.collateralReturnLovelace;
	if (collateral == null || collateral < 0n) return null;
	const sellerRequiredValue = valueAfterCollateral(inputValue, collateral);
	if (!sellerRequiredValue) return null;
	const lowerTime = hydraValidityLowerBoundTimeMs(evidence, slotConfig);
	const upperTime = hydraValidityUpperBoundTimeMs(evidence, slotConfig);
	if (upperTime == null || (lowerTime != null && lowerTime > upperTime)) return null;

	if (
		(request.onChainState === OnChainState.ResultSubmitted ||
			request.onChainState === OnChainState.WithdrawAuthorized) &&
		request.resultHash != null &&
		hasBodyBoundActor(evidence, seller.walletVkey) &&
		(request.onChainState === OnChainState.WithdrawAuthorized || (lowerTime != null && lowerTime >= unlockTime))
	) {
		const buyerTarget = request.buyerReturnAddress ?? buyer.walletAddress;
		const buyerPayout = sumTaggedOutputs(evidence, buyerTarget, input);
		if (request.sellerReturnAddress != null) {
			const sellerPayout = sumTaggedOutputs(evidence, request.sellerReturnAddress, input);
			if (!taggedValueCovers(sellerPayout, sellerRequiredValue)) return null;
		}
		if ((buyerPayout.get('lovelace') ?? 0n) < collateral) return null;
		return OnChainState.Withdrawn;
	}

	if (
		(request.onChainState === OnChainState.FundsLocked ||
			request.onChainState === OnChainState.RefundRequested ||
			request.onChainState === OnChainState.RefundAuthorized) &&
		request.resultHash == null &&
		hasBodyBoundActor(evidence, buyer.walletVkey) &&
		(request.onChainState === OnChainState.RefundAuthorized || (lowerTime != null && lowerTime >= resultTime))
	) {
		// With no return address, the V2 contract intentionally lets the buyer
		// choose any destination in the body they signed. When one is pinned, the
		// full exact input value must be carried by own-ref-tagged outputs.
		if (request.buyerReturnAddress != null) {
			const buyerPayout = sumTaggedOutputs(evidence, request.buyerReturnAddress, input);
			if (!taggedValueCovers(buyerPayout, inputValue)) return null;
		}
		return OnChainState.RefundWithdrawn;
	}

	// WithdrawDisputed uses CIP-8 signatures embedded in the redeemer rather
	// than body VKey witnesses. Hydra 2.3 does not sign those witness bytes, so
	// fail closed until the admin payload is independently verified.
	return null;
}

function isUnresolvedDisputedWithdrawal(params: {
	request: { onChainState: OnChainState | null; resultHash: string | null; externalDisputeUnlockTime: bigint };
	input: { txHash: string; outputIndex: number };
	evidence: HydraTransactionEvidence;
	slotConfig: ReturnType<typeof resolveHydraL2EvidenceSlotConfig>;
}): boolean {
	const { request, input, evidence, slotConfig } = params;
	if (request.onChainState !== OnChainState.Disputed || request.resultHash == null) return false;
	const lowerTime = hydraValidityLowerBoundTimeMs(evidence, slotConfig);
	const upperTime = hydraValidityUpperBoundTimeMs(evidence, slotConfig);
	return (
		lowerTime != null &&
		upperTime != null &&
		lowerTime <= upperTime &&
		lowerTime >= request.externalDisputeUnlockTime &&
		evidence.spends.some(
			(spend) =>
				spend.txHash === input.txHash && spend.outputIndex === input.outputIndex && spend.redeemerVersion === 4,
		)
	);
}

/** Reconcile confirmed terminal spends, which have no continuation output. */
export async function applyTerminalHydraSpends(params: {
	hydraHeadId: string;
	txId: string;
	paymentSourceId: string;
	transactionEvidence: HydraTransactionEvidence;
}): Promise<HydraDatumApplyOutcome> {
	const { hydraHeadId, txId, paymentSourceId, transactionEvidence } = params;
	if (transactionEvidence.txHash !== txId) return 'retry';
	// Endpoint-supplied redeemers are witness metadata and are not covered by a
	// Hydra 2.3 snapshot signature. Candidate terminal actions therefore start
	// from body inputs and are authorized below from prior state + actor proof.
	const candidateInputs = transactionEvidence.inputs;
	const inputHashes = [...new Set(candidateInputs.map((input) => input.txHash))];
	if (inputHashes.length === 0) return 'irrelevant';
	let hasCandidate = false;
	let hasApplied = false;
	let hasEvidenceFailure = false;
	let hasUnresolvedDisputedWithdrawal = false;
	let isAdmissionDenied = false;

	await prisma.$transaction(
		async (tx) => {
			if (!(await lockHydraMutationAdmission(tx, hydraHeadId))) {
				isAdmissionDenied = true;
				return;
			}
			const head = await tx.hydraHead.findUnique({
				where: { id: hydraHeadId },
				include: {
					HydraRelation: {
						include: {
							LocalHotWallet: { include: { PaymentSource: true } },
							RemoteWallet: true,
						},
					},
				},
			});
			if (!head) return;
			const source = head.HydraRelation.LocalHotWallet.PaymentSource;
			if (source.id !== paymentSourceId) return;
			const continuationReferenceSignatures = new Set<string>();
			for (const output of transactionEvidence.outputs) {
				if (output.address !== source.smartContractAddress || output.plutusData == null) continue;
				try {
					const decoded = decodeV2ContractDatum(
						deserializeDatum(output.plutusData),
						convertNetwork(source.network),
						source.smartContractAddress,
					);
					if (decoded) continuationReferenceSignatures.add(decoded.referenceSignature);
				} catch {
					// Script-address dust is permissionless. Candidate terminal spends
					// are independently selected by exact persisted input references and
					// authorized below, so unrelated malformed outputs are irrelevant.
					continue;
				}
			}
			const slotConfig = resolveHydraL2EvidenceSlotConfig(convertNetwork(source.network));

			const paymentRequests = await tx.paymentRequest.findMany({
				where: {
					paymentSourceId,
					layer: TransactionLayer.L2,
					currentHydraUtxoTxHash: { in: inputHashes },
				},
				include: {
					NextAction: true,
					CurrentTransaction: { include: { BlocksWallet: true } },
					TransactionHistory: { select: { txHash: true } },
					RequestedFunds: true,
					BuyerWallet: true,
					SmartContractWallet: true,
				},
			});
			for (const request of paymentRequests) {
				const requestIdentifier = decodeBlockchainIdentifier(request.blockchainIdentifier);
				const spend = candidateInputs.find(
					(candidate) =>
						candidate.txHash === request.currentHydraUtxoTxHash &&
						candidate.outputIndex === request.currentHydraUtxoOutputIndex,
				);
				if (!spend) continue;
				hasCandidate = true;
				if (
					requestIdentifier == null ||
					continuationReferenceSignatures.has(requestIdentifier.signature) ||
					request.currentHydraUtxoTxHash == null ||
					request.currentHydraUtxoOutputIndex == null ||
					request.TransactionHistory.some((history) => history.txHash === txId) ||
					!requestParticipantsMatch('payment', request, head, paymentSourceId)
				) {
					continue;
				}
				if (!request.BuyerWallet || !request.SmartContractWallet) continue;
				const isUnresolvedDisputedSpend = isUnresolvedDisputedWithdrawal({
					request,
					input: spend,
					evidence: transactionEvidence,
					slotConfig,
				});
				if (isUnresolvedDisputedSpend) {
					const matchingCurrentTransaction =
						request.CurrentTransaction?.layer === TransactionLayer.L2 &&
						request.CurrentTransaction.hydraHeadId === hydraHeadId &&
						(request.CurrentTransaction.txHash === txId || request.CurrentTransaction.intendedTxHash === txId)
							? request.CurrentTransaction
							: null;
					const observedTransactionId = await ensureObservedTransaction(tx, {
						hydraHeadId,
						txId,
						currentTransaction: matchingCurrentTransaction,
						previousState: request.onChainState,
						newState: OnChainState.Disputed,
					});
					if (matchingCurrentTransaction) await releaseBlockedWallet(tx, matchingCurrentTransaction);
					const conflictingPendingTransaction =
						request.CurrentTransaction?.id !== observedTransactionId &&
						request.CurrentTransaction?.status === TransactionStatus.Pending &&
						request.CurrentTransaction.layer === TransactionLayer.L2 &&
						request.CurrentTransaction.hydraHeadId === hydraHeadId
							? request.CurrentTransaction
							: null;
					if (conflictingPendingTransaction) {
						await tx.transaction.update({
							where: { id: conflictingPendingTransaction.id },
							data: { status: TransactionStatus.RolledBack },
						});
						await releaseBlockedWallet(tx, conflictingPendingTransaction);
					}
					const isAlreadyParked =
						request.unresolvedHydraTerminalTxHash === txId &&
						request.unresolvedHydraTerminalReason === UNRESOLVED_DISPUTED_WITHDRAWAL_REASON &&
						request.NextAction.requestedAction === PaymentAction.None;
					await tx.paymentRequest.update({
						where: { id: request.id },
						data: {
							unresolvedHydraTerminalTxHash: txId,
							unresolvedHydraTerminalReason: UNRESOLVED_DISPUTED_WITHDRAWAL_REASON,
							TransactionHistory:
								request.currentTransactionId && request.currentTransactionId !== observedTransactionId
									? { connect: { id: request.currentTransactionId } }
									: undefined,
							CurrentTransaction: { connect: { id: observedTransactionId } },
							...(isAlreadyParked
								? {}
								: {
										ActionHistory: { connect: { id: request.nextActionId } },
										NextAction: {
											create: {
												requestedAction: PaymentAction.None,
												errorNote: unresolvedDisputedWithdrawalNote(txId),
												errorType: null,
											},
										},
									}),
						},
					});
					hasApplied = true;
					hasUnresolvedDisputedWithdrawal = true;
					continue;
				}
				if (
					request.NextAction.requestedAction === PaymentAction.None ||
					request.CurrentTransaction == null ||
					request.CurrentTransaction.layer !== TransactionLayer.L2 ||
					request.CurrentTransaction.hydraHeadId !== hydraHeadId
				) {
					continue;
				}
				const inputValue = parsePersistedHydraValue(request.currentHydraUtxoValue);
				if (!inputValue) {
					hasEvidenceFailure = true;
					continue;
				}
				const newState = authorizedTerminalState({
					request,
					buyer: request.BuyerWallet,
					seller: request.SmartContractWallet,
					inputValue,
					input: spend,
					evidence: transactionEvidence,
					slotConfig,
					resultTime: request.submitResultTime,
					unlockTime: request.unlockTime,
				});
				if (!newState) {
					hasEvidenceFailure = true;
					continue;
				}

				const observedTransactionId = await ensureObservedTransaction(tx, {
					hydraHeadId,
					txId,
					currentTransaction: request.CurrentTransaction,
					previousState: request.onChainState,
					newState,
				});
				const newAction = convertNewPaymentActionAndError(request.NextAction.requestedAction, newState);
				await tx.paymentRequest.update({
					where: { id: request.id },
					data: {
						currentHydraUtxoTxHash: null,
						currentHydraUtxoOutputIndex: null,
						currentHydraUtxoValue: Prisma.DbNull,
						unresolvedHydraTerminalTxHash: null,
						unresolvedHydraTerminalReason: null,
						onChainState: newState,
						ActionHistory: { connect: { id: request.nextActionId } },
						NextAction: {
							create: {
								requestedAction: newAction.action,
								errorNote: newAction.errorNote,
								errorType: newAction.errorType,
							},
						},
						TransactionHistory:
							request.currentTransactionId && request.currentTransactionId !== observedTransactionId
								? { connect: { id: request.currentTransactionId } }
								: undefined,
						CurrentTransaction: { connect: { id: observedTransactionId } },
					},
				});
				await releaseBlockedWallet(tx, request.CurrentTransaction);
				hasApplied = true;
			}

			const purchaseRequests = await tx.purchaseRequest.findMany({
				where: {
					paymentSourceId,
					layer: TransactionLayer.L2,
					currentHydraUtxoTxHash: { in: inputHashes },
				},
				include: {
					NextAction: true,
					CurrentTransaction: { include: { BlocksWallet: true } },
					TransactionHistory: { select: { txHash: true } },
					PaidFunds: true,
					SellerWallet: true,
					SmartContractWallet: true,
				},
			});
			for (const request of purchaseRequests) {
				const requestIdentifier = decodeBlockchainIdentifier(request.blockchainIdentifier);
				const spend = candidateInputs.find(
					(candidate) =>
						candidate.txHash === request.currentHydraUtxoTxHash &&
						candidate.outputIndex === request.currentHydraUtxoOutputIndex,
				);
				if (!spend) continue;
				hasCandidate = true;
				if (
					requestIdentifier == null ||
					continuationReferenceSignatures.has(requestIdentifier.signature) ||
					request.currentHydraUtxoTxHash == null ||
					request.currentHydraUtxoOutputIndex == null ||
					request.TransactionHistory.some((history) => history.txHash === txId) ||
					!requestParticipantsMatch('purchase', request, head, paymentSourceId)
				) {
					continue;
				}
				if (!request.SmartContractWallet || !request.SellerWallet) continue;
				const isUnresolvedDisputedSpend = isUnresolvedDisputedWithdrawal({
					request,
					input: spend,
					evidence: transactionEvidence,
					slotConfig,
				});
				if (isUnresolvedDisputedSpend) {
					const matchingCurrentTransaction =
						request.CurrentTransaction?.layer === TransactionLayer.L2 &&
						request.CurrentTransaction.hydraHeadId === hydraHeadId &&
						(request.CurrentTransaction.txHash === txId || request.CurrentTransaction.intendedTxHash === txId)
							? request.CurrentTransaction
							: null;
					const observedTransactionId = await ensureObservedTransaction(tx, {
						hydraHeadId,
						txId,
						currentTransaction: matchingCurrentTransaction,
						previousState: request.onChainState,
						newState: OnChainState.Disputed,
					});
					if (matchingCurrentTransaction) await releaseBlockedWallet(tx, matchingCurrentTransaction);
					const conflictingPendingTransaction =
						request.CurrentTransaction?.id !== observedTransactionId &&
						request.CurrentTransaction?.status === TransactionStatus.Pending &&
						request.CurrentTransaction.layer === TransactionLayer.L2 &&
						request.CurrentTransaction.hydraHeadId === hydraHeadId
							? request.CurrentTransaction
							: null;
					if (conflictingPendingTransaction) {
						await tx.transaction.update({
							where: { id: conflictingPendingTransaction.id },
							data: { status: TransactionStatus.RolledBack },
						});
						await releaseBlockedWallet(tx, conflictingPendingTransaction);
					}
					const isAlreadyParked =
						request.unresolvedHydraTerminalTxHash === txId &&
						request.unresolvedHydraTerminalReason === UNRESOLVED_DISPUTED_WITHDRAWAL_REASON &&
						request.NextAction.requestedAction === PurchasingAction.None;
					await tx.purchaseRequest.update({
						where: { id: request.id },
						data: {
							unresolvedHydraTerminalTxHash: txId,
							unresolvedHydraTerminalReason: UNRESOLVED_DISPUTED_WITHDRAWAL_REASON,
							TransactionHistory:
								request.currentTransactionId && request.currentTransactionId !== observedTransactionId
									? { connect: { id: request.currentTransactionId } }
									: undefined,
							CurrentTransaction: { connect: { id: observedTransactionId } },
							...(isAlreadyParked
								? {}
								: {
										ActionHistory: { connect: { id: request.nextActionId } },
										NextAction: {
											create: {
												requestedAction: PurchasingAction.None,
												errorNote: unresolvedDisputedWithdrawalNote(txId),
												errorType: null,
											},
										},
									}),
						},
					});
					hasApplied = true;
					hasUnresolvedDisputedWithdrawal = true;
					continue;
				}
				if (
					request.NextAction.requestedAction === PurchasingAction.None ||
					request.CurrentTransaction == null ||
					request.CurrentTransaction.layer !== TransactionLayer.L2 ||
					request.CurrentTransaction.hydraHeadId !== hydraHeadId
				) {
					continue;
				}
				const inputValue = parsePersistedHydraValue(request.currentHydraUtxoValue);
				if (!inputValue) {
					hasEvidenceFailure = true;
					continue;
				}
				const newState = authorizedTerminalState({
					request,
					buyer: request.SmartContractWallet,
					seller: request.SellerWallet,
					inputValue,
					input: spend,
					evidence: transactionEvidence,
					slotConfig,
					resultTime: request.submitResultTime,
					unlockTime: request.unlockTime,
				});
				if (!newState) {
					hasEvidenceFailure = true;
					continue;
				}

				const observedTransactionId = await ensureObservedTransaction(tx, {
					hydraHeadId,
					txId,
					currentTransaction: request.CurrentTransaction,
					previousState: request.onChainState,
					newState,
				});
				const newAction = convertNewPurchasingActionAndError(request.NextAction.requestedAction, newState);
				await tx.purchaseRequest.update({
					where: { id: request.id },
					data: {
						currentHydraUtxoTxHash: null,
						currentHydraUtxoOutputIndex: null,
						currentHydraUtxoValue: Prisma.DbNull,
						unresolvedHydraTerminalTxHash: null,
						unresolvedHydraTerminalReason: null,
						onChainState: newState,
						ActionHistory: { connect: { id: request.nextActionId } },
						NextAction: {
							create: {
								requestedAction: newAction.action,
								errorNote: newAction.errorNote,
								errorType: newAction.errorType,
							},
						},
						TransactionHistory:
							request.currentTransactionId && request.currentTransactionId !== observedTransactionId
								? { connect: { id: request.currentTransactionId } }
								: undefined,
						CurrentTransaction: { connect: { id: observedTransactionId } },
					},
				});
				await releaseBlockedWallet(tx, request.CurrentTransaction);
				hasApplied = true;
			}
		},
		{
			isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
			timeout: CONSTANTS.TRANSACTION_WAIT.SERIALIZABLE,
			maxWait: CONSTANTS.TRANSACTION_WAIT.SERIALIZABLE,
		},
	);
	if (hasUnresolvedDisputedWithdrawal) {
		logger.warn('[HydraDatumSync] recorded unresolved disputed terminal spend without changing escrow money state', {
			hydraHeadId,
			txId,
			reason: UNRESOLVED_DISPUTED_WITHDRAWAL_REASON,
		});
	}
	// A transaction may touch multiple local escrows. Never let one successful
	// application discard replay evidence needed by another malformed candidate.
	return isAdmissionDenied || hasEvidenceFailure
		? 'retry'
		: hasApplied
			? 'applied'
			: hasCandidate
				? 'retry'
				: 'irrelevant';
}
