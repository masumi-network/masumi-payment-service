import { CONSTANTS } from '@masumi/payment-core/config';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import {
	OnChainState,
	Network,
	PaymentAction,
	HotWalletType,
	Prisma,
	PurchasingAction,
	TransactionLayer,
	TransactionStatus,
	WalletType,
} from '@/generated/prisma/client';
import { type DecodedV1ContractDatum } from '@/utils/converter/string-datum-convert';
import { datumMatchesRequest } from '@/utils/logic/l2-datum-validation';
import { convertNewPaymentActionAndError, convertNewPurchasingActionAndError } from '@/utils/logic/state-transitions';
import {
	canonicalizeHydraAmounts,
	hydraAmountListsEqual,
	hydraValidityUpperBoundTimeMs,
	type HydraTransactionEvidence,
} from './hydra-transaction-evidence';
import { resolveHydraL2EvidenceSlotConfig } from '@/utils/hydra/l2-slot-context';
import {
	canAdvanceLegacyHydraReference,
	continuationHasAuthorizedActor,
	headParticipantsMatch,
	isLegacyPendingLineageCandidate,
	lockHydraMutationAdmission,
	observationHasValidLineage,
	parsePersistedHydraValue,
	persistedHydraValue,
	resolveInitialLockState,
	type HydraDatumApplyOutcome,
	type HydraOutputReference,
} from './hydra-datum-guards';
import { ensureObservedTransaction, releaseBlockedWallet } from './hydra-datum-observation';

// Re-exported so the split stays invisible to importers: this module was the
// whole datum surface before it was broken up.
export {
	findLocallyRelevantHydraRequestIdentifiers,
	hasBodyBoundActor,
	lockHydraMutationAdmission,
	parsePersistedHydraValue,
	requestParticipantsMatch,
	unresolvedDisputedWithdrawalNote,
	UNRESOLVED_DISPUTED_WITHDRAWAL_REASON,
} from './hydra-datum-guards';
export type { HydraOutputReference, HydraDatumApplyOutcome, PersistedEscrowState } from './hydra-datum-guards';
export { ensureObservedTransaction, releaseBlockedWallet } from './hydra-datum-observation';
import { convertNetwork } from '@/utils/converter/network-convert';
import { hasHydraRequestOwnership, resolveEffectiveForceLayer } from '@/utils/logic/force-layer';

export async function applyDatumStateToLocalRequests(params: {
	hydraHeadId: string;
	txId: string;
	paymentSourceId: string;
	network: Network;
	decoded: DecodedV1ContractDatum;
	newOnChainState: OnChainState;
	outputAmounts: Array<{ unit: string; quantity: string }>;
	outputReference: HydraOutputReference;
	transactionEvidence: HydraTransactionEvidence | null;
	confirmationTimeMs: number | null;
	targetSide?: 'payment' | 'purchase';
	skipPendingCurrentTransaction?: boolean;
}): Promise<HydraDatumApplyOutcome> {
	const {
		hydraHeadId,
		txId,
		paymentSourceId,
		network,
		decoded,
		newOnChainState,
		outputAmounts,
		outputReference,
		transactionEvidence,
		confirmationTimeMs,
		targetSide,
		skipPendingCurrentTransaction = false,
	} = params;
	const evidenceSlotConfig = resolveHydraL2EvidenceSlotConfig(convertNetwork(network));
	const signedValidityUpperBoundTimeMs =
		transactionEvidence == null ? null : hydraValidityUpperBoundTimeMs(transactionEvidence, evidenceSlotConfig);
	const evidencedOutput = transactionEvidence?.outputs.find(
		(output) => output.outputIndex === outputReference.outputIndex,
	);
	if (
		transactionEvidence == null ||
		transactionEvidence.txHash !== txId ||
		outputReference.txHash !== txId ||
		evidencedOutput == null ||
		!hydraAmountListsEqual(evidencedOutput.amount, outputAmounts)
	) {
		logger.warn('[HydraDatumSync] missing or mismatched confirmed-CBOR output evidence', {
			hydraHeadId,
			txId,
			outputTxHash: outputReference.txHash,
			outputIndex: outputReference.outputIndex,
		});
		return 'retry';
	}
	const canonicalOutputAmounts = canonicalizeHydraAmounts(outputAmounts);
	if (!canonicalOutputAmounts || canonicalOutputAmounts.length === 0) return 'retry';
	const outputValueJson = persistedHydraValue(canonicalOutputAmounts);
	const blockchainIdentifier = decoded.blockchainIdentifier;
	const acceptedSides: Array<'payment' | 'purchase'> = [];
	let applyOutcome: HydraDatumApplyOutcome = 'retry';

	await prisma.$transaction(
		async (tx) => {
			if (!(await lockHydraMutationAdmission(tx, hydraHeadId))) return;
			const head = await tx.hydraHead.findUnique({
				where: { id: hydraHeadId },
				include: {
					HydraRelation: {
						include: {
							LocalHotWallet: { include: { PaymentSource: { select: { cooldownTime: true } } } },
							RemoteWallet: true,
						},
					},
				},
			});
			if (!head) return;

			const purchaseRequest = await tx.purchaseRequest.findUnique({
				where: { blockchainIdentifier, paymentSourceId },
				include: {
					NextAction: true,
					PaidFunds: true,
					CurrentTransaction: { include: { BlocksWallet: true } },
					TransactionHistory: { select: { txHash: true } },
					SellerWallet: true,
					SmartContractWallet: true,
				},
			});
			const paymentRequest = await tx.paymentRequest.findUnique({
				where: { blockchainIdentifier, paymentSourceId },
				include: {
					NextAction: true,
					RequestedFunds: true,
					CurrentTransaction: { include: { BlocksWallet: true } },
					TransactionHistory: { select: { txHash: true } },
					BuyerWallet: true,
					SmartContractWallet: true,
				},
			});
			const purchaseEffectiveForceLayer =
				purchaseRequest == null
					? null
					: resolveEffectiveForceLayer(purchaseRequest.forceLayer, purchaseRequest.paymentForceLayer);
			const purchaseHasHydraOwnership = purchaseRequest != null && hasHydraRequestOwnership(purchaseRequest);
			const paymentHasHydraOwnership = paymentRequest != null && hasHydraRequestOwnership(paymentRequest);
			const purchaseRoutingAllowsHydra =
				purchaseRequest == null ||
				purchaseHasHydraOwnership ||
				(purchaseRequest.onChainState == null &&
					purchaseRequest.CurrentTransaction == null &&
					purchaseEffectiveForceLayer !== TransactionLayer.L1 &&
					purchaseEffectiveForceLayer !== 'conflict');
			const paymentRoutingAllowsHydra =
				paymentRequest == null ||
				paymentHasHydraOwnership ||
				(paymentRequest.onChainState == null &&
					paymentRequest.CurrentTransaction == null &&
					paymentRequest.forceLayer !== TransactionLayer.L1);
			const hasTargetPurchase =
				(targetSide == null || targetSide === 'purchase') && purchaseRequest != null && purchaseRoutingAllowsHydra;
			const hasTargetPayment =
				(targetSide == null || targetSide === 'payment') && paymentRequest != null && paymentRoutingAllowsHydra;
			if (!hasTargetPurchase && !hasTargetPayment) {
				applyOutcome = 'irrelevant';
				return;
			}

			const purchaseLegacyCandidate =
				hasTargetPurchase &&
				purchaseRequest != null &&
				isLegacyPendingLineageCandidate({
					hydraHeadId,
					txId,
					requestLayer: purchaseRequest.layer,
					currentTransaction: purchaseRequest.CurrentTransaction,
					transactionHistory: purchaseRequest.TransactionHistory,
				});
			const paymentLegacyCandidate =
				hasTargetPayment &&
				paymentRequest != null &&
				isLegacyPendingLineageCandidate({
					hydraHeadId,
					txId,
					requestLayer: paymentRequest.layer,
					currentTransaction: paymentRequest.CurrentTransaction,
					transactionHistory: paymentRequest.TransactionHistory,
				});
			const shouldApplyPurchase =
				hasTargetPurchase &&
				purchaseRequest != null &&
				!purchaseLegacyCandidate &&
				purchaseRequest.NextAction.requestedAction !== PurchasingAction.None &&
				(!skipPendingCurrentTransaction || purchaseRequest.CurrentTransaction?.status !== TransactionStatus.Pending);
			const shouldApplyPayment =
				hasTargetPayment &&
				paymentRequest != null &&
				!paymentLegacyCandidate &&
				paymentRequest.NextAction.requestedAction !== PaymentAction.None &&
				(!skipPendingCurrentTransaction || paymentRequest.CurrentTransaction?.status !== TransactionStatus.Pending);
			const recoverablePurchaseWallet =
				head.HydraRelation.LocalHotWallet.paymentSourceId === paymentSourceId &&
				head.HydraRelation.LocalHotWallet.type === HotWalletType.Purchasing &&
				head.HydraRelation.LocalHotWallet.walletVkey === decoded.buyerVkey &&
				head.HydraRelation.LocalHotWallet.walletAddress === decoded.buyerAddress
					? head.HydraRelation.LocalHotWallet
					: null;

			const purchaseParticipantsAreValid =
				purchaseRequest != null && headParticipantsMatch(decoded, 'purchase', head, paymentSourceId);
			const purchaseDatumIsValid =
				purchaseRequest != null &&
				datumMatchesRequest(decoded, {
					inputHash: purchaseRequest.inputHash,
					submitResultTime: purchaseRequest.submitResultTime,
					unlockTime: purchaseRequest.unlockTime,
					externalDisputeUnlockTime: purchaseRequest.externalDisputeUnlockTime,
					payByTime: purchaseRequest.payByTime,
					buyerAddress:
						purchaseRequest.SmartContractWallet?.walletAddress ?? recoverablePurchaseWallet?.walletAddress ?? null,
					sellerAddress: purchaseRequest.SellerWallet?.walletAddress ?? null,
					buyerReturnAddress: purchaseRequest.buyerReturnAddress,
					sellerReturnAddress: purchaseRequest.sellerReturnAddress,
					buyerVkey: purchaseRequest.SmartContractWallet?.walletVkey ?? recoverablePurchaseWallet?.walletVkey ?? null,
					sellerVkey: purchaseRequest.SellerWallet?.walletVkey ?? null,
				});
			const purchaseLineageIsValid =
				purchaseRequest != null &&
				observationHasValidLineage({
					hydraHeadId,
					txId,
					observedState: newOnChainState,
					currentState: purchaseRequest.onChainState,
					requestLayer: purchaseRequest.layer,
					currentHydraUtxoTxHash: purchaseRequest.currentHydraUtxoTxHash,
					currentHydraUtxoOutputIndex: purchaseRequest.currentHydraUtxoOutputIndex,
					observedOutputReference: outputReference,
					currentTransaction: purchaseRequest.CurrentTransaction,
					transactionHistory: purchaseRequest.TransactionHistory,
					transactionEvidence,
					initialLockSignerVkey: decoded.buyerVkey,
				});
			const purchaseIsSameAcceptedOutput =
				purchaseRequest != null &&
				purchaseRequest.currentHydraUtxoTxHash === outputReference.txHash &&
				purchaseRequest.currentHydraUtxoOutputIndex === outputReference.outputIndex;
			const purchasePersistedInputValue =
				purchaseRequest == null ? null : parsePersistedHydraValue(purchaseRequest.currentHydraUtxoValue);
			const purchaseActionIsAuthorized =
				purchaseRequest != null &&
				(purchaseIsSameAcceptedOutput
					? purchaseRequest.onChainState === newOnChainState &&
						(purchaseRequest.currentHydraUtxoValue == null ||
							(purchasePersistedInputValue != null &&
								hydraAmountListsEqual(purchasePersistedInputValue, canonicalOutputAmounts)))
					: purchaseRequest.onChainState == null
						? newOnChainState === OnChainState.FundsLocked && purchaseRequest.currentHydraUtxoValue == null
						: transactionEvidence != null &&
							purchasePersistedInputValue != null &&
							continuationHasAuthorizedActor({
								request: purchaseRequest,
								decoded,
								newState: newOnChainState,
								expectedFunds: purchaseRequest.PaidFunds,
								inputAmounts: purchasePersistedInputValue,
								outputAmounts: canonicalOutputAmounts,
								evidence: transactionEvidence,
								slotConfig: evidenceSlotConfig,
								cooldownPeriodMs: head.HydraRelation.LocalHotWallet.PaymentSource.cooldownTime,
							}));
			const purchaseIsTrusted =
				shouldApplyPurchase &&
				purchaseParticipantsAreValid &&
				purchaseDatumIsValid &&
				purchaseLineageIsValid &&
				purchaseActionIsAuthorized;
			const paymentParticipantsAreValid =
				paymentRequest != null && headParticipantsMatch(decoded, 'payment', head, paymentSourceId);
			const paymentDatumIsValid =
				paymentRequest != null &&
				datumMatchesRequest(decoded, {
					inputHash: paymentRequest.inputHash,
					submitResultTime: paymentRequest.submitResultTime,
					unlockTime: paymentRequest.unlockTime,
					externalDisputeUnlockTime: paymentRequest.externalDisputeUnlockTime,
					payByTime: paymentRequest.payByTime,
					buyerAddress: paymentRequest.BuyerWallet?.walletAddress ?? null,
					sellerAddress: paymentRequest.SmartContractWallet?.walletAddress ?? null,
					buyerReturnAddress:
						paymentRequest.onChainState == null && paymentRequest.buyerReturnAddress == null
							? undefined
							: paymentRequest.buyerReturnAddress,
					sellerReturnAddress: paymentRequest.sellerReturnAddress,
					buyerVkey: paymentRequest.BuyerWallet?.walletVkey ?? null,
					sellerVkey: paymentRequest.SmartContractWallet?.walletVkey ?? null,
				});
			let hasLegacyBackfill = false;
			let hasLegacyBackfillRetry = false;
			if (purchaseLegacyCandidate && purchaseRequest) {
				const canAdvance =
					purchaseParticipantsAreValid &&
					purchaseDatumIsValid &&
					canAdvanceLegacyHydraReference({
						currentHydraUtxoTxHash: purchaseRequest.currentHydraUtxoTxHash,
						currentHydraUtxoOutputIndex: purchaseRequest.currentHydraUtxoOutputIndex,
						newOnChainState,
						decoded,
						expectedFunds: purchaseRequest.PaidFunds,
						outputAmounts,
						transactionEvidence,
						confirmationTimeMs,
						signedValidityUpperBoundTimeMs,
					});
				if (canAdvance) {
					await tx.purchaseRequest.update({
						where: { id: purchaseRequest.id },
						data: {
							currentHydraUtxoTxHash: outputReference.txHash,
							currentHydraUtxoOutputIndex: outputReference.outputIndex,
							currentHydraUtxoValue: outputValueJson,
							unresolvedHydraTerminalTxHash: null,
							unresolvedHydraTerminalReason: null,
						},
					});
					hasLegacyBackfill = true;
				} else {
					hasLegacyBackfillRetry = true;
				}
			}
			if (paymentLegacyCandidate && paymentRequest) {
				const canAdvance =
					paymentParticipantsAreValid &&
					paymentDatumIsValid &&
					canAdvanceLegacyHydraReference({
						currentHydraUtxoTxHash: paymentRequest.currentHydraUtxoTxHash,
						currentHydraUtxoOutputIndex: paymentRequest.currentHydraUtxoOutputIndex,
						newOnChainState,
						decoded,
						expectedFunds: paymentRequest.RequestedFunds,
						outputAmounts,
						transactionEvidence,
						confirmationTimeMs,
						signedValidityUpperBoundTimeMs,
					});
				if (canAdvance) {
					await tx.paymentRequest.update({
						where: { id: paymentRequest.id },
						data: {
							currentHydraUtxoTxHash: outputReference.txHash,
							currentHydraUtxoOutputIndex: outputReference.outputIndex,
							currentHydraUtxoValue: outputValueJson,
							unresolvedHydraTerminalTxHash: null,
							unresolvedHydraTerminalReason: null,
						},
					});
					hasLegacyBackfill = true;
				} else {
					hasLegacyBackfillRetry = true;
				}
			}
			const paymentLineageIsValid =
				paymentRequest != null &&
				observationHasValidLineage({
					hydraHeadId,
					txId,
					observedState: newOnChainState,
					currentState: paymentRequest.onChainState,
					requestLayer: paymentRequest.layer,
					currentHydraUtxoTxHash: paymentRequest.currentHydraUtxoTxHash,
					currentHydraUtxoOutputIndex: paymentRequest.currentHydraUtxoOutputIndex,
					observedOutputReference: outputReference,
					currentTransaction: paymentRequest.CurrentTransaction,
					transactionHistory: paymentRequest.TransactionHistory,
					transactionEvidence,
					initialLockSignerVkey: decoded.buyerVkey,
				});
			const paymentIsSameAcceptedOutput =
				paymentRequest != null &&
				paymentRequest.currentHydraUtxoTxHash === outputReference.txHash &&
				paymentRequest.currentHydraUtxoOutputIndex === outputReference.outputIndex;
			const paymentPersistedInputValue =
				paymentRequest == null ? null : parsePersistedHydraValue(paymentRequest.currentHydraUtxoValue);
			const paymentActionIsAuthorized =
				paymentRequest != null &&
				(paymentIsSameAcceptedOutput
					? paymentRequest.onChainState === newOnChainState &&
						(paymentRequest.currentHydraUtxoValue == null ||
							(paymentPersistedInputValue != null &&
								hydraAmountListsEqual(paymentPersistedInputValue, canonicalOutputAmounts)))
					: paymentRequest.onChainState == null
						? newOnChainState === OnChainState.FundsLocked && paymentRequest.currentHydraUtxoValue == null
						: transactionEvidence != null &&
							paymentPersistedInputValue != null &&
							continuationHasAuthorizedActor({
								request: paymentRequest,
								decoded,
								newState: newOnChainState,
								expectedFunds: paymentRequest.RequestedFunds,
								inputAmounts: paymentPersistedInputValue,
								outputAmounts: canonicalOutputAmounts,
								evidence: transactionEvidence,
								slotConfig: evidenceSlotConfig,
								cooldownPeriodMs: head.HydraRelation.LocalHotWallet.PaymentSource.cooldownTime,
							}));
			const paymentIsTrusted =
				shouldApplyPayment &&
				paymentParticipantsAreValid &&
				paymentDatumIsValid &&
				paymentLineageIsValid &&
				paymentActionIsAuthorized;

			if (!shouldApplyPurchase && !shouldApplyPayment) {
				if (hasLegacyBackfillRetry) {
					applyOutcome = 'retry';
					return;
				}
				if (hasLegacyBackfill) {
					applyOutcome = 'applied';
					return;
				}
				const hasPendingTarget =
					(hasTargetPurchase && purchaseRequest?.CurrentTransaction?.status === TransactionStatus.Pending) ||
					(hasTargetPayment && paymentRequest?.CurrentTransaction?.status === TransactionStatus.Pending);
				applyOutcome = hasPendingTarget ? 'retry' : 'irrelevant';
				return;
			}
			const purchaseIsPermanentReject =
				shouldApplyPurchase &&
				purchaseRequest != null &&
				(!purchaseParticipantsAreValid ||
					!purchaseDatumIsValid ||
					purchaseRequest.TransactionHistory.some((history) => history.txHash === txId) ||
					(purchaseRequest.onChainState === OnChainState.FundsOrDatumInvalid && !purchaseIsSameAcceptedOutput) ||
					(newOnChainState === OnChainState.FundsLocked &&
						purchaseRequest.onChainState == null &&
						transactionEvidence != null &&
						!transactionEvidence.signerVkeys.includes(decoded.buyerVkey)));
			const paymentIsPermanentReject =
				shouldApplyPayment &&
				paymentRequest != null &&
				(!paymentParticipantsAreValid ||
					!paymentDatumIsValid ||
					paymentRequest.TransactionHistory.some((history) => history.txHash === txId) ||
					(paymentRequest.onChainState === OnChainState.FundsOrDatumInvalid && !paymentIsSameAcceptedOutput) ||
					(newOnChainState === OnChainState.FundsLocked &&
						paymentRequest.onChainState == null &&
						transactionEvidence != null &&
						!transactionEvidence.signerVkeys.includes(decoded.buyerVkey)));
			// Per-side gating: only a TRANSIENTLY-unproven side (not yet trusted but not
			// permanently rejected either) blocks the tx with 'retry'. A PERMANENTLY
			// rejected side can never become trusted, so it is excluded from application
			// instead of blocking — otherwise one diverged row (e.g. a row created after
			// this tx already applied to the other side) would wedge the head's entire
			// ordered replay forever: 'retry' pauses the causal suffix and the cursor
			// never advances.
			const purchaseIsBlocking = shouldApplyPurchase && !purchaseIsTrusted && !purchaseIsPermanentReject;
			const paymentIsBlocking = shouldApplyPayment && !paymentIsTrusted && !paymentIsPermanentReject;
			if (purchaseIsBlocking || paymentIsBlocking) {
				return; // default outcome: 'retry' (fail-closed for unproven sides)
			}
			if (!purchaseIsTrusted && !paymentIsTrusted) {
				applyOutcome = 'irrelevant';
				return;
			}
			if ((shouldApplyPurchase && purchaseIsPermanentReject) || (shouldApplyPayment && paymentIsPermanentReject)) {
				logger.warn('[HydraDatumSync] one side permanently rejected; applying the other side only', {
					hydraHeadId,
					blockchainIdentifier,
					txId,
					purchaseIsPermanentReject,
					paymentIsPermanentReject,
				});
			}
			const purchaseEffectiveState =
				purchaseIsTrusted && purchaseRequest
					? resolveInitialLockState(
							newOnChainState,
							purchaseRequest.onChainState,
							purchaseIsSameAcceptedOutput,
							decoded,
							purchaseRequest.PaidFunds,
							canonicalOutputAmounts,
							confirmationTimeMs,
							signedValidityUpperBoundTimeMs,
							{ hydraHeadId, blockchainIdentifier, side: 'purchase' },
						)
					: null;
			const paymentEffectiveState =
				paymentIsTrusted && paymentRequest
					? resolveInitialLockState(
							newOnChainState,
							paymentRequest.onChainState,
							paymentIsSameAcceptedOutput,
							decoded,
							paymentRequest.RequestedFunds,
							canonicalOutputAmounts,
							confirmationTimeMs,
							signedValidityUpperBoundTimeMs,
							{ hydraHeadId, blockchainIdentifier, side: 'payment' },
						)
					: null;
			if (
				(purchaseIsTrusted && purchaseEffectiveState == null) ||
				(paymentIsTrusted && paymentEffectiveState == null)
			) {
				return;
			}

			if (purchaseIsTrusted && purchaseRequest) {
				const isSameAcceptedOutput = purchaseIsSameAcceptedOutput;
				const effectiveState = purchaseEffectiveState;
				if (effectiveState == null) return;
				const alreadyApplied =
					purchaseRequest.onChainState === effectiveState &&
					purchaseRequest.CurrentTransaction?.txHash === txId &&
					purchaseRequest.CurrentTransaction.status === TransactionStatus.Confirmed;
				if (alreadyApplied) {
					if (!isSameAcceptedOutput || purchaseRequest.currentHydraUtxoValue == null) {
						await tx.purchaseRequest.update({
							where: { id: purchaseRequest.id },
							data: {
								currentHydraUtxoTxHash: outputReference.txHash,
								currentHydraUtxoOutputIndex: outputReference.outputIndex,
								currentHydraUtxoValue: outputValueJson,
								unresolvedHydraTerminalTxHash: null,
								unresolvedHydraTerminalReason: null,
							},
						});
					}
				} else {
					const observedTransactionId = await ensureObservedTransaction(tx, {
						hydraHeadId,
						txId,
						currentTransaction: purchaseRequest.CurrentTransaction,
						previousState: purchaseRequest.onChainState,
						newState: effectiveState,
					});
					const newAction = convertNewPurchasingActionAndError(
						purchaseRequest.NextAction.requestedAction,
						effectiveState,
					);
					await tx.purchaseRequest.update({
						where: { id: purchaseRequest.id },
						data: {
							layer: TransactionLayer.L2,
							currentHydraUtxoTxHash: outputReference.txHash,
							currentHydraUtxoOutputIndex: outputReference.outputIndex,
							currentHydraUtxoValue: outputValueJson,
							unresolvedHydraTerminalTxHash: null,
							unresolvedHydraTerminalReason: null,
							onChainState: effectiveState,
							resultHash: decoded.resultHash,
							collateralReturnLovelace: decoded.collateralReturnLovelace,
							buyerCoolDownTime: decoded.buyerCooldownTime,
							sellerCoolDownTime: decoded.sellerCooldownTime,
							buyerReturnAddress: decoded.buyerReturnAddress ?? null,
							sellerReturnAddress: decoded.sellerReturnAddress ?? null,
							...(purchaseRequest.SmartContractWallet == null && recoverablePurchaseWallet
								? { SmartContractWallet: { connect: { id: recoverablePurchaseWallet.id } } }
								: {}),
							ActionHistory: { connect: { id: purchaseRequest.nextActionId } },
							NextAction: {
								create: {
									requestedAction: newAction.action,
									errorNote: newAction.errorNote,
									errorType: newAction.errorType,
								},
							},
							TransactionHistory:
								purchaseRequest.currentTransactionId && purchaseRequest.currentTransactionId !== observedTransactionId
									? { connect: { id: purchaseRequest.currentTransactionId } }
									: undefined,
							CurrentTransaction: { connect: { id: observedTransactionId } },
						},
					});
					await releaseBlockedWallet(tx, purchaseRequest.CurrentTransaction);
				}
				acceptedSides.push('purchase');
			}

			if (paymentIsTrusted && paymentRequest) {
				const isSameAcceptedOutput = paymentIsSameAcceptedOutput;
				const effectiveState = paymentEffectiveState;
				if (effectiveState == null) return;
				const alreadyApplied =
					paymentRequest.onChainState === effectiveState &&
					paymentRequest.CurrentTransaction?.txHash === txId &&
					paymentRequest.CurrentTransaction.status === TransactionStatus.Confirmed;
				if (alreadyApplied) {
					if (!isSameAcceptedOutput || paymentRequest.currentHydraUtxoValue == null) {
						await tx.paymentRequest.update({
							where: { id: paymentRequest.id },
							data: {
								currentHydraUtxoTxHash: outputReference.txHash,
								currentHydraUtxoOutputIndex: outputReference.outputIndex,
								currentHydraUtxoValue: outputValueJson,
								unresolvedHydraTerminalTxHash: null,
								unresolvedHydraTerminalReason: null,
							},
						});
					}
				} else {
					const observedTransactionId = await ensureObservedTransaction(tx, {
						hydraHeadId,
						txId,
						currentTransaction: paymentRequest.CurrentTransaction,
						previousState: paymentRequest.onChainState,
						newState: effectiveState,
					});
					const newAction = convertNewPaymentActionAndError(paymentRequest.NextAction.requestedAction, effectiveState);
					await tx.paymentRequest.update({
						where: { id: paymentRequest.id },
						data: {
							layer: TransactionLayer.L2,
							currentHydraUtxoTxHash: outputReference.txHash,
							currentHydraUtxoOutputIndex: outputReference.outputIndex,
							currentHydraUtxoValue: outputValueJson,
							unresolvedHydraTerminalTxHash: null,
							unresolvedHydraTerminalReason: null,
							onChainState: effectiveState,
							resultHash: decoded.resultHash,
							collateralReturnLovelace: decoded.collateralReturnLovelace,
							buyerCoolDownTime: decoded.buyerCooldownTime,
							sellerCoolDownTime: decoded.sellerCooldownTime,
							buyerReturnAddress: decoded.buyerReturnAddress ?? null,
							sellerReturnAddress: decoded.sellerReturnAddress ?? null,
							ActionHistory: { connect: { id: paymentRequest.nextActionId } },
							NextAction: {
								create: {
									requestedAction: newAction.action,
									errorNote: newAction.errorNote,
									errorType: newAction.errorType,
								},
							},
							BuyerWallet: {
								connectOrCreate: {
									where: {
										paymentSourceId_walletVkey_walletAddress_type: {
											paymentSourceId,
											walletVkey: decoded.buyerVkey,
											walletAddress: decoded.buyerAddress,
											type: WalletType.Buyer,
										},
									},
									create: {
										walletVkey: decoded.buyerVkey,
										walletAddress: decoded.buyerAddress,
										type: WalletType.Buyer,
										PaymentSource: { connect: { id: paymentSourceId } },
									},
								},
							},
							TransactionHistory:
								paymentRequest.currentTransactionId && paymentRequest.currentTransactionId !== observedTransactionId
									? { connect: { id: paymentRequest.currentTransactionId } }
									: undefined,
							CurrentTransaction: { connect: { id: observedTransactionId } },
						},
					});
					await releaseBlockedWallet(tx, paymentRequest.CurrentTransaction);
				}
				acceptedSides.push('payment');
			}
			applyOutcome = hasLegacyBackfillRetry ? 'retry' : 'applied';
		},
		{
			isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
			timeout: CONSTANTS.TRANSACTION_WAIT.SERIALIZABLE,
			maxWait: CONSTANTS.TRANSACTION_WAIT.SERIALIZABLE,
		},
	);

	if (acceptedSides.length === 0) {
		logger.warn('[HydraDatumSync] rejected unproven or mismatched datum observation', {
			hydraHeadId,
			blockchainIdentifier,
			txId,
		});
	}
	return applyOutcome;
}
