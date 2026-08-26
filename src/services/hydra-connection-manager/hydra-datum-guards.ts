/**
 * What an observed in-head datum is allowed to mean.
 *
 * Split from hydra-datum-sync when it passed the 750-line limit. Everything
 * here is a question, never an effect: is this observation ours, does its value
 * survive the collateral it must leave behind, does its lineage reach a state
 * we recorded, is the actor bound by the transaction body, is an initial lock
 * canonical. Nothing writes.
 *
 * A leaf: it depends on nothing else in the datum flow, which is what lets the
 * sync and terminal modules both import it without a cycle.
 */

import { OnChainState, Prisma, TransactionLayer, TransactionStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { checkPaymentAmountsMatch } from '@masumi/payment-core/payment-amounts';
import { type DecodedV1ContractDatum } from '@/utils/converter/string-datum-convert';
import { validateL2InitialLock } from '@/utils/logic/l2-datum-validation';
import {
	canonicalizeHydraAmounts,
	hydraAmountListCovers,
	hydraValidityLowerBoundTimeMs,
	hydraValidityUpperBoundTimeMs,
	type HydraAmount,
	type HydraTransactionEvidence,
} from './hydra-transaction-evidence';
import { resolveHydraL2EvidenceSlotConfig } from '@/utils/hydra/l2-slot-context';

export type HydraOutputReference = { txHash: string; outputIndex: number };
export type HydraDatumApplyOutcome = 'applied' | 'irrelevant' | 'retry';

/**
 * Resolve only duplicate identifiers that can affect this payment source's
 * local escrow rows. Anyone can fund a script address with arbitrary datum
 * bytes, so unrelated duplicate outputs must not retain the whole head's
 * ordered replay queue.
 */
export async function findLocallyRelevantHydraRequestIdentifiers(
	paymentSourceId: string,
	identifiers: Iterable<string>,
): Promise<Set<string>> {
	const uniqueIdentifiers = [...new Set(identifiers)];
	if (uniqueIdentifiers.length === 0) return new Set();
	const [paymentRequests, purchaseRequests] = await Promise.all([
		prisma.paymentRequest.findMany({
			where: { paymentSourceId, blockchainIdentifier: { in: uniqueIdentifiers } },
			select: { blockchainIdentifier: true },
		}),
		prisma.purchaseRequest.findMany({
			where: { paymentSourceId, blockchainIdentifier: { in: uniqueIdentifiers } },
			select: { blockchainIdentifier: true },
		}),
	]);
	return new Set([
		...paymentRequests.map(({ blockchainIdentifier }) => blockchainIdentifier),
		...purchaseRequests.map(({ blockchainIdentifier }) => blockchainIdentifier),
	]);
}

export function headParticipantsMatch(
	decoded: DecodedV1ContractDatum,
	_side: 'payment' | 'purchase',
	head: {
		HydraRelation: {
			LocalHotWallet: { walletVkey: string; walletAddress: string; paymentSourceId: string };
			RemoteWallet: { walletVkey: string; walletAddress: string; paymentSourceId: string };
		};
	},
	paymentSourceId: string,
): boolean {
	const local = head.HydraRelation.LocalHotWallet;
	const remote = head.HydraRelation.RemoteWallet;
	if (local.paymentSourceId !== paymentSourceId || remote.paymentSourceId !== paymentSourceId) return false;
	const localIsBuyer =
		decoded.buyerVkey === local.walletVkey &&
		decoded.buyerAddress === local.walletAddress &&
		decoded.sellerVkey === remote.walletVkey &&
		decoded.sellerAddress === remote.walletAddress;
	const localIsSeller =
		decoded.sellerVkey === local.walletVkey &&
		decoded.sellerAddress === local.walletAddress &&
		decoded.buyerVkey === remote.walletVkey &&
		decoded.buyerAddress === remote.walletAddress;
	return localIsBuyer || localIsSeller;
}

export function requestParticipantsMatch(
	side: 'payment' | 'purchase',
	request: {
		BuyerWallet?: { walletVkey: string; walletAddress: string } | null;
		SellerWallet?: { walletVkey: string; walletAddress: string } | null;
		SmartContractWallet: { walletVkey: string; walletAddress: string } | null;
	},
	head: {
		HydraRelation: {
			LocalHotWallet: { walletVkey: string; walletAddress: string; paymentSourceId: string };
			RemoteWallet: { walletVkey: string; walletAddress: string; paymentSourceId: string };
		};
	},
	paymentSourceId: string,
): boolean {
	const local = head.HydraRelation.LocalHotWallet;
	const remote = head.HydraRelation.RemoteWallet;
	if (local.paymentSourceId !== paymentSourceId || remote.paymentSourceId !== paymentSourceId) return false;
	const buyerWallet = side === 'payment' ? request.BuyerWallet : request.SmartContractWallet;
	const sellerWallet = side === 'payment' ? request.SmartContractWallet : request.SellerWallet;
	if (!buyerWallet || !sellerWallet) return false;
	const localIsBuyer =
		buyerWallet.walletVkey === local.walletVkey &&
		buyerWallet.walletAddress === local.walletAddress &&
		sellerWallet.walletVkey === remote.walletVkey &&
		sellerWallet.walletAddress === remote.walletAddress;
	const localIsSeller =
		sellerWallet.walletVkey === local.walletVkey &&
		sellerWallet.walletAddress === local.walletAddress &&
		buyerWallet.walletVkey === remote.walletVkey &&
		buyerWallet.walletAddress === remote.walletAddress;
	return localIsBuyer || localIsSeller;
}

export type PersistedEscrowState = {
	onChainState: OnChainState | null;
	resultHash: string | null;
	buyerCoolDownTime: bigint;
	sellerCoolDownTime: bigint;
	collateralReturnLovelace: bigint | null;
};

export const UNRESOLVED_DISPUTED_WITHDRAWAL_REASON = 'cip8_redeemer_not_snapshot_bound';

export function unresolvedDisputedWithdrawalNote(txId: string): string {
	return `Hydra disputed withdrawal ${txId} is confirmed, but its CIP-8 admin payload is not snapshot-bound. Automated actions are disabled; manual reconciliation is required.`;
}

export function canonicalExpectedFunds(expectedFunds: Array<{ unit: string; amount: bigint }>): HydraAmount[] | null {
	return canonicalizeHydraAmounts(
		expectedFunds.map(({ unit, amount }) => ({
			unit,
			quantity: amount.toString(),
		})),
	);
}

export function parsePersistedHydraValue(value: unknown): HydraAmount[] | null {
	if (!Array.isArray(value)) return null;
	const entries: unknown[] = value;
	const amounts: HydraAmount[] = [];
	for (const entry of entries) {
		if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) return null;
		if (!('unit' in entry) || !('quantity' in entry)) return null;
		const unit = entry.unit;
		const quantity = entry.quantity;
		if (typeof unit !== 'string' || typeof quantity !== 'string') return null;
		amounts.push({ unit, quantity });
	}
	const canonical = canonicalizeHydraAmounts(amounts);
	return canonical != null && canonical.length > 0 ? canonical : null;
}

export function persistedHydraValue(amounts: readonly HydraAmount[]): Prisma.InputJsonValue {
	return amounts.map(({ unit, quantity }) => ({ unit, quantity }));
}

export async function lockHydraMutationAdmission(tx: Prisma.TransactionClient, hydraHeadId: string): Promise<boolean> {
	const rows = await tx.$queryRaw<
		Array<{ isEnabled: boolean; initTxHash: string | null; reconciliationCompletedAt: Date | null }>
	>(Prisma.sql`
		SELECT "isEnabled", "initTxHash", "reconciliationCompletedAt"
		FROM "HydraHead"
		WHERE "id" = ${hydraHeadId}
		FOR SHARE
	`);
	const head = rows[0];
	return head?.isEnabled === true && head.initTxHash != null && head.reconciliationCompletedAt == null;
}

export function validateCanonicalInitialLock(
	decoded: DecodedV1ContractDatum,
	expectedFunds: Array<{ unit: string; amount: bigint }>,
	outputAmounts: readonly HydraAmount[],
	confirmationTimeMs: bigint | number | null,
) {
	const canonicalExpected = canonicalExpectedFunds(expectedFunds);
	const canonicalOutput = canonicalizeHydraAmounts(outputAmounts);
	if (!canonicalExpected || !canonicalOutput) {
		return { valid: false, errorNote: 'Hydra value contains an invalid asset quantity.' };
	}
	return validateL2InitialLock(
		decoded,
		canonicalExpected.map(({ unit, quantity }) => ({ unit, amount: BigInt(quantity) })),
		canonicalOutput,
		confirmationTimeMs,
	);
}

export function hasBodyBoundActor(evidence: HydraTransactionEvidence, actorVkey: string): boolean {
	return evidence.requiredSignerVkeys.includes(actorVkey) && evidence.signerVkeys.includes(actorVkey);
}

export function continuationValueIsSafe(
	expectedFunds: Array<{ unit: string; amount: bigint }>,
	inputAmounts: readonly HydraAmount[],
	outputAmounts: Array<{ unit: string; quantity: string }>,
	collateralReturnLovelace: bigint,
): boolean {
	const canonicalExpected = canonicalExpectedFunds(expectedFunds);
	const canonicalInput = canonicalizeHydraAmounts(inputAmounts);
	const canonicalOutput = canonicalizeHydraAmounts(outputAmounts);
	if (
		!canonicalExpected ||
		!canonicalInput ||
		!canonicalOutput ||
		!hydraAmountListCovers(canonicalOutput, canonicalInput)
	) {
		return false;
	}
	const isToken = (unit: string) => unit !== '' && unit.toLowerCase() !== 'lovelace';
	if (
		canonicalExpected.filter((amount) => isToken(amount.unit)).length !==
		canonicalOutput.filter((amount) => isToken(amount.unit)).length
	) {
		return false;
	}
	return checkPaymentAmountsMatch(
		canonicalExpected.map(({ unit, quantity }) => ({ unit, amount: BigInt(quantity) })),
		canonicalOutput.map((amount) => ({ ...amount })),
		collateralReturnLovelace,
	);
}

/**
 * Independently authorize a continuing V2 escrow transition. Hydra 2.3 signs
 * the resulting TxOut multiset, but not the endpoint's witness/redeemer bytes.
 * Infer the action from the persisted prior state and signed new output, then
 * require the corresponding actor to have both committed itself in the body
 * and produced a valid signature over that exact body hash.
 */
export function continuationHasAuthorizedActor(params: {
	request: PersistedEscrowState;
	decoded: DecodedV1ContractDatum;
	newState: OnChainState;
	expectedFunds: Array<{ unit: string; amount: bigint }>;
	inputAmounts: readonly HydraAmount[];
	outputAmounts: Array<{ unit: string; quantity: string }>;
	evidence: HydraTransactionEvidence;
	slotConfig: ReturnType<typeof resolveHydraL2EvidenceSlotConfig>;
	cooldownPeriodMs: number;
}): boolean {
	const {
		request,
		decoded,
		newState,
		expectedFunds,
		inputAmounts,
		outputAmounts,
		evidence,
		slotConfig,
		cooldownPeriodMs,
	} = params;
	const oldState = request.onChainState;
	const oldCollateral = request.collateralReturnLovelace;
	if (
		oldState == null ||
		oldState === OnChainState.FundsOrDatumInvalid ||
		oldCollateral == null ||
		oldCollateral !== decoded.collateralReturnLovelace ||
		!Number.isSafeInteger(cooldownPeriodMs) ||
		cooldownPeriodMs < 0 ||
		!continuationValueIsSafe(expectedFunds, inputAmounts, outputAmounts, oldCollateral)
	) {
		return false;
	}

	const lowerTime = hydraValidityLowerBoundTimeMs(evidence, slotConfig);
	const upperTime = hydraValidityUpperBoundTimeMs(evidence, slotConfig);
	// The validator globally requires a finite upper bound; every continuing
	// action also has a lower cooldown gate.
	if (lowerTime == null || upperTime == null || lowerTime > upperTime) return false;
	const startsAfter = (time: bigint) => lowerTime >= time;
	const endsBefore = (time: bigint) => upperTime < time;
	const cooldownFloor = upperTime + BigInt(cooldownPeriodMs);
	const resultIsUnchanged = decoded.resultHash === request.resultHash;

	const isSellerSubmitResult =
		hasBodyBoundActor(evidence, decoded.sellerVkey) &&
		decoded.resultHash != null &&
		startsAfter(request.sellerCoolDownTime) &&
		(endsBefore(decoded.resultTime) || (request.resultHash != null && endsBefore(decoded.externalDisputeUnlockTime))) &&
		decoded.sellerCooldownTime >= cooldownFloor &&
		decoded.buyerCooldownTime === 0n &&
		(((oldState === OnChainState.FundsLocked || oldState === OnChainState.ResultSubmitted) &&
			newState === OnChainState.ResultSubmitted) ||
			((oldState === OnChainState.RefundRequested || oldState === OnChainState.Disputed) &&
				newState === OnChainState.Disputed));

	const isBuyerRefundRequest =
		hasBodyBoundActor(evidence, decoded.buyerVkey) &&
		resultIsUnchanged &&
		startsAfter(request.buyerCoolDownTime) &&
		endsBefore(decoded.unlockTime) &&
		decoded.buyerCooldownTime >= cooldownFloor &&
		decoded.sellerCooldownTime === 0n &&
		((oldState === OnChainState.FundsLocked &&
			request.resultHash == null &&
			newState === OnChainState.RefundRequested) ||
			((oldState === OnChainState.ResultSubmitted || oldState === OnChainState.Disputed) &&
				request.resultHash != null &&
				newState === OnChainState.Disputed));

	const isBuyerWithdrawalAuthorization =
		oldState === OnChainState.Disputed &&
		newState === OnChainState.WithdrawAuthorized &&
		request.resultHash != null &&
		resultIsUnchanged &&
		hasBodyBoundActor(evidence, decoded.buyerVkey) &&
		startsAfter(request.buyerCoolDownTime) &&
		decoded.buyerCooldownTime >= cooldownFloor &&
		decoded.sellerCooldownTime === 0n;

	const isSellerRefundAuthorization =
		(oldState === OnChainState.FundsLocked ||
			oldState === OnChainState.ResultSubmitted ||
			oldState === OnChainState.RefundRequested ||
			oldState === OnChainState.Disputed) &&
		newState === OnChainState.RefundAuthorized &&
		decoded.resultHash == null &&
		hasBodyBoundActor(evidence, decoded.sellerVkey) &&
		startsAfter(request.sellerCoolDownTime) &&
		decoded.sellerCooldownTime >= cooldownFloor &&
		decoded.buyerCooldownTime === 0n;

	return isSellerSubmitResult || isBuyerRefundRequest || isBuyerWithdrawalAuthorization || isSellerRefundAuthorization;
}

export function observationHasValidLineage(params: {
	hydraHeadId: string;
	txId: string;
	observedState: OnChainState;
	currentState: OnChainState | null;
	requestLayer: TransactionLayer;
	currentHydraUtxoTxHash: string | null;
	currentHydraUtxoOutputIndex: number | null;
	observedOutputReference: HydraOutputReference;
	currentTransaction: {
		txHash: string | null;
		intendedTxHash: string | null;
		status: TransactionStatus;
		layer: TransactionLayer;
		hydraHeadId: string | null;
	} | null;
	transactionHistory: Array<{ txHash: string | null }>;
	transactionEvidence: HydraTransactionEvidence | null;
	initialLockSignerVkey: string;
}): boolean {
	const {
		hydraHeadId,
		txId,
		observedState,
		currentState,
		requestLayer,
		currentHydraUtxoTxHash,
		currentHydraUtxoOutputIndex,
		observedOutputReference,
		currentTransaction,
		transactionHistory,
		transactionEvidence,
		initialLockSignerVkey,
	} = params;

	if (transactionHistory.some((history) => history.txHash === txId)) return false;
	const isSameAcceptedOutput =
		currentHydraUtxoTxHash === observedOutputReference.txHash &&
		currentHydraUtxoOutputIndex === observedOutputReference.outputIndex;

	// Initial locks create the script output without running a validator. Their
	// trust boundary is the full terms/amount/participant validation below plus
	// a real buyer payment-key witness on the creating transaction.
	if (observedState === OnChainState.FundsLocked && currentState == null) {
		const hasBuyerWitness = transactionEvidence?.signerVkeys.includes(initialLockSignerVkey) === true;
		return (
			hasBuyerWitness &&
			(currentTransaction == null ||
				((currentTransaction.txHash === txId || currentTransaction.intendedTxHash === txId) &&
					currentTransaction.layer === TransactionLayer.L2 &&
					currentTransaction.hydraHeadId === hydraHeadId))
		);
	}

	// A TxValid response can be followed by a DB failure before txHash is copied
	// from the pre-submit reservation. Permit that one exact pending intended hash;
	// the caller already bound evidence.txHash/output to txId, and the continuation
	// check below still requires the CBOR body to consume the persisted escrow UTxO.
	const hasExactIntendedPendingReservation =
		currentTransaction?.status === TransactionStatus.Pending &&
		currentTransaction.txHash == null &&
		currentTransaction.intendedTxHash === txId;
	if (
		requestLayer !== TransactionLayer.L2 ||
		currentTransaction?.layer !== TransactionLayer.L2 ||
		currentTransaction.hydraHeadId !== hydraHeadId ||
		(currentTransaction.txHash == null && !hasExactIntendedPendingReservation)
	) {
		return false;
	}

	// Invalid economic lineage stays parked for manual recovery. Re-reading its
	// same immutable output is harmless, but no later transition clears the taint.
	if (currentState === OnChainState.FundsOrDatumInvalid) return isSameAcceptedOutput;

	// A Cardano output is immutable. Re-observing the exact same reference may
	// only confirm the state already attached to it; any state change needs a new
	// CBOR-backed output whose transaction consumes the previous reference.
	if (isSameAcceptedOutput) return observedState === currentState;

	// A non-initial legacy row without an exact prior output cannot prove which
	// state/value was consumed. Keep it parked for explicit recovery.
	if (currentHydraUtxoTxHash == null || currentHydraUtxoOutputIndex == null || !transactionEvidence) return false;
	return transactionEvidence.inputs.some(
		(input) => input.txHash === currentHydraUtxoTxHash && input.outputIndex === currentHydraUtxoOutputIndex,
	);
}

export function isLegacyPendingLineageCandidate(params: {
	hydraHeadId: string;
	txId: string;
	requestLayer: TransactionLayer;
	currentTransaction: {
		txHash: string | null;
		intendedTxHash: string | null;
		status: TransactionStatus;
		layer: TransactionLayer;
		hydraHeadId: string | null;
	} | null;
	transactionHistory: Array<{ txHash: string | null }>;
}): boolean {
	const { hydraHeadId, txId, requestLayer, currentTransaction, transactionHistory } = params;
	return (
		requestLayer === TransactionLayer.L2 &&
		currentTransaction?.status === TransactionStatus.Pending &&
		currentTransaction.layer === TransactionLayer.L2 &&
		currentTransaction.hydraHeadId === hydraHeadId &&
		currentTransaction.txHash !== txId &&
		currentTransaction.intendedTxHash !== txId &&
		transactionHistory.some((history) => history.txHash === txId)
	);
}

export function canAdvanceLegacyHydraReference(params: {
	currentHydraUtxoTxHash: string | null;
	currentHydraUtxoOutputIndex: number | null;
	newOnChainState: OnChainState;
	decoded: DecodedV1ContractDatum;
	expectedFunds: Array<{ unit: string; amount: bigint }>;
	outputAmounts: Array<{ unit: string; quantity: string }>;
	transactionEvidence: HydraTransactionEvidence | null;
	confirmationTimeMs: number | null;
	signedValidityUpperBoundTimeMs: bigint | null;
}): boolean {
	const {
		currentHydraUtxoTxHash,
		currentHydraUtxoOutputIndex,
		newOnChainState,
		decoded,
		expectedFunds,
		outputAmounts,
		transactionEvidence,
		confirmationTimeMs,
		signedValidityUpperBoundTimeMs,
	} = params;
	if (currentHydraUtxoTxHash == null && currentHydraUtxoOutputIndex == null) {
		return (
			newOnChainState === OnChainState.FundsLocked &&
			confirmationTimeMs != null &&
			signedValidityUpperBoundTimeMs != null &&
			signedValidityUpperBoundTimeMs <= BigInt(decoded.payByTime) &&
			transactionEvidence?.signerVkeys.includes(decoded.buyerVkey) === true &&
			validateCanonicalInitialLock(decoded, expectedFunds, outputAmounts, confirmationTimeMs).valid
		);
	}
	// The persisted row reflects the result of this historical transition, not
	// its prior datum/cooldowns/value. Input lineage alone cannot reconstruct the
	// authorization proof, so advancing it would bypass the normal state machine.
	return false;
}

export function resolveInitialLockState(
	newOnChainState: OnChainState,
	currentState: OnChainState | null,
	isSameAcceptedOutput: boolean,
	decoded: DecodedV1ContractDatum,
	expectedFunds: Array<{ unit: string; amount: bigint }>,
	outputAmounts: Array<{ unit: string; quantity: string }>,
	confirmationTimeMs: number | null,
	signedValidityUpperBoundTimeMs: bigint | null,
	logContext: { hydraHeadId: string; blockchainIdentifier: string; side: 'payment' | 'purchase' },
): OnChainState | null {
	if (newOnChainState !== OnChainState.FundsLocked) return newOnChainState;
	// The creation-time checks were already applied when this exact live output
	// first became current. A later snapshot (especially after restart) does not
	// carry historical confirmation time; revalidating would turn a valid lock
	// into FundsOrDatumInvalid. Preserve both valid and previously-invalid results.
	if (currentState != null && isSameAcceptedOutput) return currentState;
	// Hydra's API timestamp is transport metadata rather than part of the signed
	// transaction body. It may help accept a lock from an authenticated node, but
	// it must never irreversibly poison a request as "late". Missing, malformed,
	// or after-deadline time remains quarantined/retryable for operator recovery.
	if (
		confirmationTimeMs == null ||
		!Number.isSafeInteger(confirmationTimeMs) ||
		BigInt(confirmationTimeMs) > BigInt(decoded.payByTime)
	) {
		return null;
	}
	// SnapshotConfirmed timestamps are API metadata. A forged early timestamp
	// cannot authorize a late/unbounded initial lock: the immutable signed body
	// must independently end no later than the datum's payByTime.
	if (signedValidityUpperBoundTimeMs == null || signedValidityUpperBoundTimeMs > BigInt(decoded.payByTime)) {
		logger.warn('[HydraDatumSync] initial lock lacks a safe signed validity upper bound', {
			...logContext,
			signedValidityUpperBoundTimeMs: signedValidityUpperBoundTimeMs?.toString() ?? null,
			payByTime: decoded.payByTime.toString(),
		});
		return null;
	}
	const check = validateCanonicalInitialLock(decoded, expectedFunds, outputAmounts, confirmationTimeMs);
	if (check.valid) return OnChainState.FundsLocked;
	logger.warn('[HydraDatumSync] in-head initial lock failed validation -> FundsOrDatumInvalid', {
		...logContext,
		errorNote: check.errorNote,
	});
	return OnChainState.FundsOrDatumInvalid;
}
